#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
知乎开放平台 · 检索工具（零依赖 / 标准库实现）
====================================================

用途：调用知乎开放平台（developer.zhihu.com）的内容接口，检索知乎站内与全网内容，
     结果可直接以 Markdown 落盘，供知识库（Obsidian）后续引用 / 摄入。

接入方式：Bearer 鉴权（Access Secret 放在请求头 Authorization）。
          Secret 只从环境变量 ZHIHU_ACCESS_SECRET 读取（或 --secret 临时传入），
          本工具不写入任何文件、不打印、不记录。

支持的子命令
------------
  search <关键词>   知乎站内搜索        GET /api/v1/content/zhihu_search
  web    <关键词>   全网搜索            GET /api/v1/content/global_search
  hot                知乎热榜            GET /api/v1/content/hot_list
  ask   <问题>       知乎直答（可选）     POST /v1/chat/completions
  quota              查询当日免费额度     GET /api/v1/quota

用法示例
--------
  export ZHIHU_ACCESS_SECRET="你的Access Secret"

  python zhihu_search.py search "数据要素" --count 10
  python zhihu_search.py search "公共数据授权运营" --save 输出/查询
  python zhihu_search.py web "可信数据空间" --count 20 --db realtime
  python zhihu_search.py web "数据要素×" --host example.com --since 2026-01-01
  python zhihu_search.py hot --limit 30 --save 原始素材/热点
  python zhihu_search.py ask "什么是可信数据空间" --model zhida-thinking-1p5
  python zhihu_search.py quota

环境变量
--------
  ZHIHU_ACCESS_SECRET   必填。知乎开放平台个人中心获取的 Access Secret。
  ZHIHU_BASE_URL        可选。默认 https://developer.zhihu.com（便于走代理/网关）。

退出码
------
  0 成功；2 参数/配置错误；3 鉴权失败；4 频率限制；5 接口返回错误；6 网络错误。
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

# ---------------------------------------------------------------- 基础常量

BASE_URL = os.environ.get("ZHIHU_BASE_URL", "https://developer.zhihu.com").rstrip("/")

EP_ZHIHU_SEARCH = "/api/v1/content/zhihu_search"
EP_GLOBAL_SEARCH = "/api/v1/content/global_search"
EP_HOT_LIST = "/api/v1/content/hot_list"
EP_CHAT = "/v1/chat/completions"
EP_QUOTA = "/api/v1/quota"

CST = timezone(timedelta(hours=8))

# 错误码 → 说明（来自官方文档）
ERRCODE = {
    0: "成功",
    10001: "参数错误",
    20001: "鉴权失败（Access Secret 无效或缺失）",
    20002: "鉴权失败",
    30001: "频率限制",
    30003: "风控拒绝（请勿立即重试）",
    90001: "内部错误",
}

# 权威等级
AUTH_LEVEL = {"1": "低权威", "2": "中权威", "3": "高权威", "4": "超高权威"}


# ---------------------------------------------------------------- 输出工具

def _reconfigure_stdio():
    """Windows 控制台默认 GBK，强制 UTF-8 输出避免中文乱码。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def ts2str(ts):
    """秒级时间戳 → 'YYYY-MM-DD HH:MM'（北京时间）。"""
    try:
        n = int(ts)
        if n <= 0:
            return ""
        return datetime.fromtimestamp(n, CST).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ""


def clean_text(s):
    """去掉摘要里的 <em> 高亮标签并压缩空白。"""
    if not s:
        return ""
    import re
    s = re.sub(r"</?em>", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", s).strip()


def log(msg):
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------- 配置与额度

USAGE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".zhihu_usage.json")

# 每日额度上限（以 quota 接口实测为准，此处为本地保护默认值）
DAILY_LIMITS = {
    "zhihu_search": 5000,
    "global_search": 5000,
    "hot_list": 100,
    "question_discovery": 100,
    "zhida_openai": 100,
}

API_OF_CMD = {
    "search": "zhihu_search",
    "web": "global_search",
    "hot": "hot_list",
    "ask": "zhida_openai",
    "quota": None,  # 额度查询本身不消耗额度
}


def load_env_file():
    """从脚本同目录 .env 与知识库根 .env 加载配置（不覆盖已有环境变量）。"""
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, ".env"), os.path.join(here, "..", "..", ".env")):
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    if k and v and k not in os.environ:
                        os.environ[k] = v
        except Exception:
            pass


def record_usage(api_id):
    """记录当日调用次数，接近/超过上限时在 stderr 给出提示（不阻断）。"""
    if not api_id:
        return
    today = datetime.now(CST).strftime("%Y-%m-%d")
    data = {}
    if os.path.isfile(USAGE_FILE):
        try:
            with open(USAGE_FILE, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {}
    if data.get("date") != today:
        data = {"date": today, "counts": {}}
    counts = data.setdefault("counts", {})
    counts[api_id] = counts.get(api_id, 0) + 1
    try:
        with open(USAGE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    limit = DAILY_LIMITS.get(api_id, 5000)
    used = counts[api_id]
    if used >= limit:
        log("[额度警告] %s 今日已调用 %d 次，已达本地保护上限 %d，请检查是否异常。" % (api_id, used, limit))
    elif used >= limit * 0.8:
        log("[额度提示] %s 今日已调用 %d/%d 次。" % (api_id, used, limit))


# ---------------------------------------------------------------- HTTP 调用

def get_secret(args):
    load_env_file()
    secret = getattr(args, "secret", None) or os.environ.get("ZHIHU_ACCESS_SECRET", "")
    secret = (secret or "").strip()
    if not secret:
        log("[错误] 未找到 Access Secret。\n"
            "       请先在知乎开放平台个人中心获取：https://developer.zhihu.com/profile\n"
            "       然后设置环境变量（任选其一）：\n"
            "         Git Bash : export ZHIHU_ACCESS_SECRET=\"你的secret\"\n"
            "         PowerShell: $env:ZHIHU_ACCESS_SECRET=\"你的secret\"\n"
            "         永久设置  : setx ZHIHU_ACCESS_SECRET \"你的secret\"（需重开终端）\n"
            "       或本次临时传入：--secret \"你的secret\"")
        sys.exit(2)
    return secret


def build_headers(secret):
    return {
        "Authorization": "Bearer " + secret,
        "X-Request-Timestamp": str(int(time.time())),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def http_request(path, params=None, method="GET", body=None, secret=""):
    """发起一次请求，返回解析后的 JSON dict。"""
    url = BASE_URL + path
    data = None
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url, data=data, method=method)
    for k, v in build_headers(secret).items():
        req.add_header(k, v)

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        log("[错误] HTTP %s：%s" % (e.code, raw[:300]))
        sys.exit(6)
    except urllib.error.URLError as e:
        log("[错误] 网络异常：%s（请检查网络/代理；必要可设 ZHIHU_BASE_URL）" % e.reason)
        sys.exit(6)

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        log("[错误] 返回非 JSON：%s" % raw[:300])
        sys.exit(5)

    # 直答接口是 OpenAI 风格错误结构，单独处理
    if "error" in payload and "Code" not in payload:
        err = payload.get("error", {})
        log("[错误] 直答接口：%s（type=%s, code=%s）"
            % (err.get("message"), err.get("type"), err.get("code")))
        sys.exit(5)

    code = payload.get("Code")
    if code is not None and code != 0:
        msg = ERRCODE.get(code, "未知错误")
        log("[错误] Code=%s %s | Message=%s" % (code, msg, payload.get("Message", "")))
        if code in (20001, 20002):
            sys.exit(3)
        if code in (30001, 30003):
            log("       提示：每日免费额度按北京时间 00:00 重置；可运行 `quota` 查看剩余额度。")
            sys.exit(4)
        sys.exit(5)

    return payload


def api_get(path, params, secret):
    return http_request(path, params=params, method="GET", secret=secret)


# ---------------------------------------------------------------- 渲染

def render_items_md(title, subtitle, items, meta_lines=None):
    lines = []
    lines.append("---")
    lines.append("title: %s" % title)
    lines.append("type: page")
    lines.append("date: %s" % datetime.now(CST).strftime("%Y-%m-%d"))
    lines.append("source: developer.zhihu.com（知乎开放平台）")
    lines.append("tags: [知乎检索, 外部内容]")
    lines.append("---")
    lines.append("")
    lines.append("# %s" % title)
    lines.append("")
    if subtitle:
        lines.append("> %s" % subtitle)
        lines.append("")
    if meta_lines:
        for m in meta_lines:
            lines.append("- %s" % m)
        lines.append("")
    for i, it in enumerate(items, 1):
        lines.append("## %d. %s" % (i, it.get("Title", "(无标题)")))
        lines.append("")
        auth = it.get("AuthorityLevel", "")
        tags = []
        if it.get("ContentType"):
            tags.append("类型：%s" % it["ContentType"])
        if auth:
            tags.append("权威等级：%s" % AUTH_LEVEL.get(str(auth), str(auth)))
        if it.get("VoteUpCount") is not None:
            tags.append("赞同 %s" % it["VoteUpCount"])
        if it.get("CommentCount") is not None:
            tags.append("评论 %s" % it["CommentCount"])
        if it.get("RankingScore") is not None:
            tags.append("排序分 %s" % it["RankingScore"])
        if tags:
            lines.append("`%s`" % " · ".join(str(t) for t in tags))
            lines.append("")
        if it.get("AuthorName"):
            who = it["AuthorName"]
            if it.get("AuthorBadgeText"):
                who += "（%s）" % it["AuthorBadgeText"]
            lines.append("- 作者：%s" % who)
        if it.get("EditTime"):
            lines.append("- 时间：%s" % ts2str(it["EditTime"]))
        if it.get("Url"):
            lines.append("- 链接：%s" % it["Url"])
        txt = clean_text(it.get("ContentText", ""))
        if txt:
            lines.append("")
            lines.append(txt)
        lines.append("")
    return "\n".join(lines) + "\n"


def render_hot_md(title, items):
    lines = ["---",
             "title: %s" % title,
             "type: page",
             "date: %s" % datetime.now(CST).strftime("%Y-%m-%d"),
             "source: developer.zhihu.com（知乎开放平台·热榜）",
             "tags: [知乎检索, 热榜]",
             "---", "",
             "# %s" % title, "",
             "> 来源：知乎开放平台热榜接口；引用请回原文核对。", ""]
    for i, it in enumerate(items, 1):
        lines.append("%d. **[%s](%s)**" % (i, it.get("Title", ""), it.get("Url", "")))
        if it.get("Summary"):
            lines.append("   - %s" % clean_text(it["Summary"]))
    lines.append("")
    return "\n".join(lines) + "\n"


def save_output(text, save_dir, filename=None):
    os.makedirs(save_dir, exist_ok=True)
    if not filename:
        filename = datetime.now(CST).strftime("%Y-%m-%d-%H%M%S") + "-知乎检索.md"
    path = os.path.join(save_dir, filename)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    log("[已保存] %s" % os.path.abspath(path))
    return path


# ---------------------------------------------------------------- 子命令

def cmd_search(args):
    secret = get_secret(args)
    params = {"Query": args.query, "Count": args.count}
    payload = api_get(EP_ZHIHU_SEARCH, params, secret)
    data = payload.get("Data", {}) or {}
    items = data.get("Items", []) or []

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        if args.save:
            save_output(json.dumps(payload, ensure_ascii=False, indent=2), args.save,
                        datetime.now(CST).strftime("%Y-%m-%d-%H%M%S") + "-知乎搜索.json")
        return

    title = "知乎站内搜索：%s" % args.query
    md = render_items_md(
        title,
        "数据源：知乎开放平台 zhihu_search 接口（站内内容搜索）。",
        items,
        meta_lines=["关键词：%s" % args.query,
                    "返回 %d 条（官方单次上限 10）" % len(items),
                    "检索时间：%s" % datetime.now(CST).strftime("%Y-%m-%d %H:%M")],
    )
    if not items and data.get("EmptyReason"):
        md += "\n_无结果，原因：%s_\n" % data["EmptyReason"]
    print(md)
    if args.save:
        save_output(md, args.save,
                    datetime.now(CST).strftime("%Y-%m-%d-%H%M%S") + "-知乎搜索-%s.md" % _safe(args.query))


def cmd_web(args):
    secret = get_secret(args)
    params = {"Query": args.query, "Count": args.count, "SearchDB": args.db}
    flt = build_filter(args)
    if flt:
        params["Filter"] = flt
    payload = api_get(EP_GLOBAL_SEARCH, params, secret)
    data = payload.get("Data", {}) or {}
    items = data.get("Items", []) or []

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        if args.save:
            save_output(json.dumps(payload, ensure_ascii=False, indent=2), args.save,
                        datetime.now(CST).strftime("%Y-%m-%d-%H%M%S") + "-全网搜索.json")
        return

    meta = ["关键词：%s" % args.query,
            "索引库：%s" % args.db,
            "返回 %d 条（官方单次上限 20）" % len(items)]
    if flt:
        meta.append("筛选表达式：%s" % flt)
    meta.append("检索时间：%s" % datetime.now(CST).strftime("%Y-%m-%d %H:%M"))
    md = render_items_md(
        "全网搜索：%s" % args.query,
        "数据源：知乎开放平台 global_search 接口（整合知乎站内与全网权威信源）。",
        items, meta_lines=meta)
    print(md)
    if args.save:
        save_output(md, args.save,
                    datetime.now(CST).strftime("%Y-%m-%d-%H%M%S") + "-全网搜索-%s.md" % _safe(args.query))


def build_filter(args):
    parts = []
    if args.host:
        parts.append('host=="%s"' % args.host)
    if args.since:
        parts.append("publish_time>=%d" % _date_to_ts(args.since))
    if args.until:
        parts.append("publish_time<=%d" % (int(_date_to_ts(args.until)) + 86399))
    return " AND ".join(parts)


def _date_to_ts(d):
    dt = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=CST)
    return int(dt.timestamp())


def cmd_hot(args):
    secret = get_secret(args)
    payload = api_get(EP_HOT_LIST, {"Limit": args.limit}, secret)
    data = payload.get("Data", {}) or {}
    items = data.get("Items", []) or []

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    title = "知乎热榜 · %s" % datetime.now(CST).strftime("%Y-%m-%d %H:%M")
    md = render_hot_md(title, items)
    print(md)
    if args.save:
        save_output(md, args.save,
                    datetime.now(CST).strftime("%Y-%m-%d") + "-知乎热榜.md")


def cmd_ask(args):
    secret = get_secret(args)
    body = {"model": args.model,
            "messages": [{"role": "user", "content": args.question}],
            "stream": False}
    payload = http_request(EP_CHAT, method="POST", body=body, secret=secret)

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    choice = (payload.get("choices") or [{}])[0]
    msg = choice.get("message", {}) or {}
    lines = ["---",
             "title: 知乎直答：%s" % args.question,
             "type: page",
             "date: %s" % datetime.now(CST).strftime("%Y-%m-%d"),
             "source: developer.zhihu.com（知乎直答 %s）" % args.model,
             "tags: [知乎检索, 直答]",
             "---", "",
             "# 知乎直答", "",
             "**问题：** %s" % args.question, "",
             "**模型：** `%s`" % payload.get("model", args.model), ""]
    if msg.get("reasoning_content"):
        lines += ["## 思考过程", "", msg["reasoning_content"], ""]
    lines += ["## 回答", "", msg.get("content", ""), ""]
    md = "\n".join(lines)
    print(md)
    if args.save:
        save_output(md, args.save,
                    datetime.now(CST).strftime("%Y-%m-%d-%H%M%S") + "-知乎直答.md")


def cmd_quota(args):
    secret = get_secret(args)
    payload = api_get(EP_QUOTA, None, secret)
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _safe(s):
    import re
    s = re.sub(r"[\\/:*?\"<>|\s]+", "-", s).strip("-")
    return s[:30] if s else "query"


# ---------------------------------------------------------------- CLI

def build_parser():
    ap = argparse.ArgumentParser(
        prog="zhihu_search.py",
        description="知乎开放平台检索工具（零依赖）。Secret 从环境变量 ZHIHU_ACCESS_SECRET 读取。",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--secret", help="临时传入 Access Secret（不建议，优先用环境变量）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("search", help="知乎站内搜索")
    p.add_argument("query")
    p.add_argument("--count", type=int, default=10, help="条数，默认 10，最大 10")
    p.add_argument("--json", action="store_true", help="输出原始 JSON")
    p.add_argument("--save", metavar="DIR", help="将 Markdown 结果保存到目录")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("web", help="全网搜索")
    p.add_argument("query")
    p.add_argument("--count", type=int, default=10, help="条数，默认 10，最大 20")
    p.add_argument("--db", choices=["all", "realtime", "static"], default="all", help="索引库")
    p.add_argument("--host", help="按站点域名筛选，如 example.com")
    p.add_argument("--since", help="起始日期 YYYY-MM-DD")
    p.add_argument("--until", help="截止日期 YYYY-MM-DD")
    p.add_argument("--json", action="store_true")
    p.add_argument("--save", metavar="DIR")
    p.set_defaults(func=cmd_web)

    p = sub.add_parser("hot", help="知乎热榜")
    p.add_argument("--limit", type=int, default=30, help="条数，默认 30，最大 30")
    p.add_argument("--json", action="store_true")
    p.add_argument("--save", metavar="DIR")
    p.set_defaults(func=cmd_hot)

    p = sub.add_parser("ask", help="知乎直答（生成式回答）")
    p.add_argument("question")
    p.add_argument("--model", default="zhida-thinking-1p5",
                   choices=["zhida-fast-1p5", "zhida-thinking-1p5", "zhida-agent"])
    p.add_argument("--json", action="store_true")
    p.add_argument("--save", metavar="DIR")
    p.set_defaults(func=cmd_ask)

    p = sub.add_parser("quota", help="查询当日免费额度")
    p.set_defaults(func=cmd_quota)

    return ap


def main():
    _reconfigure_stdio()
    args = build_parser().parse_args()
    args.func(args)
    record_usage(API_OF_CMD.get(args.cmd))


if __name__ == "__main__":
    main()
