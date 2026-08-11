#!/usr/bin/env node
/* ============================================================
 * 可靠记账 CLI —— AI / 用户记账的唯一入口
 * 保证：格式与 server.js 解析正则 100% 兼容 · 写后读回校验 · 防重复 · 原子写
 *
 * 用法：
 *   记一笔:  node ledger.js add <date> <time|-> <支出|收入> <一级分类> <二级分类> <金额> <说明|-> [--time 当前时刻]
 *             例: node ledger.js add 2026-08-10 - 支出 餐饮美食 晚餐 19 晚饭
 *             例: node ledger.js add 2026-08-10 - 支出 居住生活 家具家电 6384.35 "西门子洗碗机 HB06"
 *   查看:    node ledger.js list <date>           # 输出该日账目 JSON
 *   排查:    node ledger.js check                 # 全库扫描，检查格式/解析兼容性
 *   知识库根目录: 默认 __KB_ROOT__，可用环境变量 WB_KB_ROOT 覆盖
 * ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const KB_ROOT = process.env.WB_KB_ROOT || "__KB_ROOT__";
const DAILY_DIR = path.join(KB_ROOT, "日常");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- 解析（与 server.js 完全一致） ---------- */
function readDaily(date) {
  const f = path.join(DAILY_DIR, date + ".md");
  if (!fs.existsSync(f)) return { exists: false, todos: [], works: [], entries: [], done: [] };
  const text = fs.readFileSync(f, "utf-8");
  const todos = [], works = [], entries = [], done = [];
  for (const line of text.split(/\r?\n/)) {
    const tm = line.match(/^-\s*\[( |x)\]\s*(.+)$/);
    if (tm) todos.push({ done: tm[1] === "x", text: tm[2].trim() });
    const wm = line.match(/^\|\s*([\d:：. ]*)\s*\|\s*([^|]+?)\s*\|$/);
    if (wm && wm[2].trim() && !wm[2].includes("工作内容")) works.push({ time: wm[1].trim(), text: wm[2].trim() });
    const em = line.match(/^\|\s*([\d:：.\s]*)\s*\|\s*(收入|支出)\s*\|\s*([^|]*)\s*\|\s*([^|]*)\s*\|\s*([\d.]+)\s*\|\s*([^|]*)\s*\|/);
    if (em) entries.push({ time: em[1].trim(), type: em[2], cat: em[3].trim(), subcat: em[4].trim() || undefined, amount: Number(em[5]), note: em[6].trim() });
    const dm = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/);
    if (dm && /^\d{4}-\d{2}-\d{2}/.test(dm[1]) && dm[2].trim() && !dm[2].includes("办结日期")) done.push({ date: dm[1].trim(), text: dm[2].trim(), meeting: dm[3] ? dm[3].trim() : undefined });
  }
  return { exists: true, todos, works, entries, done };
}

/* ---------- 生成（与 server.js 写入格式完全一致） ---------- */
function buildMarkdown(date, data) {
  const todoLines = data.todos.map((t) => `- [${t.done ? "x" : " "}] ${String(t.text).replace(/\n/g, " ").trim()}`).filter((l) => l.length > 4);
  const workRows = data.works.map((w) => `| ${w.time || ""} | ${String(w.text).replace(/\n/g, " ").trim().replace(/\|/g, "／")} |`).filter((r) => r.length > 6);
  const entryRows = data.entries.map((e) => `| ${e.time || ""} | ${e.type} | ${e.cat || ""} | ${e.subcat || ""} | ${Number(e.amount) || 0} | ${(e.note || "").replace(/\|/g, "／")} |`);
  const doneRows = data.done.map((d) => `| ${d.date || date} | ${String(d.text).replace(/\n/g, " ").trim().replace(/\|/g, "／")} | ${(d.meeting || "").replace(/\|/g, "／")} |`);
  return `---\ndate: ${date}\ntype: daily\n---\n\n## 🛠 每日工作\n\n| 时间 | 工作内容 |\n|---|---|\n${workRows.length ? workRows.join("\n") + "\n" : "<!-- 暂无工作记录 -->\n"}\n## 📋 待办事项\n\n${todoLines.length ? todoLines.join("\n") + "\n" : "<!-- 暂无待办 -->\n"}\n## ✅ 已办结事项\n\n| 办结日期 | 事项 | 会议纪要 |\n|---|---|---|\n${doneRows.length ? doneRows.join("\n") + "\n" : "<!-- 暂无已办结 -->\n"}\n## 💰 记账手册\n\n| 时间 | 类型 | 一级分类 | 二级分类 | 金额(元) | 说明 |\n|---|---|---|---|---|---|\n${entryRows.length ? entryRows.join("\n") + "\n" : "<!-- 暂无账目 -->\n"}`;
}

/* ---------- 追加账目（原子写 + 读回验证 + 防重复） ---------- */
function addEntry(date, entry) {
  if (!DATE_RE.test(date)) return { ok: false, error: "日期格式应为 YYYY-MM-DD" };
  const data = readDaily(date);
  const dup = data.entries.find((e) => e.type === entry.type && Number(e.amount) === entry.amount && (e.note || "") === (entry.note || ""));
  if (dup) return { ok: false, error: `重复账目：${date} 已有「${entry.type} ${entry.amount} 元${entry.note ? " · " + entry.note : ""}」，未写入` };
  data.entries.push(entry);
  fs.mkdirSync(DAILY_DIR, { recursive: true });
  const target = path.join(DAILY_DIR, date + ".md");
  const tmp = target + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(tmp, buildMarkdown(date, data), "utf-8");
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: "写入失败：" + e.message };
  }
  /* 读回验证：文件里必须能找到这笔账 */
  const verify = readDaily(date);
  const found = verify.entries.filter((e) => e.type === entry.type && Number(e.amount) === entry.amount && (e.note || "") === (entry.note || ""));
  if (!found.length) return { ok: false, error: "⚠️ 写回后校验失败：账目未在文件中找到（文件可能未正确写入）" };
  return { ok: true, file: "日常/" + date + ".md", totalEntries: verify.entries.length, added: found.length };
}

/* ---------- 全库排查 ---------- */
function checkAll() {
  const out = { scanned: 0, entries: 0, problems: [] };
  if (!fs.existsSync(DAILY_DIR)) return { ok: false, error: "日常目录不存在：" + DAILY_DIR };
  for (const f of fs.readdirSync(DAILY_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
    const date = f.slice(0, 10);
    const d = readDaily(date);
    out.scanned++;
    out.entries += d.entries.length;
    /* 检查记账区块是否含无法解析的行 */
    const text = fs.readFileSync(path.join(DAILY_DIR, f), "utf-8");
    const sec = text.split("## 💰 记账手册")[1] || "";
    if (sec) {
      const lines = sec.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim() || line.trim().startsWith("|") || line.trim().startsWith("<!--") || line.trim().startsWith("---")) continue;
        out.problems.push(`${date}: 记账区块存在无法解析的内容 → "${line.trim()}"`);
      }
      /* 记账行数与解析数对比 */
      const rawRows = lines.filter((l) => /^\|\s*[\d:：.\s]*\s*\|\s*(收入|支出)\s*\|/.test(l)).length;
      if (rawRows !== d.entries.length) out.problems.push(`${date}: 原始记账行 ${rawRows} 条，解析 ${d.entries.length} 条，不一致！`);
    }
  }
  return { ok: true, ...out };
}

/* ---------- CLI ---------- */
const [cmd, ...args] = process.argv.slice(2);
if (cmd === "add") {
  const [date, time, type, cat, subcat, amount, note] = args;
  if (!date || !type || !cat || !subcat || !amount) {
    console.log(JSON.stringify({ ok: false, error: "用法: ledger.js add <YYYY-MM-DD> <时间|-> <支出|收入> <一级分类> <二级分类> <金额> <说明|->" }, null, 2));
    process.exit(2);
  }
  if (!["支出", "收入"].includes(type)) return fail(`类型必须是「支出」或「收入」，收到：${type}`);
  const amt = Number(amount);
  if (!(amt > 0) || !/^\d+(\.\d{1,2})?$/.test(String(amount))) return fail(`金额无效：${amount}`);
  const t = time && time !== "-" ? time : "";
  if (t && !/^\d{1,2}[:：]\d{2}$/.test(t)) return fail(`时间格式应为 HH:MM，收到：${time}`);
  const res = addEntry(date, { time: t, type, cat, subcat, amount: amt, note: note && note !== "-" ? note : undefined });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
} else if (cmd === "list") {
  const date = args[0];
  if (!DATE_RE.test(date || "")) return fail("用法: ledger.js list <YYYY-MM-DD>");
  const d = readDaily(date);
  console.log(JSON.stringify({ ok: true, date, exists: d.exists, entries: d.entries }, null, 2));
} else if (cmd === "check") {
  const res = checkAll();
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.problems.length ? 1 : 0);
} else {
  console.log("可靠记账 CLI\n  add  记一笔    ledger.js add 2026-08-10 - 支出 餐饮美食 晚餐 19 晚饭\n  list 查看某日  ledger.js list 2026-08-10\n  check 全库排查  ledger.js check");
  process.exit(2);
}
function fail(msg) { console.log(JSON.stringify({ ok: false, error: msg }, null, 2)); process.exit(1); }
