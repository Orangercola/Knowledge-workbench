#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
知乎热榜 · 高赞回答精选（热榜 → 逐条抽取该问题下的高赞回答）
================================================================

用途：拿知乎热榜，再对榜单里每个问题做一次站内检索，筛出「同一个问题下」
     按赞同数排序的回答，形成"热榜 + 高赞观点"的候选素材，供每日热点日报
     做简要精选描述。

为什么这么做：热榜接口（hot_list）只返回问题标题与一句摘要（有时仅"[图片]"），
     不含回答正文；而站内搜索接口（zhihu_search）返回回答正文、赞同数、作者
     与回答链接，且回答 Url 里带 question id，可与热榜条目的 question id 严格
     对齐，因此能稳定还原"该问题下的高赞回答"。

额度：每条热榜问题消耗 1 次站内搜索（默认 12 条 → 12 次/日）。
     站内搜索日额度 5000，占比 < 1%。

用法
----
  python zhihu_hot_digest.py                        # 热榜 12 条，每问题取前 2 条高赞回答
  python zhihu_hot_digest.py --limit 15 --top 3      # 热榜 15 条，每问题取前 3 条
  python zhihu_hot_digest.py --json                  # 结构化 JSON（供程序/日报生成消费）
  python zhihu_hot_digest.py --full                  # 回答正文不截断
  python zhihu_hot_digest.py --save 原始素材/热点     # 落盘 Markdown

约定：Secret 复用 zhihu_search.py 的读取链（--secret > 环境变量 > .env）。
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import zhihu_search as zh  # noqa: E402  复用鉴权 / 请求 / 额度 / 清洗逻辑

CST = zh.CST
NOISE_SUMMARY = {"[图片]", "", "[视频]", "[图片][视频]"}


def qid_of(url):
    """从知乎链接中取 question id；取不到返回空串。"""
    m = re.search(r"/question/(\d+)", url or "")
    return m.group(1) if m else ""


def usable_summary(s):
    """热榜摘要常是 '[图片]' 这类无信息占位，过滤掉。"""
    t = zh.clean_text(s or "")
    return t if t and t not in NOISE_SUMMARY and len(t) > 6 else ""


def trim_text(s, chars):
    """按字符数截断（中文按字计），保留整句边界感。"""
    t = (s or "").strip()
    if chars <= 0 or len(t) <= chars:
        return t
    return t[:chars].rstrip() + "…"


def first_sentence(s, limit=120):
    """取回答的前两句作为兜底描述（无 LLM 时的降级方案）。"""
    t = re.sub(r"\s+", " ", (s or "").strip())
    if not t:
        return ""
    parts = re.split(r"(?<=[。！？!?])", t)
    cut, buf = "", ""
    for p in parts:
        if not p.strip():
            continue
        if len(buf) + len(p) > limit and buf:
            break
        buf += p
        if len(buf) >= limit * 0.6:
            break
    cut = buf or t[:limit]
    return cut.strip()


def fetch_hot_answers(secret, limit, top, chars, sleep=0.3):
    """热榜 limit 条，每条抽该问题下赞同最高的 top 条回答。"""
    hot = zh.api_get(zh.EP_HOT_LIST, {"Limit": limit}, secret)
    zh.record_usage("hot_list")
    rows = ((hot.get("Data") or {}).get("Items") or [])

    out = []
    for i, it in enumerate(rows, 1):
        title = it.get("Title", "")
        url = it.get("Url", "")
        q = qid_of(url)
        rec = {
            "rank": i,
            "title": title,
            "url": url,
            "qid": q,
            "hot_summary": usable_summary(it.get("Summary")),
            "answers": [],
        }
        if q:
            try:
                payload = zh.api_get(zh.EP_ZHIHU_SEARCH,
                                     {"Query": title, "Count": 10}, secret)
                zh.record_usage("zhihu_search")
            except SystemExit as e:  # 额度/风控/网络问题不阻断整批
                zh.log("[跳过] 第 %d 条检索失败（exit %s）：%s" % (i, e.code, title[:24]))
                payload = {}
            items = ((payload.get("Data") or {}).get("Items") or [])
            # 只保留"同一个问题下"的回答，确保还原的是本问题的热门回答
            same = [r for r in items
                    if qid_of(r.get("Url")) == q and r.get("ContentType") == "Answer"]
            same.sort(key=lambda r: r.get("VoteUpCount") or 0, reverse=True)
            for k, a in enumerate(same[:top], 1):
                body = zh.clean_text(a.get("ContentText", ""))
                rec["answers"].append({
                    "rank": k,
                    "author": a.get("AuthorName", ""),
                    "badge": a.get("AuthorBadgeText", ""),
                    "voteup": a.get("VoteUpCount"),
                    "comments": a.get("CommentCount"),
                    "url": a.get("Url", ""),
                    "brief": first_sentence(body),
                    "text": trim_text(body, chars),
                    "text_full": body,
                })
            time.sleep(sleep)  # 轻微限速，避免触发风控
        out.append(rec)
    return out


def render_md(items, meta):
    lines = [
        "---",
        "title: 知乎热榜·高赞回答精选（%s）" % meta["date"],
        "type: page",
        "date: %s" % meta["date"],
        "source: developer.zhihu.com（知乎开放平台·热榜 + 站内搜索）",
        "tags: [知乎检索, 热榜, 高赞回答]",
        "---", "",
        "# 知乎热榜 · 高赞回答精选（%s）" % meta["date"], "",
        "> 热榜 Top %d，逐条附该问题下的回答要点（按赞同数排序选取，展示时不标赞同数——赞同数只反映热度，不代表观点分布）。引用请回原文核对。"
        % meta["hot_limit"], "",
        "- 生成时间：%s（北京时间）" % meta["generated_at"],
        "- 覆盖：%d 个问题，命中回答 %d 条" % (len(items), meta["answer_count"]),
        "- 数据源：知乎开放平台 hot_list + zhihu_search", "",
    ]
    for it in items:
        lines.append("## %d. [%s](%s)" % (it["rank"], it["title"], it["url"]))
        lines.append("")
        if it["hot_summary"]:
            lines.append("`热榜摘要` %s" % it["hot_summary"])
            lines.append("")
        if not it["answers"]:
            lines.append("- 💡 未检索到该问题下的回答（可能是新问题或检索未覆盖）。")
            lines.append("")
            continue
        segs = []
        for a in it["answers"]:
            who = a["author"] or "匿名"
            if a["badge"] and len(a["badge"]) <= 12:
                who += "（%s）" % a["badge"]
            seg = a["brief"] or "（要点见下方原文摘录）"
            if a["url"]:
                seg += "（回答人 %s · [原文](%s)）" % (who, a["url"])
            else:
                seg += "（回答人 %s）" % who
            segs.append(seg)
        lines.append("- 💡 %s" % "；".join(segs))
        lines.append("")
        if any(a.get("text") for a in it["answers"]):
            lines.append("- 📄 原文摘录：")
            for a in it["answers"]:
                if not a.get("text"):
                    continue
                who = a["author"] or "匿名"
                if a["badge"] and len(a["badge"]) <= 12:
                    who += "（%s）" % a["badge"]
                lines.append("")
                lines.append("  > **%s**：%s" % (who, a["text"].replace("\n", "\n  > ")))
        lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("> 免责声明：本文件由程序自动抓取整理，仅作素材候选，观点归原作者所有。")
    return "\n".join(lines) + "\n"


def build_parser():
    ap = argparse.ArgumentParser(
        prog="zhihu_hot_digest.py",
        description="知乎热榜 → 逐条抽取该问题下高赞回答（复用 zhihu_search.py 的鉴权）。",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--secret", help="临时传入 Access Secret（优先用环境变量 / .env）")
    ap.add_argument("--limit", type=int, default=12, help="热榜条数，默认 12，最大 30")
    ap.add_argument("--top", type=int, default=2, help="每个问题取前 N 条高赞回答，默认 2")
    ap.add_argument("--chars", type=int, default=500, help="回答正文截断字数，默认 500，0=不截断")
    ap.add_argument("--json", action="store_true", help="输出结构化 JSON")
    ap.add_argument("--full", action="store_true", help="回答正文不截断（等价 --chars 0）")
    ap.add_argument("--save", metavar="DIR", help="将结果保存到目录（Markdown；加 --json 则存 .json）")
    return ap


def main():
    zh._reconfigure_stdio()
    args = build_parser().parse_args()

    class _A:
        secret = args.secret
    secret = zh.get_secret(_A)

    limit = max(1, min(args.limit, 30))
    chars = 0 if args.full else args.chars
    now = datetime.now(CST)

    items = fetch_hot_answers(secret, limit, max(1, args.top), chars)
    answer_count = sum(len(it["answers"]) for it in items)
    meta = {"date": now.strftime("%Y-%m-%d"),
            "generated_at": now.strftime("%Y-%m-%d %H:%M"),
            "hot_limit": limit,
            "answer_count": answer_count}

    if args.json:
        payload = {"meta": meta, "items": items}
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        print(text)
        if args.save:
            p = os.path.join(args.save, "%s-知乎热榜精选.json" % meta["date"])
            os.makedirs(args.save, exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)
            zh.log("[已保存] %s" % os.path.abspath(p))
        return

    md = render_md(items, meta)
    print(md)
    if args.save:
        p = os.path.join(args.save, "%s-知乎热榜精选.md" % meta["date"])
        os.makedirs(args.save, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(md)
        zh.log("[已保存] %s" % os.path.abspath(p))


if __name__ == "__main__":
    main()
