#!/usr/bin/env node
/**
 * 数据要素知识工作台 — 本地服务（零依赖）
 * 静态文件 + 知识库 API。启动：node server.js [port]
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL } = require("url");

/* 知识库根目录：优先环境变量 WB_KB_ROOT（App 打包用），其次端口参数旁默认值 */
const KB_ROOT = process.env.WB_KB_ROOT || "__KB_ROOT__";
const APP_DIR = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const AI_SERVICE_AUTOMATION_ID = "automation-1786021150970"; // 「🤖 工作台 AI 对话服务」

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
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
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
        let v = kv[2].trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        if (v === "true") v = true;
        else if (v === "false") v = false;
        fm[kv[1]] = v;
        curKey = kv[1];
      } else if (curKey && /^\s*-\s+/.test(line)) {
        /* YAML 数组续行：key: 之后跟 - item 行（如 source: 多来源） */
        const item = line.replace(/^\s*-\s+/, "").trim().replace(/^"(.*)"$/, "$1");
        if (Array.isArray(fm[curKey])) fm[curKey].push(item);
        else if (fm[curKey] !== undefined && fm[curKey] !== "") fm[curKey] = [fm[curKey], item];
        else fm[curKey] = [item];
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
  out.sort((a, b) => b.mtime - a.mtime);
}

function collectWikiLinks(text) {
  const links = new Set();
  const re = /\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(text))) links.add(m[1].trim());
  return [...links];
}

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
  const counts = { source: 0, concept: 0, entity: 0, comparison: 0, synthesis: 0, template: 0, topic: 0 };
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
        else if (parent === "_模板") counts.template++;
        else if (parent === "主题") counts.topic++;
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
  for (const d of ["素材摘要", "概念", "实体", "对比", "综述"]) {
    const dir = path.join(wiki, d);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".md") || f.startsWith("_")) continue;
      try {
        const head = fs.readFileSync(path.join(dir, f), "utf-8").slice(0, 400);
        if (/review:\s*pending/.test(head)) {
          const title = (head.match(/^title:\s*(.+)$/m) || [])[1] || f.replace(/\.md$/, "");
          pendingReviewList.push({ rel: "知识层/" + d + "/" + f, title: title.trim().replace(/^["']|["']$/g, "") });
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
  return out;
}

function apiFile(rel) {
  const p = safeJoin(KB_ROOT, rel);
  if (!p || !fs.existsSync(p) || !p.endsWith(".md")) return null;
  const text = fs.readFileSync(p, "utf-8");
  const { fm, body } = parseFrontmatter(text);
  const links = collectWikiLinks(body);
  return { rel, fm, body, links, size: text.length };
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
    const content = body.replace(/[#*`>\-\[\]()!|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
    docs.push({ id: rel, title, content, tags, type: fm.type || "page", rel });
  }
  _searchIndexCache = docs;
  _searchIndexCacheTime = Date.now();
  return docs;
}

function apiGraph() {
  if (_graphCache && Date.now() - _graphCacheTime < CACHE_TTL) return _graphCache;
  const wiki = path.join(KB_ROOT, "知识层");
  const nodes = [];
  const nodeMap = {};
  const links = [];
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
    const links2 = collectWikiLinks(text);
    links2.forEach((tgt) => {
      const name = path.basename(tgt, ".md");
      if (byName[name] && byName[name] !== rel) {
        links.push({ source: rel, target: byName[name] });
      }
    });
  });
  _graphCache = { nodes, links };
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

function apiAsk(req, cb) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { question, context } = JSON.parse(body || "{}");
      if (!question || !question.trim()) return cb({ ok: false, error: "question 必填" });
      const dir = path.join(KB_ROOT, "输出", "查询", "inbox");
      fs.mkdirSync(dir, { recursive: true });
      const id = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(Date.now()).slice(-6);
      const name = id + ".md";
      const file = path.join(dir, name);
      const ctx = (context || "").trim().slice(0, 8000);
      let header = `---\nid: ${id}\nstatus: pending\naskedAt: ${new Date().toLocaleString("zh-CN", { hour12: false })}\nquestion: "${question.replace(/"/g, "'").slice(0, 120)}"\n`;
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
    if (!fs.existsSync(file)) return cb({ date, todos: [], works: [], entries: [], done: [], exists: false, allTodos, allDone });
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
    cb({ date, todos, works, entries, done, exists: true, allTodos, allDone });
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

function apiLog() {
  const p = path.join(KB_ROOT, "知识层", "_操作日志.md");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split(/\r?\n/).filter((l) => l.trim().startsWith("- ["));
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
        const f = apiFile(u.searchParams.get("path") || "");
        if (!f) return readJson(res, { error: "not found" });
        return readJson(res, f);
      }
      if (p === "/api/search") return readJson(res, apiSearch(u.searchParams.get("q") || "", u.searchParams.get("scope")));
      if (p === "/api/search-index") return readJson(res, apiSearchIndex());
      if (p === "/api/graph") return readJson(res, apiGraph());
      if (p === "/api/hotspots") return readJson(res, apiHotspots());
      if (p === "/api/related") return readJson(res, apiRelated(u.searchParams.get("path") || ""));
      if (p === "/api/inbox") return readJson(res, apiInbox());
      if (p === "/api/answers") return readJson(res, apiAnswers());
      if (p === "/api/ask") return apiAsk(req, (r) => readJson(res, r));
      if (p === "/api/trigger") return apiTrigger(req, (r) => readJson(res, r));
      if (p === "/api/todo") return readJson(res, apiTodo());
      if (p === "/api/log") return readJson(res, apiLog());
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
  console.log(`🗺 数据要素知识工作台 → http://localhost:${PORT}`);
  console.log(`   知识库: ${KB_ROOT}`);
});
