#!/usr/bin/env node
/**
 * AI 知识工作台 — 本地服务（零依赖）
 * 静态文件 + 知识库 API。启动：node server.js [port]
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL } = require("url");

/* 知识库根目录：优先环境变量 WB_KB_ROOT（App 打包用），其次端口参数旁默认值 */
const KB_ROOT = path.resolve(process.env.WB_KB_ROOT || path.join(os.homedir(), "Documents", "MyKnowledgeBase"));
const APP_DIR = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const AI_SERVICE_AUTOMATION_ID = process.env.WB_AI_SERVICE_AUTOMATION_ID || ""; // 可选：用于立即唤醒 AI 对话自动化

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

/* 书架目录（知识库根目录下） */
const BOOKSHELF_DIR = safeJoin(KB_ROOT, "书架");
if (!fs.existsSync(BOOKSHELF_DIR)) fs.mkdirSync(BOOKSHELF_DIR, { recursive: true });
const BOOKS_JSON = path.join(BOOKSHELF_DIR, "books.json");

function safeJoin(base, rel) {
  const b = path.resolve(base);
  const abs = path.resolve(b, rel);
  if (abs !== b && !abs.startsWith(b + path.sep)) return null;
  return abs;
}

function readJson(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/* Windows 文件锁重试写：Obsidian/搜索索引可能占用文件句柄 → EPERM/EBUSY。
   等待后重试，最长约 12s（覆盖 Obsidian 短暂读取、索引扫描等场景）。 */
function writeFileRetry(file, data, opts = {}) {
  const { retries = 20, delayMs = 600, encoding } = opts;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      fs.writeFileSync(file, data, encoding || "utf-8");
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY") throw e;
      if (i < retries - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw lastErr;
}

/* 把文件锁错误翻译成可读提示 */
function friendlyFileErr(e, file) {
  if (e && (e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES")) {
    return `文件被其他程序占用（常见：Obsidian 正打开此文件）。请在 Obsidian 中关闭「${path.basename(file)}」后重试。`;
  }
  return e && e.message ? e.message : String(e);
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = {};
  if (m) {
    const lines = m[1].split(/\r?\n/);
    let curKey = null; // 当前标量 key，用于承接 YAML 数组续行
    lines.forEach((line) => {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (kv) {
        /* 顶层键值：覆盖式写入 */
        let v = kv[2].trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        if (v === "true") v = true;
        else if (v === "false") v = false;
        fm[kv[1]] = v;
        curKey = kv[1];
      } else if (curKey && Array.isArray(fm[curKey]) && /^\s+[\w-]+:/.test(line) && !/^\s*-\s/.test(line)) {
        /* 数组项内的嵌套键值（对象型数组续行）：
           relation_type: \n  - source: xxx \n    target: yyy
           → 把 target 合入最近 push 的数组项对象，避免污染顶层 key */
        const nkv = line.match(/^\s*([\w-]+):\s*(.*)$/);
        const last = fm[curKey][fm[curKey].length - 1];
        if (nkv && last && typeof last === "object" && !Array.isArray(last)) {
          let v = nkv[2].trim();
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
          last[nkv[1]] = v;
        } else curKey = null;
      } else if (curKey && /^\s*-\s+/.test(line)) {
        /* YAML 数组续行：key: 之后跟 - item 行（如 source: 多来源 / relation_type: 对象项）
           - key: value 形式的项解析为对象，纯文本项保持字符串 */
        const item = line.replace(/^\s*-\s+/, "").trim();
        const obj = item.match(/^([\w-]+):\s*(.*)$/);
        let parsed;
        if (obj) {
          let v = obj[2].trim();
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
          parsed = { [obj[1]]: v };
        } else {
          parsed = item.replace(/^"(.*)"$/, "$1");
        }
        if (Array.isArray(fm[curKey])) fm[curKey].push(parsed);
        else if (fm[curKey] !== undefined && fm[curKey] !== "") fm[curKey] = [fm[curKey], parsed];
        else fm[curKey] = [parsed];
      } else {
        curKey = null;
      }
    });
  }
  return { fm, body: m ? text.slice(m[0].length) : text };
}

function walkMds(dir, base, out, skip = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (skip.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMds(full, base, out, skip);
    else if (e.name.endsWith(".md")) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      out.push(rel);
    }
  }
}

/* 原始素材区文件扫描：md + 图片，返回 {rel, type(一级子目录), mtime} */
function walkRawFiles(out) {
  const root = path.join(KB_ROOT, "原始素材");
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("_")) continue;
    const sub = path.join(root, e.name);
    (function scan(dir) {
      let es;
      try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const x of es) {
        if (x.name.startsWith(".")) continue;
        const full = path.join(dir, x.name);
        if (x.isDirectory()) scan(full);
        else if (/\.(md|png|jpg|jpeg|webp|gif|svg|pptx|ppt)$/i.test(x.name) && !/^README\.md$/i.test(x.name)) {
          const rel = path.relative(KB_ROOT, full).split(path.sep).join("/");
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch {}
          out.push({ rel, type: e.name, mtime });
        }
      }
    })(sub);
  }
  /* AI 回答（输出/查询/answers/）也纳入素材库，作为独立类型（type: "AI回答"） */
  const ansRoot = path.join(KB_ROOT, "输出", "查询", "answers");
  if (fs.existsSync(ansRoot)) {
    try {
      const ans = fs.readdirSync(ansRoot, { withFileTypes: true });
      for (const x of ans) {
        if (x.isDirectory() || !x.name.endsWith(".md")) continue;
        const full = path.join(ansRoot, x.name);
        const rel = path.relative(KB_ROOT, full).split(path.sep).join("/");
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        out.push({ rel, type: "AI回答", mtime });
      }
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime);
}

function collectWikiLinks(text) {
  const links = new Set();
  const re = /\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(text))) links.add(m[1].trim());
  return [...links];
}

/* 带语境地采集 wiki 双链：每次出现都记录「所在标题 + 所在行摘要」，
   用于回答“两篇文档为什么有关联”，而不只是“有关联”。
   返回 [{ name, heading, snippet }]，按出现顺序。 */
function collectWikiLinkContexts(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  const re = /\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;
  let heading = "";
  /* 逐行扫描而非用全局 index 反推行号：CRLF 文件下标会累积偏移，导致引用对错行 */
  for (const line of lines) {
    const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h) heading = h[1].replace(/[`*_]/g, "").trim();
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      /* 把双链替换成显示名（别名优先），再去掉行首列表/引用符号，压平空白 */
      let snip = line
        .replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (s, a, b) => (b || a).trim())
        .replace(/^\s*[>#*+\-]+\s*/, "")
        .replace(/[`*_]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!snip) snip = (m[0] || "").trim();
      if (snip.length > 110) snip = snip.slice(0, 110) + "…";
      out.push({ name: m[1].trim(), heading, snippet: snip });
    }
  }
  return out;
}

/* 采集 frontmatter 里 relation_type 定义的语义关系：{ name, type, weight }
   这类关系往往没有对应的正文双链，只有「语义类型」，是关联情况的另一种来源。 */
function collectFrontmatterRelations(text) {
  const { fm } = parseFrontmatter(text);
  const rt = fm.relation_type;
  if (!rt) return [];
  const arr = Array.isArray(rt) ? rt : [rt];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const tgt = it.target;
    if (!tgt) continue;
    const name = String(tgt).split("/").pop().replace(/\.md$/, "").replace(/^"(.*)"$/, "$1").trim();
    if (!name) continue;
    out.push({ name, type: String(it.type || "").trim(), weight: it.weight != null && it.weight !== "" ? String(it.weight) : "" });
  }
  return out;
}

/* graph 数据结构版本：结构升级时递增，前端据此判断后台是否与前端同版 */
const GRAPH_SCHEMA = "2026-09-14-context-v2";

const skipDirs = ["工作台", ".obsidian", ".trash", ".git", "node_modules"];

/* 内存缓存：search-index（2.5MB）和 graph（90KB）每次重建耗时，缓存后 <5ms */
let _searchIndexCache = null;
let _searchIndexCacheTime = 0;
let _graphCache = null;
let _graphCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟，重启即失效

/* ---------- API Handlers ---------- */
function apiStats() {
  const wiki = path.join(KB_ROOT, "知识层");
  const counts = { source: 0, concept: 0, entity: 0, comparison: 0, synthesis: 0, essay: 0, template: 0, topic: 0, prompt: 0 };
  const byDir = {};
  (function scan(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith("_") || e.name === "README.md") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        byDir[e.name] = byDir[e.name] || 0;
        const before = countMd(full);
        byDir[e.name] += before;
        scan(full);
      } else if (e.name.endsWith(".md")) {
        const parent = path.basename(dir);
        if (parent === "概念") counts.concept++;
        else if (parent === "实体") counts.entity++;
        else if (parent === "素材摘要") counts.source++;
        else if (parent === "对比") counts.comparison++;
        else if (parent === "综述") counts.synthesis++;
        else if (parent === "随笔") counts.essay++;
        else if (parent === "_模板") counts.template++;
        else if (parent === "主题") counts.topic++;
        else if (parent === "提示词") counts.prompt++;
      }
    }
  })(wiki);
  function countMd(dir) {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_") && f !== "README.md").length; } catch { return 0; }
  }
  const rawFiles = [];
  walkMds(path.join(KB_ROOT, "原始素材", "文章"), KB_ROOT, rawFiles, skipDirs);
  const total = rawFiles.length;
  /* 素材分类统计（与前端 LIB_GROUPS 关键词一致，供 Dashboard 迷你图） */
  const LIB_GROUPS = [
    { k: "制度政策", kw: ["管理办法", "实施细则", "暂行办法", "规范", "规定", "条例", "通知", "指导意见", "实施方案", "价格", "登记"] },
    { k: "汇报交流", kw: ["汇报", "发言稿", "报告", "务虚", "交流", "座谈", "周报"] },
    { k: "申报材料", kw: ["申报书", "申报", "大赛", "资金申请", "试点", "项目建议"] },
    { k: "工具模板", kw: ["培训", "课件", "操作手册", "指引", "指南", "清单", "报价", "岗位", "流程", "架构", "模板"] },
    { k: "商务合作", kw: ["协议", "合同", "保密", "合作", "采购", "招标", "框架"] },
    { k: "技术能力", kw: ["数据空间", "可信", "密态", "隐私", "区块链", "沙箱", "连接器", "智能体", "AI", "大模型", "算力"] },
    { k: "业务场景", kw: ["政务平台", "授权运营", "资产入表", "数据资产", "金融", "信用", "医保", "保险", "就业", "汽车服务", "汽车", "教育"] },
  ];
  const groups = LIB_GROUPS.map((g) => ({ k: g.k, count: rawFiles.filter((f) => g.kw.some((k) => f.includes(k))).length }));
  groups.push({ k: "其他", count: Math.max(0, total - groups.reduce((a, b) => a + b.count, 0)) });
  /* 待审卡片列表：摄入产物目录（素材摘要/概念/实体/对比/综述）中 frontmatter 含 review: pending 的页面 */
  const pendingReviewList = [];
  for (const d of ["素材摘要", "AI回答提炼", "概念", "实体", "对比", "综述", "活动"]) {
    const dir = path.join(wiki, d);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".md") || f.startsWith("_") || f.toLowerCase() === "readme.md") continue;
      try {
        const head = fs.readFileSync(path.join(dir, f), "utf-8").slice(0, 400);
        /* 锚定行首，只匹配 frontmatter 里的 review 字段，避免正文里出现 "review: pending" 字面被误判 */
        if (/^review:\s*pending/m.test(head)) {
          const title = (head.match(/^title:\s*(.+)$/m) || [])[1] || f.replace(/\.md$/, "");
          pendingReviewList.push({ rel: "知识层/" + d + "/" + f, title: title.trim().replace(/^["']|["']$/g, ""), reingest: /^reingest:\s*(\S+)/m.test(head) ? (head.match(/^reingest:\s*(\S+)/m) || [])[1] : undefined });
        }
      } catch {}
    }
  }
  /* 按标题排序（稳定） */
  pendingReviewList.sort((a, b) => a.title.localeCompare(b.title));
  const logPath = path.join(KB_ROOT, "知识层", "_操作日志.md");
  const recent = [];
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, "utf-8").split(/\r?\n/).filter((l) => l.trim().startsWith("- ["));
    for (let i = Math.max(0, lines.length - 6); i < lines.length; i++) recent.push(lines[i]);
  }
  return {
    counts,
    rawFiles: total,
    wikiTotal: Object.values(counts).reduce((a, b) => a + b, 0),
    groups,
    pendingReview: pendingReviewList.length,
    pendingReviewList,
    recent,
    updatedAt: new Date().toISOString(),
  };
}

function apiFiles(type) {
  const out = [];
  if (type === "wiki") {
    walkMds(path.join(KB_ROOT, "知识层"), KB_ROOT, out, skipDirs);
  } else if (type === "raw") {
    walkRawFiles(out);
  } else {
    walkMds(path.join(KB_ROOT, "原始素材", "文章"), KB_ROOT, out, skipDirs);
  }
  /* 附加文件修改时间（mtime），供前端按时间排序；读取失败时保持字符串路径 */
  if (out.length && typeof out[0] === "string") {
    return out.map((rel) => {
      const p = safeJoin(KB_ROOT, rel);
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch {}
      return { rel, mtime };
    });
  }
  return out;
}

function apiFile(rel) {
  let p = safeJoin(KB_ROOT, rel);
  /* 引号容错：source 里半角引号与真实文件名全角引号错位的历史脏数据 → 归一化重试 */
  if (p && !fs.existsSync(p)) {
    let out = "", open = true;
    for (const ch of rel) {
      if (ch === '"') { out += open ? "\u201c" : "\u201d"; open = !open; }
      else out += ch;
    }
    if (out !== rel) {
      const p2 = safeJoin(KB_ROOT, out);
      if (p2 && fs.existsSync(p2)) p = p2;
    }
  }
  if (!p || !fs.existsSync(p) || !p.endsWith(".md")) return null;
  const text = fs.readFileSync(p, "utf-8");
  const { fm, body } = parseFrontmatter(text);
  const links = collectWikiLinks(body);
  return { rel, fm, body, links, size: text.length };
}

/* 保存文档正文（保留 frontmatter）：POST /api/file { rel, body }
   工作台「✏️ 编辑」写回，与 Obsidian 双向修改。 */
function apiFileSave(req, cb) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 8e6) req.destroy(); });
  req.on("end", () => {
    try {
      const j = JSON.parse(body || "{}");
      const rel = (j.rel || "").trim();
      const newBody = typeof j.body === "string" ? j.body : "";
      if (!rel) return cb({ ok: false, error: "缺少 rel" });
      const p = safeJoin(KB_ROOT, rel);
      if (!p || !fs.existsSync(p) || !p.endsWith(".md")) return cb({ ok: false, error: "文件不存在：" + rel });
      const text = fs.readFileSync(p, "utf-8");
      /* 保留原 frontmatter，只替换正文（frontmatter 由审核/AI 流程维护）；\r? 兼容 Windows 换行 */
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      const fmPart = m ? m[0] : "";
      const clean = newBody.replace(/^\r?\n+/, "").replace(/\s+$/, "");
      writeFileRetry(p, fmPart + clean + "\n", { retries: 10, delayMs: 600 });
      cb({ ok: true, rel });
    } catch (e) { cb({ ok: false, error: e.message }); }
  });
}

function apiSearch(q, scope) {
  const ql = q.toLowerCase();
  const results = [];
  const roots = scope === "wiki"
    ? [path.join(KB_ROOT, "知识层")]
    : [path.join(KB_ROOT, "原始素材", "文章"), path.join(KB_ROOT, "原始素材", "热点"), path.join(KB_ROOT, "知识层")];
  const files = [];
  roots.forEach((r) => walkMds(r, KB_ROOT, files, skipDirs));
  for (const rel of files) {
    const p = safeJoin(KB_ROOT, rel);
    if (!p) continue;
    let text;
    try { text = fs.readFileSync(p, "utf-8"); } catch { continue; }
    const { fm, body } = parseFrontmatter(text);
    const title = fm.title || path.basename(rel, ".md");
    const scoreTitle = (title || "").toLowerCase().includes(ql) ? 100 : 0;
    const idx = body.toLowerCase().indexOf(ql);
    let snippet = "";
    if (idx >= 0) {
      const s = Math.max(0, idx - 60);
      snippet = body.slice(s, idx + 120).replace(/\s+/g, " ").trim();
    }
    const hits = (body.match(new RegExp(escapeReg(ql), "gi")) || []).length;
    if (scoreTitle > 0 || idx >= 0) {
      results.push({ rel, title, score: scoreTitle + Math.min(hits * 10, 50), snippet });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 30);
}
function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/* 把 relation_type（对象/字符串数组）展平成可搜索文本：
   [{type:"IMPLEMENTS", source:"知识层/实体/政务平台平台", target:"..."}] → "IMPLEMENTS 政务平台平台 …"
   仅取 basename，避免把整条路径拆进分词 */
function flattenRelations(rt) {
  if (!rt) return "";
  const arr = Array.isArray(rt) ? rt : [rt];
  const parts = [];
  for (const it of arr) {
    if (typeof it === "string") { parts.push(it.split("/").pop().replace(/\.md$/, "")); continue; }
    if (!it || typeof it !== "object") continue;
    for (const k of ["type", "source", "target"]) {
      const v = it[k];
      if (!v) continue;
      const base = String(v).split("/").pop().replace(/\.md$/, "").replace(/^"(.*)"$/, "$1");
      if (base) parts.push(base);
    }
  }
  return parts.join(" ");
}

function apiSearchIndex() {
  if (_searchIndexCache && Date.now() - _searchIndexCacheTime < CACHE_TTL) return _searchIndexCache;
  const docs = [];
  const roots = [
    path.join(KB_ROOT, "原始素材", "文章"),
    path.join(KB_ROOT, "原始素材", "热点"),
    path.join(KB_ROOT, "知识层"),
    path.join(KB_ROOT, "输出", "报告"),
  ];
  const files = [];
  roots.forEach((r) => walkMds(r, KB_ROOT, files, skipDirs));
  const seen = new Set();
  for (const rel of files) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const p = safeJoin(KB_ROOT, rel);
    if (!p) continue;
    let text;
    try { text = fs.readFileSync(p, "utf-8"); } catch { continue; }
    const { fm, body } = parseFrontmatter(text);
    const title = fm.title || path.basename(rel, ".md");
    const tags = Array.isArray(fm.tags) ? fm.tags.join(" ") : (fm.tags || "");
    const aliases = Array.isArray(fm.aliases) ? fm.aliases.join(" ") : (fm.aliases || "");
    const relations = flattenRelations(fm.relation_type);
    const content = body.replace(/[#*`>\-\[\]()!|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    docs.push({ id: rel, title, aliases, relations, content, tags, type: fm.type || "page", rel });
  }
  _searchIndexCache = docs;
  _searchIndexCacheTime = Date.now();
  return docs;
}

function apiNavigation(from, to) {
  const g = apiGraph();
  const resolve = (q) => {
    if (!q) return null;
    const s = String(q).toLowerCase();
    return g.nodes.find((n) => n.rel.toLowerCase() === s || n.name.toLowerCase() === s || n.title.toLowerCase().includes(s)) || null;
  };
  const start = resolve(from), end = resolve(to);
  const incoming = {}, outgoing = {};
  g.nodes.forEach((n) => { incoming[n.rel] = []; outgoing[n.rel] = []; });
  g.links.forEach((l) => { (outgoing[l.source] || (outgoing[l.source] = [])).push(l.target); (incoming[l.target] || (incoming[l.target] = [])).push(l.source); });
  let pathResult = null;
  if (start && end) {
    const q = [start.rel], prev = { [start.rel]: null };
    while (q.length) { const cur = q.shift(); if (cur === end.rel) break; for (const next of (outgoing[cur] || [])) if (!(next in prev)) { prev[next] = cur; q.push(next); } }
    if (end.rel in prev) { const chain = []; for (let x = end.rel; x !== null; x = prev[x]) chain.unshift(x); pathResult = chain.map((r) => g.nodes.find((n) => n.rel === r)); }
  }
  return { nodes: g.nodes, links: g.links, backlinks: incoming, path: pathResult, from: start, to: end };
}

function apiGraph() {
  if (_graphCache && Date.now() - _graphCacheTime < CACHE_TTL) return _graphCache;
  const wiki = path.join(KB_ROOT, "知识层");
  const nodes = [];
  const nodeMap = {};
  const linkAgg = {}; /* key: source\u0000target → { source, target, count, contexts:[{heading,snippet}] } */
  const files = [];
  walkMds(wiki, KB_ROOT, files, skipDirs);
  const byName = {};
  files.forEach((rel) => {
    const base = path.basename(rel);
    if (base.startsWith("_") || base === "README.md" || rel.includes("/_模板/")) return;
    const name = base.replace(/\.md$/, "");
    byName[name] = rel;
    const p = path.join(KB_ROOT, rel);
    let fm = {};
    try {
      const t = fs.readFileSync(p, "utf-8");
      fm = parseFrontmatter(t).fm;
    } catch {}
    nodeMap[rel] = { rel, name, type: fm.type || "page", title: fm.title || name };
    nodes.push(nodeMap[rel]);
  });
  files.forEach((rel) => {
    const base = path.basename(rel);
    if (base.startsWith("_") || base === "README.md" || rel.includes("/_模板/")) return;
    const p = path.join(KB_ROOT, rel);
    let text;
    try { text = fs.readFileSync(p, "utf-8"); } catch { return; }
    /* 逐次出现采集语境，并按 (source,target) 聚合：count=被引用条数，contexts=关联产生的大致情况 */
    collectWikiLinkContexts(text).forEach((o) => {
      const tgt = byName[path.basename(o.name, ".md")];
      if (!tgt || tgt === rel) return;
      const key = rel + "\u0000" + tgt;
      const item = linkAgg[key] || (linkAgg[key] = { source: rel, target: tgt, count: 0, contexts: [], relations: [] });
      item.count++;
      if (item.contexts.length < 6 && !item.contexts.some((c) => c.snippet === o.snippet)) {
        item.contexts.push({ heading: o.heading, snippet: o.snippet });
      }
    });
    /* frontmatter 语义关系：即使正文没有双链，也算一条关联，并把「关系类型」作为语境 */
    collectFrontmatterRelations(text).forEach((r) => {
      const tgt = byName[r.name];
      if (!tgt || tgt === rel) return;
      const key = rel + "\u0000" + tgt;
      const item = linkAgg[key] || (linkAgg[key] = { source: rel, target: tgt, count: 0, contexts: [], relations: [] });
      if (r.type && !item.relations.includes(r.type)) item.relations.push(r.type);
      const snip = `语义关系：${r.type || "未标注"}${r.weight ? `（权重 ${r.weight}）` : ""}`;
      if (item.contexts.length < 6 && !item.contexts.some((c) => c.snippet === snip)) {
        item.contexts.push({ heading: "frontmatter 关系定义", snippet: snip });
      }
    });
  });
  const links = Object.values(linkAgg);
  let build = 0;
  try { build = Math.round(fs.statSync(__filename).mtimeMs); } catch {}
  _graphCache = { nodes, links, schema: GRAPH_SCHEMA, build };
  _graphCacheTime = Date.now();
  return _graphCache;
}

function apiHotspots() {
  const dir = path.join(KB_ROOT, "原始素材", "热点");
  const out = [];
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
    for (const name of files) {
      const rel = "原始素材/热点/" + name;
      const p = path.join(dir, name);
      let text = "";
      try { text = fs.readFileSync(p, "utf-8"); } catch { continue; }
      const { fm, body } = parseFrontmatter(text);
      out.push({
        rel,
        name,
        date: (name.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || "",
        title: fm.title || name.replace(".md", ""),
        count: (body.match(/^\d+\.\s/mg) || []).length,
        summary: body.slice(0, 260).replace(/\s+/g, " ").trim(),
        size: text.length,
      });
    }
  }
  return out;
}

/* 关键词提取：frontmatter tags + 标题词 + 正文 2-gram 高频词 */
function extractKeywords(body, title, tags, topN = 6) {
  const stop = new Set(["的","了","和","与","在","是","为","对","等","及","或","并","而","从","中","将","以","该","个","之","于","其","也","不","有","这","那","就","都","被","把","让","向","用","到","上","下","后","前","时","年","月","日","我们","他们","进行","通过","相关","工作","建设","管理","领域","方面","以及","或者","包括","其中","这些","那些","一个","已经","可以","需要","应该","主要","重要","情况","问题","发展","推动","支持","服务","应用","系统","资源","信息","机制","模式","政策","制度","项目","方案","文件","要求","规定","办法","条例","通知","意见","全市","全省","全国","xx","xxx"]);
  const freq = {};
  const clean = String(body || "").replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "");
  for (let i = 0; i < clean.length - 1; i++) {
    const bi = clean.slice(i, i + 2);
    if (stop.has(bi)) continue;
    freq[bi] = (freq[bi] || 0) + 1;
  }
  const kws = [];
  String(title || "").split(/[\s·\-—()（）《》"「」]/).filter((w) => w.length >= 2 && !stop.has(w)).forEach((w) => kws.push(w));
  (Array.isArray(tags) ? tags : []).forEach((t) => kws.push(t));
  Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, topN).forEach(([w]) => kws.push(w));
  return [...new Set(kws)].slice(0, 10);
}

function apiRelated(rel) {
  const p = safeJoin(KB_ROOT, rel);
  if (!p || !fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, "utf-8");
  const { fm, body } = parseFrontmatter(text);
  const kws = extractKeywords(body, fm.title || path.basename(rel, ".md"), fm.tags);
  const files = [];
  walkMds(path.join(KB_ROOT, "知识层"), KB_ROOT, files, skipDirs);
  walkMds(path.join(KB_ROOT, "原始素材", "文章"), KB_ROOT, files, skipDirs);
  walkMds(path.join(KB_ROOT, "原始素材", "热点"), KB_ROOT, files, skipDirs);
  const score = {};
  const meta = {};
  for (const r of files) {
    if (r === rel || r.startsWith("知识层/_")) continue;
    let t;
    try { t = fs.readFileSync(safeJoin(KB_ROOT, r), "utf-8"); } catch { continue; }
    const { fm: fm2, body: b2 } = parseFrontmatter(t);
    let s = 0;
    for (const k of kws) {
      if ((fm2.title || "").includes(k)) s += 5;
      else if (b2.includes(k)) s += 1;
    }
    if (s > 0) {
      score[r] = (score[r] || 0) + s;
      meta[r] = { title: fm2.title || path.basename(r, ".md"), type: fm2.type || "page" };
    }
  }
  return Object.entries(score).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([r, s]) => ({ rel: r, title: meta[r].title, type: meta[r].type, score: s }));
}

function apiInbox() {
  const dir = path.join(KB_ROOT, "输出", "查询", "inbox");
  const out = [];
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().forEach((name) => {
      const p = path.join(dir, name);
      let text;
      try { text = fs.readFileSync(p, "utf-8"); } catch { return; }
      const { fm, body } = parseFrontmatter(text);
      if (fm.status !== "done") {
        out.push({ rel: "输出/查询/inbox/" + name, name, id: fm.id || name.replace(".md", ""), status: fm.status || "pending", question: fm.question || body.trim(), askedAt: fm.askedAt || "" });
      }
    });
  }
  return out;
}

function apiAnswers() {
  const dir = path.join(KB_ROOT, "输出", "查询", "answers");
  const out = [];
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse().forEach((name) => {
      const p = path.join(dir, name);
      let text;
      try { text = fs.readFileSync(p, "utf-8"); } catch { return; }
      const { fm, body } = parseFrontmatter(text);
      /* 关联 inbox 原始提问（含原文上下文） */
      const inboxName = (name.match(/^(\d{8}-\d{6})/) || [])[1];
      let inboxBody = "";
      if (inboxName) {
        try {
          const ip = path.join(KB_ROOT, "输出", "查询", "inbox", inboxName + ".md");
          if (fs.existsSync(ip)) inboxBody = fs.readFileSync(ip, "utf-8");
        } catch {}
      }
      out.push({
        rel: "输出/查询/answers/" + name, name, id: fm.id || name.replace(".md", ""),
        question: fm.question || "", answeredAt: fm.answeredAt || "",
        body: body.trim(), preview: body.trim().slice(0, 120),
        inbox: inboxBody, /* 原始提问文件内容（含原文引用上下文） */
        hasContext: /原文引用|原文上下文|<!-- 原文上下文 -->/.test(inboxBody),
      });
    });
  }
  return out;
}

function apiAnswersIngest(req, cb) {
  /* POST /api/answers/ingest：把一条 AI 回答提炼成知识层素材摘要页（review: pending，走待审闭环）
     入参 {rel: "输出/查询/answers/xxx-回答.md"} */
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { rel } = JSON.parse(body || "{}");
      if (!rel) return cb({ ok: false, error: "rel 必填" });
      const p = safeJoin(KB_ROOT, rel);
      if (!p || !fs.existsSync(p) || !p.includes(path.join("输出", "查询", "answers"))) {
        return cb({ ok: false, error: "仅支持 输出/查询/answers/ 下的回答文件" });
      }
      let text = fs.readFileSync(p, "utf-8");
      const { fm, body: ansBody } = parseFrontmatter(text);
      const question = (fm.question || "").trim() || "AI 问答";
      const date = (fm.answeredAt || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      const title = question.replace(/[\\/:*?"<>|\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 30) || "AI问答";
      const safeTitle = question.replace(/[\\/:*?"<>|\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "AI问答";
      const fname = `${date}-${safeTitle}-AI回答.md`;
      const outDir = path.join(KB_ROOT, "知识层", "AI回答提炼");
      fs.mkdirSync(outDir, { recursive: true });
      const outFile = path.join(outDir, fname);
      if (fs.existsSync(outFile)) return cb({ ok: false, error: "素材摘要已存在：" + fname });
      /* 正文：问题 + 回答要点 + 依据引用（保留原文引用段） */
      let quote = "";
      const inboxName = (p.match(/(\d{8}-\d{6})/) || [])[1];
      if (inboxName) {
        const ip = path.join(KB_ROOT, "输出", "查询", "inbox", inboxName + ".md");
        if (fs.existsSync(ip)) {
          const inboxText = fs.readFileSync(ip, "utf-8");
          const m = inboxText.match(/【原文引用】([\s\S]*?)(?:\n\n【全文上下文】|$)/);
          if (m && m[1].trim()) quote = `\n\n> **原文引用：** ${m[1].trim().slice(0, 500)}`;
        }
      }
      const md = `---
type: aians
title: "${title}"
review: pending
tags:
  - aians
  - 领域/知识
  - AI回答
aliases:
  - AI问答 ${date}
source: "${rel}"
confidence: medium
deprecated: false
created: ${new Date().toISOString().slice(0, 10)}
updated: ${new Date().toISOString().slice(0, 10)}
---

# ${title}

> **来源：** ${rel}（工作台 AI 对话回答，${fm.answeredAt || date}）

## 问题

${question}${quote}

## 回答摘要

${(ansBody || "").trim().slice(0, 4000)}

## 待澄清问题
- AI 回答基于知识库检索生成，引用与数据需人工复核后确认
`;
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, md, "utf-8");
      cb({ ok: true, file: "知识层/AI回答提炼/" + fname, rel: "知识层/AI回答提炼/" + fname });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });
}

function apiAsk(req, cb) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { question, context, autoIngest } = JSON.parse(body || "{}");
      if (!question || !question.trim()) return cb({ ok: false, error: "question 必填" });
      const dir = path.join(KB_ROOT, "输出", "查询", "inbox");
      fs.mkdirSync(dir, { recursive: true });
      const id = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(Date.now()).slice(-6);
      const name = id + ".md";
      const file = path.join(dir, name);
      const ctx = (context || "").trim().slice(0, 8000);
      let header = `---\nid: ${id}\nstatus: pending\naskedAt: ${new Date().toLocaleString("zh-CN", { hour12: false })}\nquestion: "${question.replace(/"/g, "'").slice(0, 120)}"\n`;
      if (autoIngest) header += `autoIngest: true\n`;
      if (ctx) header += `hasContext: true\n`;
      header += `---\n\n${question}\n`;
      if (ctx) header += `\n<!-- 原文上下文（基于此答疑） -->\n${ctx}\n`;
      fs.writeFileSync(file, header, "utf-8");
      cb({ ok: true, id, file: "输出/查询/inbox/" + name, hasContext: !!ctx });
    } catch (e) { cb({ ok: false, error: e.message }); }
  });
}

function apiTrigger(req, cb) {
  /* 立即唤醒「工作台 AI 对话服务」：把 next_run_at 戳到现在，调度器下一轮即执行 */
  try {
    const { DatabaseSync } = require("node:sqlite");
    const dbPath = path.join(os.homedir(), ".workbuddy", "workbuddy.db");
    if (!fs.existsSync(dbPath)) return cb({ ok: false, error: "workbuddy.db 不存在" });
    const db = new DatabaseSync(dbPath);
    const now = Date.now();
    const r = db.prepare("UPDATE automations SET next_run_at = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE' AND deleted_at IS NULL")
      .run(now, now, AI_SERVICE_AUTOMATION_ID);
    db.close();
    if (r.changes > 0) cb({ ok: true, triggered: true, note: "已唤醒 WorkBuddy，即将取件" });
    else cb({ ok: false, error: "未找到可触发的自动化（检查状态/ID）" });
  } catch (e) {
    try { cb({ ok: false, error: "触发失败：" + e.message }); } catch (_) {}
  }
}

function apiReingest(req, cb) {
  /* 「打回重写」真重写：POST /api/reingest {rel, comment}
     把被拒素材摘要的源素材 + 原摘要 + 重写意见组装成一条特殊 inbox 任务，
     唤醒「工作台 AI 对话服务」自动化重新提炼 → 覆盖写回原文件（保持 review: pending） */
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { rel, comment } = JSON.parse(body || "{}");
      if (!rel) return cb({ ok: false, error: "rel 必填" });
      const filePath = safeJoin(KB_ROOT, rel);
      if (!filePath || !fs.existsSync(filePath)) return cb({ ok: false, error: "文件不存在：" + rel });
      /* 读取被拒文件：frontmatter + 正文 */
      const cur = fs.readFileSync(filePath, "utf-8");
      const parsed = parseFrontmatter(cur);
      const fm = parsed.fm || {};
      const bodyText = (parsed.body || "").trim();
      /* 源素材：frontmatter source（可能数组）→ 首个有效路径 */
      let srcRel = "";
      if (Array.isArray(fm.source)) srcRel = String(fm.source[0] || "").trim();
      else if (typeof fm.source === "string") srcRel = fm.source.trim();
      /* 找不到 source 时从正文「**来源：**」行提取 */
      if (!srcRel) {
        const m = bodyText.match(/\*\*来源：\*\*\s*([^\n]+)/);
        if (m) srcRel = m[1].replace(/[「」]/g, "").trim().split(/[，,]/)[0].trim();
      }
      /* 读取源素材全文作为重写上下文 */
      let srcContent = "";
      if (srcRel) {
        const srcPath = safeJoin(KB_ROOT, srcRel);
        if (srcPath && fs.existsSync(srcPath)) {
          try { srcContent = fs.readFileSync(srcPath, "utf-8").slice(0, 12000); } catch {}
        } else {
          /* 容错：source 路径引号格式与真实文件名不一致（半角/全角，且左右引号可能无序）。
             归一化引号后，从 srcRel 目录扫描找真实存在的文件（先精确、再模糊） */
          const normQ = (s) => s.replace(/["""]/g, '"').replace(/[‘'’]/g, "'");
          const dirPart = srcRel.split("/").slice(0, -1).join("/");
          const filePart = srcRel.split("/").pop().replace(/\.md$/i, "");
          const realDir = safeJoin(KB_ROOT, dirPart);
          if (realDir && fs.existsSync(realDir)) {
            try {
              const cands = fs.readdirSync(realDir);
              /* 1) 归一化后精确匹配 */
              const nf = normQ(filePart);
              let hit = cands.find((f) => normQ(f.replace(/\.md$/i, "")) === nf);
              /* 2) 归一化后包含匹配（文件名可能多/少引号或空格） */
              if (!hit) hit = cands.find((f) => {
                const a = normQ(f.replace(/\.md$/i, "")).replace(/\s+/g, "");
                const b = nf.replace(/\s+/g, "");
                return a.includes(b) || b.includes(a);
              });
              if (hit) {
                srcContent = fs.readFileSync(path.join(realDir, hit), "utf-8").slice(0, 12000);
                srcRel = dirPart + "/" + hit;
              }
            } catch (e) {}
          }
        }
        /* 容错②：目录本身引号不匹配（目录名也有全角引号）→ 在原始素材下递归按归一化文件名搜索 */
        if (!srcContent && srcRel) {
          const normQ2 = (s) => s.replace(/[\u201C\u201D\u0022]/g, '\u0022').replace(/[\u2018\u2019\u0027]/g, '\u0027');
          const nf2 = normQ2(srcRel.split("/").pop().replace(/\.md$/i, "")).replace(/\s+/g, "");
          try {
            const rawRoot = path.join(KB_ROOT, "原始素材");
            const found = (function scanDir(dir, depth) {
              if (depth > 4) return "";
              let es;
              try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ""; }
              for (const x of es) {
                const full = path.join(dir, x.name);
                if (x.isDirectory()) {
                  const r = scanDir(full, depth + 1);
                  if (r) return r;
                } else if (/\.md$/i.test(x.name)) {
                  const a = normQ2(x.name.replace(/\.md$/i, "")).replace(/\s+/g, "");
                  if (a === nf2 || a.includes(nf2) || nf2.includes(a)) {
                    return path.relative(KB_ROOT, full).split(path.sep).join("/");
                  }
                }
              }
              return "";
            })(rawRoot, 0);
            if (found) {
              srcContent = fs.readFileSync(path.join(KB_ROOT, found), "utf-8").slice(0, 12000);
              srcRel = found;
            }
          } catch (e) {}
        }
      }
      /* 组装重写任务 → inbox */
      const dir = path.join(KB_ROOT, "输出", "查询", "inbox");
      fs.mkdirSync(dir, { recursive: true });
      const id = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(Date.now()).slice(-6);
      const name = id + "-reingest.md";
      const taskFile = path.join(dir, name);
      const c = (comment || "").trim().slice(0, 500);
      let header = `---\nid: ${id}\ntask: reingest\nstatus: pending\naskedAt: ${new Date().toLocaleString("zh-CN", { hour12: false })}\nquestion: "重写素材摘要：${rel}"\ntargetRel: "${rel}"\n`;
      if (srcRel) header += `sourceRel: "${srcRel}"\n`;
      if (c) header += `comment: "${c.replace(/"/g, "'")}"\n`;
      header += `---\n\n请重新提炼以下源素材，生成一份新的素材摘要，覆盖写回 \`${rel}\`（保持 review: pending）。\n`;
      if (c) header += `\n**打回意见**：${c}\n`;
      header += `\n<!-- 原文上下文（基于此重写） -->\n`;
      header += srcContent ? srcContent : "(未找到源素材，请基于现有摘要与知识库补全)\n";
      if (!srcContent && bodyText) header += `\n<!-- 旧摘要（供参考） -->\n${bodyText.slice(0, 6000)}\n`;
      fs.writeFileSync(taskFile, header, "utf-8");
      /* 唤醒 AI 对话服务自动化 */
      const { DatabaseSync } = require("node:sqlite");
      const dbPath = path.join(os.homedir(), ".workbuddy", "workbuddy.db");
      let triggered = false;
      if (fs.existsSync(dbPath)) {
        try {
          const db = new DatabaseSync(dbPath);
          const now = Date.now();
          const r = db.prepare("UPDATE automations SET next_run_at = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE' AND deleted_at IS NULL")
            .run(now, now, AI_SERVICE_AUTOMATION_ID);
          db.close();
          triggered = r.changes > 0;
        } catch (e) { triggered = false; }
      }
      /* 给目标文件打「重写中」标记（AI 重写覆盖写回时清除），待审卡片据此显示 ♻️ 徽标 */
      try {
        if (fs.existsSync(filePath)) {
          let cur = fs.readFileSync(filePath, "utf-8");
          if (/^reingest:/m.test(cur)) cur = cur.replace(/^reingest:.*$/m, "reingest: pending");
          else cur = cur.replace(/^(---)(\r?\n)/m, "$1$2reingest: pending$2");
          writeFileRetry(filePath, cur);
        }
      } catch (e) { /* 标记失败不影响任务投递 */ }
      cb({ ok: true, id, file: "输出/查询/inbox/" + name, srcRel, triggered, note: triggered ? "已投递重写任务并唤醒 AI，稍后自动重写" : "重写任务已投递，等待自动化取件" });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });
}

function apiDaily(req, cb) {
  /* GET /api/daily?date=YYYY-MM-DD 读某日日常；POST /api/daily 整体写回 {date,todos,works,entries,done} */
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { date, todos, works, entries, done } = JSON.parse(body || "{}");
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return cb({ ok: false, error: "date 格式应为 YYYY-MM-DD" });
        const dir = path.join(KB_ROOT, "日常");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, date + ".md");
        const todoLines = (todos || []).map((t) => `- [${t.done ? "x" : " "}] ${String(t.text).replace(/\n/g, " ").trim()}`).filter((l) => l.length > 4);
        /* 每日工作区块：| 时间 | 工作内容 | */
        const workRows = (works || []).map((w) => `| ${w.time || ""} | ${String(w.text).replace(/\n/g, " ").trim().replace(/\|/g, "／")} |`).filter((r) => r.length > 6);
        const entryRows = (entries || []).map((e) => `| ${e.time || ""} | ${e.type === "收入" ? "收入" : "支出"} | ${e.cat || ""} | ${e.subcat || ""} | ${Number(e.amount) || 0} | ${(e.note || "").replace(/\|/g, "／")} |`);
        /* 已办结区块：| 办结日期 | 事项 | 会议纪要 | */
        const doneRows = (done || []).map((d) => `| ${d.date || date} | ${String(d.text).replace(/\n/g, " ").trim().replace(/\|/g, "／")} | ${(d.meeting || "").replace(/\|/g, "／")} |`);
        const md = `---\ndate: ${date}\ntype: daily\n---\n\n## 🛠 每日工作\n\n| 时间 | 工作内容 |\n|---|---|\n${workRows.length ? workRows.join("\n") + "\n" : "<!-- 暂无工作记录 -->\n"}\n## 📋 待办事项\n\n${todoLines.length ? todoLines.join("\n") + "\n" : "<!-- 暂无待办 -->\n"}\n## ✅ 已办结事项\n\n| 办结日期 | 事项 | 会议纪要 |\n|---|---|---|\n${doneRows.length ? doneRows.join("\n") + "\n" : "<!-- 暂无已办结 -->\n"}\n## 💰 记账手册\n\n| 时间 | 类型 | 一级分类 | 二级分类 | 金额(元) | 说明 |\n|---|---|---|---|---|---|\n${entryRows.length ? entryRows.join("\n") + "\n" : "<!-- 暂无账目 -->\n"}`;
        fs.writeFileSync(file, md, "utf-8");
        cb({ ok: true, file: "日常/" + date + ".md" });
      } catch (e) { cb({ ok: false, error: e.message }); }
    });
    return;
  }
  try {
    const date = (req.url.match(/date=(\d{4}-\d{2}-\d{2})/) || [])[1] || new Date().toISOString().slice(0, 10);
    const file = path.join(KB_ROOT, "日常", date + ".md");
    /* 全库待办索引 + 已办结索引：供跨日依赖检查（allTodos / allDone 始终返回） */
    const allTodos = [];
    const allDone = [];
    try {
      const ddir = path.join(KB_ROOT, "日常");
      for (const f of fs.readdirSync(ddir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
        const date = f.slice(0, 10);
        const t = fs.readFileSync(path.join(ddir, f), "utf-8");
        for (const line of t.split(/\r?\n/)) {
          const tm = line.match(/^-\s*\[( |x)\]\s*(.+)$/);
          if (tm) allTodos.push({ date, done: tm[1] === "x", text: tm[2].trim() });
          /* 已办结行也入索引：前置办结归档后，下游依赖仍可识别 */
          const dm = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/);
          if (dm && /^\d{4}-\d{2}-\d{2}/.test(dm[1]) && dm[2].trim() && !dm[2].includes("办结日期")) {
            allDone.push({ date: dm[1].trim(), text: dm[2].trim() });
          }
        }
      }
    } catch {}
  /* 查找与日期关联的工作日报：当日优先，没有则向前找最近一期（日报当晚 20:00 生成，当天可能尚无） */
  const report = (() => {
    const reportDir = path.join(KB_ROOT, "日常", "日报");
    if (!fs.existsSync(reportDir)) return null;
    try {
      const all = fs.readdirSync(reportDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}-日报\.md$/.test(f))
        .sort()
        .reverse();
      if (!all.length) return null;
      const exact = all.find((f) => f.startsWith(date + "-"));
      const target = exact || all.find((f) => f.slice(0, 10) <= date);
      if (!target) return null;
      return {
        rel: "日常/日报/" + target,
        date: target.slice(0, 10),
        isExact: exact ? true : false
      };
    } catch { return null; }
  })();
  if (!fs.existsSync(file)) return cb({ date, todos: [], works: [], entries: [], done: [], exists: false, allTodos, allDone, report });
    const text = fs.readFileSync(file, "utf-8");
    const todos = [];
    const works = [];
    const entries = [];
    const done = [];
    for (const line of text.split(/\r?\n/)) {
      const tm = line.match(/^-\s*\[( |x)\]\s*(.+)$/);
      if (tm) todos.push({ done: tm[1] === "x", text: tm[2].trim() });
      /* 每日工作行：| 时间 | 工作内容 |（时间可为空） */
      const wm = line.match(/^\|\s*([\d:：. ]*)\s*\|\s*([^|]+?)\s*\|$/);
      if (wm && wm[2].trim() && !wm[2].includes("工作内容")) {
        works.push({ time: wm[1].trim(), text: wm[2].trim() });
      }
      const em = line.match(/^\|\s*([\d:：.\s]*)\s*\|\s*(收入|支出)\s*\|\s*([^|]*)\s*\|\s*([^|]*)\s*\|\s*([\d.]+)\s*\|\s*([^|]*)\s*\|/);
      if (em) {
        entries.push({ time: em[1].trim(), type: em[2], cat: em[3].trim(), subcat: em[4].trim() || undefined, amount: Number(em[5]), note: em[6].trim() });
      }
      /* 已办结行：| 日期 | 事项 | 会议纪要 | */
      const dm = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/);
      if (dm && /^\d{4}-\d{2}-\d{2}/.test(dm[1]) && dm[2].trim() && !dm[2].includes("办结日期")) {
        done.push({ date: dm[1].trim(), text: dm[2].trim(), meeting: dm[3].trim() || undefined });
      }
    }
    cb({ date, todos, works, entries, done, exists: true, allTodos, allDone, report });
  } catch (e) { cb({ error: e.message }); }
}

/* GET /api/ledger?from=YYYY-MM-DD&to=YYYY-MM-DD 跨日账目查询（筛选汇总用），每条带所属日期 */
function apiLedger(from, to) {
  const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : "1970-01-01";
  const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : "2999-12-31";
  const out = [];
  try {
    const ddir = path.join(KB_ROOT, "日常");
    for (const file of fs.readdirSync(ddir)) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (!m) continue;
      const date = m[1];
      if (date < f || date > t) continue;
      const text = fs.readFileSync(path.join(ddir, file), "utf-8");
      for (const line of text.split(/\r?\n/)) {
        const em = line.match(/^\|\s*([\d:：.\s]*)\s*\|\s*(收入|支出)\s*\|\s*([^|]*)\s*\|\s*([^|]*)\s*\|\s*([\d.]+)\s*\|\s*([^|]*)\s*\|/);
        if (em) out.push({ date, time: em[1].trim(), type: em[2], cat: em[3].trim(), subcat: em[4].trim() || undefined, amount: Number(em[5]), note: em[6].trim() });
      }
    }
  } catch {}
  out.sort((a, b) => (a.date === b.date ? (a.time || "").localeCompare(b.time || "") : a.date.localeCompare(b.date)));
  return { ok: true, entries: out, total: out.length };
}

function apiMeetings() {
  /* 全库会议纪要文件列表：匹配「纪要/会议」关键词的 md 转换稿 */
  const out = [];
  const roots = [path.join(KB_ROOT, "原始素材", "文章")];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith(".md")) continue;
      if (/纪要|会议/.test(f)) {
        const rel = "原始素材/文章/" + f;
        out.push({ rel, name: f.replace(".md", "").replace(/-转换稿$/, "") });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

function apiDocs(q) {
  /* 全库 md 文档搜索（任意文档）：原始素材/文章 + 知识层 + 输出/报告；?q= 按文件名关键词过滤 */
  const ql = String(q || "").trim().toLowerCase();
  const out = [];
  const roots = [
    ["原始素材", "文章"],
    ["知识层", ""],
    ["输出", "报告"]
  ];
  for (const [d1, d2] of roots) {
    const dir = path.join(KB_ROOT, d1, d2);
    if (!fs.existsSync(dir)) continue;
    const rels = [];
    walkMds(dir, KB_ROOT, rels, skipDirs);
    for (const rel of rels) {
      const name = path.basename(rel, ".md");
      if (ql && !name.toLowerCase().includes(ql)) continue;
      out.push({ rel, name, scope: d2 ? d1 + "/" + d2 : d1 });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return out.slice(0, 300);
}

function apiMeetingsUpload(req, cb) {
  /* POST /api/meetings/upload：上传会议纪要（md/txt/docx），存到 原始素材/文章/，命名「会议纪要-日期-原名」自动入纪要索引 */
  const ct = req.headers["content-type"] || "";
  const bm = ct.match(/boundary=(.+)/);
  if (!bm) return cb({ ok: false, error: "需要 multipart/form-data" });
  const boundary = bm[1];
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      const buf = Buffer.concat(chunks);
      const str = buf.toString("binary");
      const parts = str.split("--" + boundary);
      for (const part of parts) {
        if (!part.includes("Content-Disposition")) continue;
        const hEnd = part.indexOf("\r\n\r\n");
        if (hEnd === -1) continue;
        const header = part.slice(0, hEnd);
        const fm = header.match(/filename="([^"]+)"/);
        if (!fm) continue;
        const original = Buffer.from(fm[1], "binary").toString("utf-8");
        const endMarker = "\r\n--" + boundary;
        const dataEnd = part.lastIndexOf(endMarker);
        const raw = dataEnd !== -1 ? part.slice(hEnd + 4, dataEnd) : part.slice(hEnd + 4).replace(/\r\n--\r\n$/, "").replace(/--$/, "");
        const ext = path.extname(original).toLowerCase();
        if (![".md", ".txt", ".docx"].includes(ext)) return cb({ ok: false, error: "只支持 md / txt / docx 文件" });
        const base = path.basename(original, ext).replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^\.+/, "").slice(0, 50) || "纪要";
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes());
        const saveName = "会议纪要-" + stamp + "-" + base + (ext === ".txt" ? ".md" : ext);
        const dir = path.join(KB_ROOT, "原始素材", "文章");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, saveName);
        if (ext === ".md") {
          fs.writeFileSync(filePath, Buffer.from(raw, "binary").toString("utf-8"), "utf-8");
        } else {
          fs.writeFileSync(filePath, Buffer.from(raw, "binary"));
        }
        const rel = "原始素材/文章/" + saveName;
        return cb({ ok: true, rel, name: saveName.replace(/\.(md|docx)$/i, "") });
      }
      cb({ ok: false, error: "未找到文件字段" });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });
}

function apiDailyList() {
  const dir = path.join(KB_ROOT, "日常");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.replace(".md", "")).sort().reverse();
}

function apiCategories() {
  /* 解析 日常/_分类表.md → { expense: [{cat, subs[]}], income: [{cat, subs[]}] } */
  const file = path.join(KB_ROOT, "日常", "_分类表.md");
  if (!fs.existsSync(file)) return { expense: [], income: [] };
  const text = fs.readFileSync(file, "utf-8");
  const out = { expense: [], income: [] };
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s*📥/.test(line)) { section = "expense"; continue; }
    if (/^##\s*📤/.test(line)) { section = "income"; continue; }
    if (section && line.startsWith("|") && !line.startsWith("|---") && !/^\|\s*(一级分类|——)/.test(line)) {
      const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
      if (m) {
        const cat = m[1].trim();
        const subs = m[2].split("·").map((s) => s.trim()).filter(Boolean);
        if (cat && subs.length) out[section].push({ cat, subs });
      }
    }
  }
  return out;
}

function apiTodo() {
  /* 作战清单来源：学习作战室.md（v1.1 起）→ 兼容旧名 工作台.md */
  const candidates = ["学习作战室.md", "工作台.md"];
  let p = null;
  for (const c of candidates) {
    const pp = path.join(KB_ROOT, c);
    if (fs.existsSync(pp)) { p = pp; break; }
  }
  if (!p) return [];
  const lines = fs.readFileSync(p, "utf-8").split(/\r?\n/);
  const todos = [];
  let section = "";
  for (const line of lines) {
    const sec = line.match(/^###\s+(.+)$/);
    if (sec) { section = sec[1].trim(); continue; }
    const m = line.match(/^-\s*\[( |x)\]\s*(.+)$/);
    if (m) todos.push({ done: m[1] === "x", text: m[2].replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1").trim(), section });
  }
  return todos;
}

function apiLongterm(req, cb) {
  /* 长期待办池（日常/_长期待办.md）
     GET  /api/longterm           → {ok, items:[{text,done}]}
     POST /api/longterm {text}    → 新增
     POST /api/longterm/done {text, date?} → 完结：从池移除 + 归档到当日日常文件的已办结表 */
  const file = path.join(KB_ROOT, "日常", "_长期待办.md");
  if (req.method === "GET") {
    const items = [];
    try {
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
          const m = line.match(/^-\s*\[( |x)\]\s*(.+)$/);
          if (m) items.push({ done: m[1] === "x", text: m[2].trim() });
        }
      }
    } catch {}
    return cb({ ok: true, items });
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { text, date } = JSON.parse(body || "{}");
      if (!text || !String(text).trim()) return cb({ ok: false, error: "text 必填" });
      const t = String(text).trim().replace(/\n/g, " ");
      if (!fs.existsSync(file)) fs.writeFileSync(file, `---\ntitle: 长期待办池\ntype: reference\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# 🔁 长期待办池\n\n> 不限定完成日期的待办统一放这里（跨日滚动，不会沉没）。在首页「战场状态」的长期待办模块中操作。\n> 勾选完成 → 自动归档到当日「日常/YYYY-MM-DD.md」的已办结事项。\n\n`, "utf-8");
      const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
      if (req.url.includes("/done")) {
        /* 完结：从池移除匹配项 + 归档到目标日期已办结表 */
        const out = lines.filter((l) => {
          const m = l.match(/^-\s*\[( |x)\]\s*(.+)$/);
          return !(m && m[2].trim() === t);
        });
        fs.writeFileSync(file, out.join("\n"), "utf-8");
        const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
        /* 归档：安全地在目标日常文件的已办结表插一行（不整体重写） */
        const dailyFile = path.join(KB_ROOT, "日常", d + ".md");
        if (fs.existsSync(dailyFile)) {
          let text2 = fs.readFileSync(dailyFile, "utf-8");
          const row = `| ${d} | ${t.replace(/\|/g, "／")} |  |`;
          if (/## ✅ 已办结事项/.test(text2)) {
            const secStart = text2.indexOf("## ✅ 已办结事项");
            const secEnd = text2.indexOf("\n## ", secStart + 5);
            const block = secEnd === -1 ? text2.slice(secStart) : text2.slice(secStart, secEnd);
            const headEnd = block.indexOf("|---|---|---|");
            if (headEnd !== -1) {
              const insertAfter = headEnd + "|---|---|---|".length;
              /* 若表头后是注释占位则替换，否则插行 */
              const afterHead = block.slice(headEnd + "|---|---|---|".length).replace(/^\r?\n/, "");
              if (/<!-- 暂无已办结 -->/.test(afterHead)) {
                text2 = text2.slice(0, secStart + insertAfter) + "\n" + row + "\n" + text2.slice(secStart + insertAfter).replace(/<!-- 暂无已办结 -->/, "");
              } else {
                text2 = text2.slice(0, secStart + insertAfter) + "\n" + row + text2.slice(secStart + insertAfter);
              }
            }
          } else {
            text2 += `\n## ✅ 已办结事项\n\n| 办结日期 | 事项 | 会议纪要 |\n|---|---|---|\n${row}\n`;
          }
          fs.writeFileSync(dailyFile, text2, "utf-8");
        } else {
          fs.mkdirSync(path.dirname(dailyFile), { recursive: true });
          fs.writeFileSync(dailyFile, `---\ndate: ${d}\ntype: daily\n---\n\n## 🛠 每日工作\n\n| 时间 | 工作内容 |\n|---|---|\n<!-- 暂无工作记录 -->\n\n## 📋 待办事项\n\n<!-- 暂无待办 -->\n\n## ✅ 已办结事项\n\n| 办结日期 | 事项 | 会议纪要 |\n|---|---|---|\n| ${d} | ${t.replace(/\|/g, "／")} |  |\n\n## 💰 记账手册\n\n| 时间 | 类型 | 一级分类 | 二级分类 | 金额(元) | 说明 |\n|---|---|---|---|---|---|\n<!-- 暂无账目 -->\n`, "utf-8");
        }
        return cb({ ok: true, archived: d });
      }
      /* 新增 */
      const dup = lines.some((l) => {
        const m = l.match(/^-\s*\[( |x)\]\s*(.+)$/);
        return m && m[2].trim() === t;
      });
      if (dup) return cb({ ok: true, duplicate: true, note: "该待办已存在，未重复添加" });
      const out = lines.slice();
      out.push(`- [ ] ${t}`);
      fs.writeFileSync(file, out.join("\n"), "utf-8");
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: e.message }); }
  });
}

function apiLog() {
  const p = path.join(KB_ROOT, "知识层", "_操作日志.md");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split(/\r?\n/).filter((l) => l.trim().startsWith("- ["));
}

/* 阅读器笔记持久化：按文档 rel 存到 输出/查询/notes/<base64url(rel)>.json。
   解决笔记只在内存、切页即丢的问题。GET 读 / POST 存整个 notes 数组。
   同时同步生成随笔（type: essay，Obsidian 可见可链接）：
   - 知识层文件 → 知识层/随笔/<源文档名>-随笔.md
   - 素材层文件（原始素材/ 开头）→ 原始素材/随笔/<源文档名>-随笔.md
   命名规则：同一 source 文档复用同一随笔文件；不同文档同名时追加序列号 -2/-3… 防重名。 */
function syncEssay(rel, notes) {
  try {
    const isRaw = rel.startsWith("原始素材/");
    const dir = isRaw ? path.join(KB_ROOT, "原始素材", "随笔") : path.join(KB_ROOT, "知识层", "随笔");
    fs.mkdirSync(dir, { recursive: true });
    const base = rel.split("/").pop().replace(/\.md$/i, "");
    /* 序列号防重名：先找 source==rel 的现有随笔文件（复用，保持同一文档随笔不分裂） */
    let fname = null;
    let existing = [];
    try { existing = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch {}
    const own = existing.find((f) => {
      try {
        const t = fs.readFileSync(path.join(dir, f), "utf-8").slice(0, 300);
        const m = t.match(/^source:\s*"?([^"\n]+)"?/m);
        return m && m[1].trim() === rel;
      } catch { return false; }
    });
    if (own) {
      fname = own;
    } else {
      /* 无现有随笔：基名未被占用则直接用，否则追加序列号 -2/-3… */
      let n = 1;
      const taken = new Set(existing);
      while (true) {
        const cand = base + "-随笔" + (n === 1 ? "" : "-" + n) + ".md";
        if (!taken.has(cand)) { fname = cand; break; }
        n++;
      }
    }
    const essayPath = path.join(dir, fname);
    const day = new Date().toISOString().slice(0, 10);
    const lines = [
      "---",
      "type: essay",
      `source: "${rel}"`,
      `created: ${day}`,
      `updated: ${day}`,
      "tags: [随笔]",
      "---",
      "",
      `# ${base} · 随笔`,
      "",
      "> 本文档的阅读笔记（来自工作台阅读器「📝 笔记」，存笔记自动同步）。",
      "",
      "## 📝 笔记",
      "",
    ];
    /* notes 最新在前 → 倒序后按时间正序输出（最旧在上） */
    notes.slice().reverse().forEach((n) => {
      lines.push(`### ${n.time || ""}`);
      lines.push("");
      if (n.quote) { lines.push(`> 原文：${n.quote}`); lines.push(""); }
      lines.push(n.text || "");
      lines.push("");
      lines.push("---");
      lines.push("");
    });
    writeFileRetry(essayPath, lines.join("\n"), { retries: 5, delayMs: 400 });
    return (isRaw ? "原始素材/随笔/" : "知识层/随笔/") + fname;
  } catch (e) { return ""; }
}
function apiNotes(req, cb) {
  const url = new URL(req.url, "http://localhost");
  const qRel = (url.searchParams.get("rel") || "").trim();
  if (req.method === "GET") {
    const rel = qRel;
    if (!rel) return cb({ ok: false, error: "缺少 rel" });
    const dir = path.join(KB_ROOT, "输出", "查询", "notes");
    const file = path.join(dir, Buffer.from(rel).toString("base64url") + ".json");
    try {
      if (fs.existsSync(file)) {
        const d = JSON.parse(fs.readFileSync(file, "utf-8"));
        cb({ ok: true, notes: Array.isArray(d.notes) ? d.notes : [] });
      } else cb({ ok: true, notes: [] });
    } catch (e) { cb({ ok: true, notes: [] }); }
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on("end", () => {
    try {
      const j = JSON.parse(body || "{}");
      const rel = (j.rel || qRel || "").trim();
      if (!rel) return cb({ ok: false, error: "缺少 rel" });
      const notes = Array.isArray(j.notes) ? j.notes.slice(0, 200) : [];
      const dir = path.join(KB_ROOT, "输出", "查询", "notes");
      const file = path.join(dir, Buffer.from(rel).toString("base64url") + ".json");
      fs.mkdirSync(dir, { recursive: true });
      writeFileRetry(file, JSON.stringify({ rel, updated: Date.now(), notes }, null, 1), { retries: 5, delayMs: 400 });
      const essayRel = syncEssay(rel, notes);
      cb({ ok: true, saved: notes.length, essayRel: essayRel || undefined });
    } catch (e) { cb({ ok: false, error: e.message }); }
  });
}

/* 知识层/素材层随笔列表：返回 {rel, title, updated, preview}，按更新时间倒序 */
function apiEssays() {
  const roots = [
    { dir: path.join(KB_ROOT, "知识层", "随笔"), relPrefix: "知识层/随笔/" },
    { dir: path.join(KB_ROOT, "原始素材", "随笔"), relPrefix: "原始素材/随笔/" },
  ];
  const out = [];
  for (const { dir, relPrefix } of roots) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_")); } catch (e) { continue; }
    for (const f of files) {
      try {
        const p = path.join(dir, f);
        const text = fs.readFileSync(p, "utf-8");
        const { fm, body } = parseFrontmatter(text);
        const title = (fm.title || f.replace(/\.md$/, "")).trim();
        /* 预览：取实际笔记正文（跳过头像说明 / 标题 / 时间行 / 分割线） */
        const preview = body
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("> 本文档") && !l.startsWith("# ") && l !== "## 📝 笔记" && !/^###?\s+\d{1,2}:\d{2}/.test(l) && l !== "---")
          .map((l) => l.replace(/^> 原文：/, "「").replace(/^>/, "").replace(/^###?\s*/, ""))
          .filter(Boolean)
          .slice(0, 8)
          .join(" ")
          .slice(0, 180);
        out.push({ rel: relPrefix + f, title, updated: fm.updated || "", preview });
      } catch (e) {}
    }
  }
  return out.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
}

function apiReview(req, cb) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { rel, action } = JSON.parse(body || "{}");
      if (!rel) return cb({ ok: false, error: "rel 必填" });
      const filePath = safeJoin(KB_ROOT, rel);
      if (!filePath || !fs.existsSync(filePath)) return cb({ ok: false, error: "文件不存在" });
      let text = fs.readFileSync(filePath, "utf-8");
      const to = action === "reject" ? "rejected" : "done";
      /* 确认通过（done）时清除 reingest 字段：重写流程结束，恢复普通页面 */
      if (to === "done" && /^reingest:/m.test(text)) {
        text = text.replace(/^reingest:.*(?:\r?\n|$)/m, "");
      }
      /* 精确替换 review 字段：处理 pending/done/rejected 任意现值 */
      if (/^review:\s*.+$/m.test(text)) {
        text = text.replace(/^review:\s*.+$/m, `review: ${to}`);
      } else if (/review:\s*/.test(text)) {
        text = text.replace(/review:\s*/, `review: ${to}`);
      } else {
        text = text.replace(/^---\n/, `---\nreview: ${to}\n`);
      }
      try {
        writeFileRetry(filePath, text);
      } catch (e) {
        cb({ ok: false, error: friendlyFileErr(e, filePath) });
        return;
      }
      /* 追加操作日志 */
      try {
        const logPath = path.join(KB_ROOT, "知识层", "_操作日志.md");
        const line = `- [${new Date().toLocaleString("zh-CN", { hour12: false })}] review | ${to === "done" ? "✅ 确认通过" : "🔁 打回重写"} | ${rel}\n`;
        const prev = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
        writeFileRetry(logPath, prev + line);
      } catch {}
      cb({ ok: true, rel, review: to });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });
}

function apiDraft(req, cb) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { title, content } = JSON.parse(body || "{}");
      if (!title || !content) return cb({ ok: false, error: "title/content 必填" });
      const dir = path.join(KB_ROOT, "输出", "查询", "drafts");
      fs.mkdirSync(dir, { recursive: true });
      const name = `${new Date().toISOString().slice(0, 10)}-${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}.md`;
      const file = path.join(dir, name);
      const header = `# ${title}\n\n> 头脑风暴草稿 | ${new Date().toLocaleString("zh-CN")}\n\n`;
      fs.writeFileSync(file, header + content, "utf-8");
      cb({ ok: true, file: path.relative(KB_ROOT, file) });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });
}

/* ---------- 书架 API ---------- */
function loadBooks() {
  try {
    if (fs.existsSync(BOOKS_JSON)) return JSON.parse(fs.readFileSync(BOOKS_JSON, "utf8"));
  } catch {}
  return [];
}
function saveBooks(books) {
  fs.writeFileSync(BOOKS_JSON, JSON.stringify(books, null, 2), "utf8");
}

function apiBookshelf() {
  return loadBooks();
}

function apiBookshelfUpload(req, cb) {
  const ct = req.headers["content-type"] || "";
  const bm = ct.match(/boundary=(.+)/);
  if (!bm) return cb({ ok: false, error: "需要 multipart/form-data" });
  const boundary = bm[1];
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      const buf = Buffer.concat(chunks);
      const str = buf.toString("binary");
      const parts = str.split("--" + boundary);
      for (const part of parts) {
        if (!part.includes("Content-Disposition")) continue;
        const hEnd = part.indexOf("\r\n\r\n");
        if (hEnd === -1) continue;
        const header = part.slice(0, hEnd);
        const fm = header.match(/filename="([^"]+)"/);
        if (!fm) continue;
        const original = Buffer.from(fm[1], "binary").toString("utf-8");
        const endMarker = "\r\n--" + boundary;
        const dataEnd = part.lastIndexOf(endMarker);
        const raw = dataEnd !== -1 ? part.slice(hEnd + 4, dataEnd) : part.slice(hEnd + 4).replace(/\r\n--\r\n$/, "").replace(/--$/, "");
        const ext = path.extname(original).toLowerCase();
        if (ext !== ".pdf" && ext !== ".txt") return cb({ ok: false, error: "只支持 PDF / TXT 文件" });
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const saveName = id + (ext === ".pdf" ? ".pdf" : ".md");
        const booksDir = path.join(BOOKSHELF_DIR, "books");
        if (!fs.existsSync(booksDir)) fs.mkdirSync(booksDir, { recursive: true });
        const filePath = path.join(booksDir, saveName);
        // Convert binary string back to Buffer for writing
        const dataBuf = Buffer.from(raw, "binary");
        if (ext === ".txt") {
          /* TXT → Markdown 自动转换：编码探测 + 章节识别 + 空行清理 */
          fs.writeFileSync(filePath, txtToMd(original, dataBuf), "utf-8");
        } else {
          fs.writeFileSync(filePath, dataBuf);
        }
        const books = loadBooks();
        const title = original.replace(/\.(pdf|txt)$/i, "").replace(/[-_]/g, " ").replace(/^\.+/, "").slice(0, 80) || "未命名";
        const book = {
          id, title, author: "", filename: original, type: ext === ".txt" ? "txt" : "pdf",
          filepath: path.relative(KB_ROOT, filePath).replace(/\\/g, "/"),
          status: "unread", progress: 0, pages: 0, currentPage: 0,
          addedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
          tags: [], notes: ""
        };
        books.push(book);
        saveBooks(books);
        return cb({ ok: true, book });
      }
      cb({ ok: false, error: "未找到文件字段" });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });
}

/* TXT 编码探测：优先严格 UTF-8，失败回退 GB18030（兼容 GBK/GB2312 中文 txt） */
function decodeTxt(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder("gb18030").decode(buf); } catch {}
  return buf.toString("utf-8");
}

/* TXT → Markdown：章节识别（第X章/第X节/第X回/Chapter/数字编号标题）、空行清理、段落合并 */
function txtToMd(original, buf) {
  let text = decodeTxt(buf);
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let blank = 0;
  for (let line of lines) {
    line = line.replace(/\s+$/, "");
    if (!line.trim()) { blank++; if (blank >= 2) continue; out.push(""); continue; }
    blank = 0;
    const t = line.trim();
    /* 章节标题：整行短（≤40 字）且匹配 第X章/第X节/第X回/卷X/Chapter/Part/楔子/序章/番外/数字编号 */
    if (t.length <= 40 &&
        /^(第\s*[0-9一二三四五六七八九十百千万零〇]+\s*[章节回卷部篇集][^：:]{0,30}|[卷部]\s*[一二三四五六七八九十]+\s*[^：:]{0,30}|(Chapter|Part)\s+\d+[^:]{0,40}|楔子|序章|序言|前言|引言|尾声|结语|番外(篇)?[^：:]{0,20}|[0-9]{1,3}\s*[、.．]\s*\S{0,30})$/i.test(t)) {
      out.push("", "## " + t, "");
      continue;
    }
    out.push(line);
  }
  const cleaned = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  const title = original.replace(/\.txt$/i, "").replace(/[-_]/g, " ").slice(0, 80);
  return `---\ntitle: ${title}\ntype: book\n---\n\n${cleaned}\n`;
}

function apiBookshelfProgress(req, cb) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { id, status, currentPage, pages, progress } = JSON.parse(body || "{}");
      if (!id) return cb({ ok: false, error: "缺少 id" });
      const books = loadBooks();
      const book = books.find((b) => b.id === id);
      if (!book) return cb({ ok: false, error: "未找到书籍" });
      if (status) {
        book.status = status;
        if (status === "reading" && !book.startedAt) book.startedAt = new Date().toISOString();
        if (status === "done") { book.finishedAt = new Date().toISOString(); book.progress = 100; }
      }
      if (currentPage !== undefined) {
        book.currentPage = currentPage;
        if (book.pages > 0) book.progress = Math.round((currentPage / book.pages) * 100);
      }
      if (pages !== undefined) book.pages = pages;
      if (progress !== undefined) book.progress = progress;
      saveBooks(books);
      cb({ ok: true, book });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });
}

/* ---------- Server ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { p = u.pathname; }
  try {
    if (p.startsWith("/api/")) {
      if (p === "/api/stats") return readJson(res, apiStats());
      if (p === "/api/files") return readJson(res, apiFiles(u.searchParams.get("type")));
      if (p === "/api/file") {
        if (req.method === "POST") return apiFileSave(req, (r) => readJson(res, r));
        const f = apiFile(u.searchParams.get("path") || "");
        if (!f) return readJson(res, { error: "not found" });
        return readJson(res, f);
      }
      if (p === "/api/search") return readJson(res, apiSearch(u.searchParams.get("q") || "", u.searchParams.get("scope")));
      if (p === "/api/search-index") return readJson(res, apiSearchIndex());
      if (p === "/api/graph") return readJson(res, apiGraph());
      if (p === "/api/navigation") return readJson(res, apiNavigation(u.searchParams.get("from"), u.searchParams.get("to")));
      if (p === "/api/hotspots") return readJson(res, apiHotspots());
      if (p === "/api/related") return readJson(res, apiRelated(u.searchParams.get("path") || ""));
      if (p === "/api/inbox") return readJson(res, apiInbox());
      if (p === "/api/answers") return readJson(res, apiAnswers());
      if (p === "/api/answers/ingest") return apiAnswersIngest(req, (r) => readJson(res, r));
      if (p === "/api/ask") return apiAsk(req, (r) => readJson(res, r));
      if (p === "/api/trigger") return apiTrigger(req, (r) => readJson(res, r));
      if (p === "/api/reingest") return apiReingest(req, (r) => readJson(res, r));
      if (p === "/api/todo") return readJson(res, apiTodo());
      if (p === "/api/longterm" || p === "/api/longterm/done") return apiLongterm(req, (r) => readJson(res, r));
      if (p === "/api/log") return readJson(res, apiLog());
      if (p === "/api/notes") return apiNotes(req, (r) => readJson(res, r));
      if (p === "/api/essays") return readJson(res, apiEssays());
      if (p === "/api/draft") return apiDraft(req, (r) => readJson(res, r));
      if (p === "/api/review") return apiReview(req, (r) => readJson(res, r));
      if (p === "/api/daily") return apiDaily(req, (r) => readJson(res, r));
      if (p === "/api/daily/list") return readJson(res, apiDailyList());
      if (p === "/api/ledger") return readJson(res, apiLedger(u.searchParams.get("from"), u.searchParams.get("to")));
      if (p === "/api/categories") return readJson(res, apiCategories());
      if (p === "/api/meetings") return readJson(res, apiMeetings());
      if (p === "/api/meetings/upload") return apiMeetingsUpload(req, (r) => readJson(res, r));
      if (p === "/api/docs") return readJson(res, apiDocs(u.searchParams.get("q")));
      if (p === "/api/bookshelf") return readJson(res, apiBookshelf());
      if (p === "/api/bookshelf/upload") return apiBookshelfUpload(req, (r) => readJson(res, r));
      if (p === "/api/bookshelf/progress") return apiBookshelfProgress(req, (r) => readJson(res, r));
      return readJson(res, { error: "unknown api" });
    }
    /* 静态文件：工作台资源（style.css/app.js/assets/…）+ 知识库只读文件（原始素材/图片等，供素材库预览） */
    const KB_ROOTS = ["原始素材", "知识层", "输出", "AI研究", "V1.1", "日常", "制度文件", "信易贷", "书架"];
    const seg = p.split("/")[1] || "";
    let filePath;
    if (KB_ROOTS.includes(seg)) {
      const kbPath = safeJoin(KB_ROOT, p.slice(1));
      if (kbPath && fs.existsSync(kbPath) && fs.statSync(kbPath).isFile()) {
        filePath = kbPath;
      } else {
        res.writeHead(404); return res.end("not found");
      }
    } else {
      filePath = path.join(APP_DIR, p === "/" ? "index.html" : p);
      if (!filePath.startsWith(APP_DIR)) { res.writeHead(403); return res.end("forbidden"); }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(APP_DIR, "index.html");
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    /* 工作台前端资源不缓存，避免改版后浏览器仍用旧文件（配合 index.html 的 ?v= 版本参数） */
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (seg === "工作台" || !KB_ROOTS.includes(seg)) {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Server Error: " + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`🗺 AI 知识工作台 → http://localhost:${PORT}`);
  console.log(`   知识库: ${KB_ROOT}`);
});
