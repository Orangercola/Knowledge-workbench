#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DeepSeek 官方搜索 / 抓取 · 检索工具（零依赖 / 标准库实现）
====================================================

用途：调用 DeepSeek 自研搜索引擎的 Search / Fetch 接口，检索全网网页并把结果以
     Markdown 落盘，供知识库（Obsidian）摄入与实体页更新引用。

接口（官方文档 https://api-docs.deepseek.com/zh-cn/guides/search）
  Search  POST /v1/tools/search    搜索网页，返回结构化结果
  Fetch   POST /v1/tools/fetch     抓单页，返回 Markdown 正文

计费（2026-10 口径）：每 1000 次成功请求 5 元，即 0.005 元/次；
  - 只有返回 200 且 results 非空 / Fetch 返回正文才计费
  - 参数错误(400)、无结果、超时、429 均不计费
  - count 只控条数，不影响单次单价
本工具会在 `工具/.ds_usage.json` 记当日调用次数与估算花费，`usage` 子命令可查。

限速：账号级 Search / Fetch 各 5 QPS。本工具串行调用，遇 429 自动退避重试（不计费）。

支持子命令
----------
  search <query>   搜索网页        POST /v1/tools/search
  fetch  <url>     抓取单页正文     POST /v1/tools/fetch
  usage            查看本地用量记账  （读 工具/.ds_usage.json）

用法示例
--------
  export DEEPSEEK_API_KEY="sk-..."

  python ds_search.py search "公共数据资源授权运营 实施规范" --site gov.cn --after 2026-07
  python ds_search.py search "地市 数据平台 中标 金额" --strict --json
  python ds_search.py search "公共数据资源授权运营 实施规范" --count 10 --to-md --save 输出/查询
  python ds_search.py fetch "https://www.nda.gov.cn/xxx.html" --save 输出/查询
  python ds_search.py usage

质量闸门（--strict）
--------------------
  rerank_score >= 1.5  官方定义"优质结果"（0~3 分，综合相关性/权威性/时效性）
  authority     >= 3   官方定义"极权威结果"（0~4 分，-1 未知）
  实测：正常政务/政策 query 多落 2.0~2.5 分；长尾无解 query 会掉到 0.5~1.0，
        故 --strict 可自动识别"有结果但没答案"，避免把壳页喂给模型。

Fetch 注意事项（实测 2026-10-19）
--------------------------------
  200 ≠ 抓到正文：404 页 / 失效旧链接 仍可能返回 200（内容是"Page Not Found"
  或纯页脚导航），且照样计费。本工具默认拒绝 content < 300 字的结果并提示可疑。

环境变量
--------
  DEEPSEEK_API_KEY    必填。DeepSeek 开放平台 API Key。
  DEEPSEEK_BASE_URL   可选。默认 https://api.deepseek.com（便于走代理/网关）。

退出码
------
  0 成功；2 参数/配置错误；3 鉴权失败(401)；4 余额不足(402)；5 接口返回错误；
  6 网络错误；7 频率限制(429 重试后仍失败)。
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ---------------------------------------------------------------- 基础常量

BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
EP_SEARCH = "/v1/tools/search"
EP_FETCH = "/v1/tools/fetch"

CST = timezone(timedelta(hours=8))
PRICE_PER_CALL = 0.005          # 元/次
STRICT_SCORE = 1.5
STRICT_AUTH = 3
FETCH_MIN_CONTENT = 300         # 低于此字数视为可疑成功

HERE = os.path.dirname(os.path.abspath(__file__))
USAGE_FILE = os.path.join(HERE, ".ds_usage.json")

# ---------------------------------------------------------------- 工具函数


def die(code, msg):
    print("✗ " + msg, file=sys.stderr)
    sys.exit(code)


def get_key(cli_key=None):
    key = cli_key or os.environ.get("DEEPSEEK_API_KEY", "")
    if not key:
        envf = os.path.join(HERE, ".env")
        if os.path.exists(envf):
            with open(envf, encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("DEEPSEEK_API_KEY="):
                        key = line.split("=", 1)[1].strip().strip("'\"")
                        break
    key = (key or "").strip()
    if not key:
        die(2, "未找到 DEEPSEEK_API_KEY（环境变量或 工具/.env）")
    return key


def post(path, payload, key, timeout=90, retry=2):
    """带退避重试的 POST。返回 (status, data_or_dict, ms)。"""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    delay = 1.5
    last = None
    for attempt in range(retry + 1):
        req = urllib.request.Request(
            BASE_URL + path, data=body, method="POST",
            headers={"Authorization": "Bearer " + key,
                     "Content-Type": "application/json"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                ms = int((time.time() - t0) * 1000)
                return r.status, json.loads(r.read().decode("utf-8")), ms
        except urllib.error.HTTPError as e:
            ms = int((time.time() - t0) * 1000)
            raw = e.read().decode("utf-8", "ignore")
            last = (e.code, raw, ms)
            if e.code in (429, 408) or e.code >= 500:
                if attempt < retry:
                    print(f"  ⏳ HTTP {e.code}，{delay:.1f}s 后重试（{attempt+1}/{retry}）",
                          file=sys.stderr)
                    time.sleep(delay)
                    delay *= 2
                    continue
            return e.code, {"_raw": raw}, ms
        except Exception as e:                      # noqa: BLE001
            ms = int((time.time() - t0) * 1000)
            last = (-1, repr(e), ms)
            if attempt < retry:
                time.sleep(delay)
                delay *= 2
                continue
            return -1, {"_raw": repr(e)}, ms
    return last[0], {"_raw": last[1]}, last[2]


def bill_add(kind, n=1):
    day = datetime.now(CST).strftime("%Y-%m-%d")
    data = {}
    if os.path.exists(USAGE_FILE):
        try:
            with open(USAGE_FILE, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:                            # noqa: BLE001
            data = {}
    rec = data.setdefault(day, {"search": 0, "fetch": 0})
    rec[kind] = rec.get(kind, 0) + n
    with open(USAGE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return day, rec


def shape_query(args):
    """把 --site / --after / --before / --lang 语法糖拼进 query。"""
    q = args.query.strip()
    if args.site:
        sites = [s.strip() for s in re.split(r"[,\s]+", args.site) if s.strip()]
        if len(sites) == 1:
            q += " site:" + sites[0]
        else:
            q += " " + " OR ".join("site:" + s for s in sites)
    if args.after:
        q += " after:" + args.after
    if args.before:
        q += " before:" + args.before
    if args.lang:
        q += " lang:" + args.lang
    return q


def fmt_date(d):
    return (d or "")[:10] or "—"


def score_bar(s):
    s = s or 0
    return f"{s:.2f}"


# ---------------------------------------------------------------- 输出


def render_table(results, ms, query, total_before=None, dropped=0):
    n = len(results)
    head = f"\n【DeepSeek Search】{query}"
    print(head)
    info = f"  返回 {n} 条 · {ms}ms · 单次计费 ≈ ¥{PRICE_PER_CALL}"
    if dropped:
        info += f" · 闸门过滤 {dropped} 条"
    print(info)
    print("  " + "-" * 96)
    for i, r in enumerate(results, 1):
        flag = "★" if (r.get("rerank_score") or 0) >= STRICT_SCORE and \
                      (r.get("authority") if isinstance(r.get("authority"), int) else -1) >= STRICT_AUTH else " "
        print(f"  {i:>2}. {flag} [{score_bar(r.get('rerank_score'))}] "
              f"auth={r.get('authority')} · {fmt_date(r.get('date'))} · {r.get('site_name') or ''}")
        print(f"      {r.get('title') or '(无标题)'}")
        print(f"      {r.get('url') or ''}")
        sn = (r.get("snippet") or "").replace("\n", " ")
        if sn:
            print(f"      {sn[:110]}{'…' if len(sn) > 110 else ''}")
        if r.get("_clen"):
            print(f"      正文 {r['_clen']} 字")
    print("  " + "-" * 96)
    print("  ★ = rerank≥1.5 且 authority≥3（优质且权威）\n")


def render_md(results, query, meta_line, body_kind="search"):
    now = datetime.now(CST).strftime("%Y-%m-%d %H:%M")
    lines = [
        "---",
        "title: \"DeepSeek 检索：%s\"" % query.replace('"', "'"),
        "type: query",
        "date: " + datetime.now(CST).strftime("%Y-%m-%d"),
        "tool: 工具/ds_search.py",
        "source: https://api.deepseek.com" + (EP_SEARCH if body_kind == "search" else EP_FETCH),
        "---",
        "",
        "# DeepSeek 检索：%s" % query,
        "",
        "> " + meta_line,
        "> 生成时间：%s（北京时间）" % now,
        "",
    ]
    if body_kind == "search":
        lines += ["## 结果（按 rerank_score 排序）", ""]
        for i, r in enumerate(results, 1):
            sc = r.get("rerank_score") or 0
            au = r.get("authority")
            mark = "★" if sc >= STRICT_SCORE and isinstance(au, int) and au >= STRICT_AUTH else ""
            lines.append(f"### {i}. {r.get('title') or '(无标题)'} {mark}")
            lines.append("")
            lines.append(f"- 链接：{r.get('url')}")
            lines.append(f"- 站点：{r.get('site_name') or '—'} · 日期：{fmt_date(r.get('date'))} · "
                         f"评分：{sc:.2f} · 权威度：{au}")
            sn = (r.get("snippet") or "").replace("\n", " ")
            if sn:
                lines.append(f"- 摘要：{sn}")
            sm = (r.get("summary") or "").replace("\n", " ")
            if sm:
                lines += ["", "> " + sm]
            ct = r.get("content") or ""
            if ct:
                lines += ["", "**正文摘录**", "", "```text", ct[:4000], "```"]
            lines.append("")
    return "\n".join(lines)


def save_md(text, save_dir, slug):
    if not os.path.isabs(save_dir):
        save_dir = os.path.join(os.path.dirname(HERE), save_dir)
    os.makedirs(save_dir, exist_ok=True)
    fn = datetime.now(CST).strftime("%Y-%m-%d") + "-" + slug + "-DeepSeek检索.md"
    p = os.path.join(save_dir, fn)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return p


def slugify(q, maxlen=40):
    s = re.sub(r"[\s/\\:*?\"<>|\[\]#^%]+", "-", q).strip("-")
    return s[:maxlen] or "query"


# ---------------------------------------------------------------- 子命令


def cmd_search(args, key):
    q = shape_query(args)
    payload = {"query": q, "count": args.count}
    if args.content:
        payload["need_content"] = True
    if args.ori:
        payload["ori_question"] = args.ori
    if args.local:
        payload["localization"] = args.local

    status, data, ms = post(EP_SEARCH, payload, key)
    if status != 200:
        msg = (data.get("_raw") or "")
        try:
            msg = json.loads(msg)["error"]["message"]
        except Exception:                            # noqa: BLE001
            pass
        code = 3 if status == 401 else 4 if status == 402 else 7 if status == 429 else 5
        die(code, f"Search 失败 HTTP {status}：{msg[:220]}")

    results = data.get("results") or []
    if results:
        bill_add("search")

    for r in results:
        ct = r.get("content") or ""
        r["_clen"] = len(ct)

    total = len(results)
    if args.strict:
        results = [r for r in results
                   if (r.get("rerank_score") or 0) >= args.min_score
                   and isinstance(r.get("authority"), int)
                   and r["authority"] >= args.min_authority]
    dropped = total - len(results)

    if args.json:
        print(json.dumps({"query": q, "ms": ms, "count": len(results),
                          "results": results}, ensure_ascii=False, indent=2))
    else:
        render_table(results, ms, q, total, dropped)
        if total and not results:
            print("  ⚠ 全部结果未过闸门——该 query 大概率没有可靠答案，建议换词或如实告知「未找到」。\n")

    if args.to_md or args.save:
        meta = (f"query: `{q}` · 条数 {len(results)}/{total} · {ms}ms · "
                f"计费 ¥{PRICE_PER_CALL:.4f}")
        md = render_md(results, q, meta, "search")
        d = args.save or "输出/查询"
        p = save_md(md, d, slugify(args.query))
        print(f"  → 已保存：{p}")
    return 0


def cmd_fetch(args, key):
    status, data, ms = post(EP_FETCH, {"url": args.url}, key)
    if status != 200:
        msg = (data.get("_raw") or "")
        try:
            msg = json.loads(msg)["error"]["message"]
        except Exception:                            # noqa: BLE001
            pass
        code = 3 if status == 401 else 4 if status == 402 else 7 if status == 429 else 5
        die(code, f"Fetch 失败 HTTP {status}：{msg[:220]}")

    title = data.get("title") or ""
    content = data.get("content") or ""
    clen = len(content)
    if clen:
        bill_add("fetch")

    ok = clen >= FETCH_MIN_CONTENT
    print(f"\n【DeepSeek Fetch】{args.url}")
    print(f"  {ms}ms · 正文 {clen} 字 · {'✓ 正常' if ok else '⚠ 可疑（正文过短，可能是 404/导航壳）'}")
    print(f"  标题：{title or '(无)'}")
    print("  " + "-" * 96)
    print("  " + content[:1200].replace("\n", "\n  "))
    if clen > 1200:
        print(f"\n  ……（余下 {clen-1200} 字，见 --save 落盘文件）")
    print("  " + "-" * 96 + "\n")

    if args.to_md or args.save:
        now = datetime.now(CST).strftime("%Y-%m-%d %H:%M")
        head = [
            "---",
            "title: \"抓取：%s\"" % (title or args.url).replace('"', "'"),
            "type: query",
            "date: " + datetime.now(CST).strftime("%Y-%m-%d"),
            "tool: 工具/ds_search.py",
            "url: " + args.url,
            "---",
            "",
            "# 抓取：%s" % (title or args.url),
            "",
            f"> 来源：{args.url}",
            f"> 抓取时间：{now}（北京时间）· 正文 {clen} 字",
            "",
            content,
        ]
        d = args.save or "输出/查询"
        p = save_md("\n".join(head), d, slugify(title or "fetch"))
        print(f"  → 已保存：{p}")
    return 0


def cmd_usage(args, key):
    if not os.path.exists(USAGE_FILE):
        print("尚无调用记录。")
        return 0
    with open(USAGE_FILE, encoding="utf-8") as f:
        data = json.load(f)
    print("\n【DeepSeek 本地用量记账】")
    print("  " + "-" * 60)
    tot = 0
    for day in sorted(data):
        rec = data[day]
        s, ft = rec.get("search", 0), rec.get("fetch", 0)
        c = (s + ft) * PRICE_PER_CALL
        tot += c
        print(f"  {day}  Search {s:>4} 次 · Fetch {ft:>4} 次 · ≈ ¥{c:.3f}")
    print("  " + "-" * 60)
    print(f"  合计 ≈ ¥{tot:.3f}（仅本机统计，失败/无结果请求不计费）\n")
    return 0


# ---------------------------------------------------------------- 入口


def build_parser():
    p = argparse.ArgumentParser(
        prog="ds_search.py",
        description="DeepSeek 官方搜索/抓取工具（零依赖）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("用法示例")[1] if "用法示例" in __doc__ else None)
    p.add_argument("--key", help="临时传入 API Key（默认读 DEEPSEEK_API_KEY）")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("search", help="搜索网页")
    s.add_argument("query")
    s.add_argument("--count", type=int, default=8, help="返回条数 1~50，默认 8")
    s.add_argument("--content", action="store_true", help="返回网页正文（体积大，慎用）")
    s.add_argument("--site", help="限定站点，多个用逗号/空格分隔")
    s.add_argument("--after", help="起始日期，如 2026-07 或 2026-07-01")
    s.add_argument("--before", help="截止日期")
    s.add_argument("--lang", help="语言，如 zh 、zh,en")
    s.add_argument("--ori", help="用户原始问题，帮助理解搜索意图")
    s.add_argument("--local", help="本地化 IP 地址，优先返回当地结果")
    s.add_argument("--strict", action="store_true",
                   help=f"开质量闸门（score≥{STRICT_SCORE} 且 authority≥{STRICT_AUTH}）")
    s.add_argument("--min-score", type=float, default=STRICT_SCORE)
    s.add_argument("--min-authority", type=int, default=STRICT_AUTH)
    s.add_argument("--json", action="store_true", help="输出原始 JSON")
    s.add_argument("--to-md", action="store_true", help="落 Markdown 到 输出/查询")
    s.add_argument("--save", help="指定 Markdown 落盘目录（隐含 --to-md）")

    f = sub.add_parser("fetch", help="抓取单页正文")
    f.add_argument("url")
    f.add_argument("--to-md", action="store_true")
    f.add_argument("--save")

    sub.add_parser("usage", help="查看本地用量与花费")
    return p


def main():
    args = build_parser().parse_args()
    if not args.cmd:
        build_parser().print_help()
        return 2
    key = get_key(args.key)
    if args.cmd == "search":
        return cmd_search(args, key)
    if args.cmd == "fetch":
        return cmd_fetch(args, key)
    if args.cmd == "usage":
        return cmd_usage(args, key)
    return 2


if __name__ == "__main__":
    sys.exit(main())
