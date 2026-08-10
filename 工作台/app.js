/* __USER_NAME__的专属工作台 — 前端逻辑 */
"use strict";

const $ = (s) => document.querySelector(s);
const API = "";
const TYPE_COLOR = { concept: "#7c3aed", source: "#0891b2", entity: "#16a34a", comparison: "#d97706", synthesis: "#dc2626", page: "#8b84ab", topic: "#6f4cff" };
const TYPE_CN = { concept: "概念", source: "素材摘要", entity: "实体", comparison: "对比", synthesis: "综述", page: "页面", topic: "主题", template: "模板" };

const PAGES = {
  dashboard: { t: "总览 Dashboard", c: "知识库全景 · 战场状态" },
  graph: { t: "知识星图", c: "概念 / 实体 / 素材 关系网络" },
  library: { t: "素材库", c: "原始素材 · 625 篇转换稿" },
  hotspots: { t: "每日热点", c: "AI 资讯自动补给线 · 每天 8 点更新" },
  wiki: { t: "知识层", c: "AI 编译的知识网络 · 概念 / 实体 / 摘要 / 对比 / 综述" },
  brainstorm: { t: "头脑风暴", c: "读库 → 追问 → 写回的知识复利闭环" },
  ai: { t: "AI 对话", c: "信箱桥 · 提问入箱 → Agent 读库回答 → 写回" },
  daily: { t: "__USER_NAME__的日常", c: "每日工作 + 记账" },
  todo: { t: "每日工作", c: "__USER_NAME__的日常 · 每日工作 + 待办事项（智能排期 · 依赖链）" },
  ledger: { t: "记账", c: "__USER_NAME__的日常 · 记账手册（一二级分类联动）" },
  studio: { t: "方案工坊", c: "方案组件 + 实战产出" },
  archive: { t: "运行档案", c: "操作日志时间线" },
  bookshelf: { t: "书架", c: "本地 PDF / TXT 导入 · 待读→在读→已读 · 阅读追踪" },
};

/* ---------- 路由 ---------- */
let currentPage = "dashboard";
let currentRel = null;
let backStack = []; // 页面浏览历史栈：记录"从哪个页面跳转而来"，供返回按钮回溯

function navigate(page) {
  currentPage = page;
  currentRel = null;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.page === page));
  $("#pageTitle").textContent = PAGES[page].t;
  $("#pageCrumb").textContent = PAGES[page].c;
  if (location.hash !== "#/" + page) history.replaceState(null, "", "#/" + page);
  renderPage(page);
}

/* ---------- 侧边栏收起/展开 ---------- */
let sideUserExpanded = false; // 用户手动展开过（阅读时不再强制收起）
function collapseSidebar() {
  document.body.classList.add("side-collapsed");
}
function expandSidebar() {
  document.body.classList.remove("side-collapsed");
}
function initSidebar() {
  const saved = localStorage.getItem("wbSidebar");
  if (saved === "collapsed") { collapseSidebar(); sideUserExpanded = false; }
  else if (saved === "expanded") { expandSidebar(); sideUserExpanded = true; }
  $("#sideCollapse").addEventListener("click", () => {
    collapseSidebar();
    sideUserExpanded = false;
    localStorage.setItem("wbSidebar", "collapsed");
  });
  $("#sideExpand").addEventListener("click", () => {
    expandSidebar();
    sideUserExpanded = true;
    localStorage.setItem("wbSidebar", "expanded");
  });
}
/* 阅读素材时默认收起（若用户手动展开过则尊重用户） */
function autoCollapseForReading() {
  if (!sideUserExpanded) collapseSidebar();
}

window.addEventListener("hashchange", () => {
  const h = location.hash.replace("#/", "");
  if (PAGES[h]) navigate(h);
  else if (h.startsWith("file/")) openFile(decodeURIComponent(h.slice(5)));
});

/* ---------- d3 懒加载（仅知识星图页面需要）---------- */
let d3LoadPromise = null;
function loadD3() {
  if (window.d3) return Promise.resolve(window.d3);
  if (d3LoadPromise) return d3LoadPromise;
  d3LoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js";
    script.onload = () => resolve(window.d3);
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return d3LoadPromise;
}

/* ---------- API ---------- */
async function api(path) {
  const r = await fetch(API + path);
  return r.json();
}

/* ---------- MiniSearch 全文搜索引擎 ---------- */
let miniSearch = null;
let miniSearchLoading = null;

function cnTokenizer(text) {
  const tokens = [];
  text.split(/[\s,，。；;：:、！!？?（）()「」【】\-—…·\n\r\t|/\\]+/).forEach((word) => {
    word = word.toLowerCase().trim();
    if (!word) return;
    if (/[\u4e00-\u9fa5]/.test(word)) {
      for (let i = 0; i < word.length; i++) {
        tokens.push(word[i]);
        if (i < word.length - 1) tokens.push(word.slice(i, i + 2));
      }
    } else {
      tokens.push(word);
    }
  });
  return tokens;
}

async function getSearchIndex() {
  if (miniSearch) return miniSearch;
  if (miniSearchLoading) return miniSearchLoading;
  miniSearchLoading = (async () => {
    const docs = await api("/api/search-index");
    miniSearch = new MiniSearch({
      fields: ["title", "content", "tags"],
      storeFields: ["title", "type", "rel", "tags", "content"],
      idField: "id",
      tokenize: cnTokenizer,
      searchOptions: {
        boost: { title: 4, tags: 2 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: "AND",
      },
    });
    miniSearch.addAll(docs);
    return miniSearch;
  })();
  return miniSearchLoading;
}

function highlightText(text, terms) {
  if (!text) return "";
  let result = esc(text);
  terms.forEach((term) => {
    if (term.length < 2) return;
    const re = new RegExp("(" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    result = result.replace(re, "<mark>$1</mark>");
  });
  return result;
}

function buildSnippet(content, terms, maxLen = 120) {
  if (!content) return "";
  const lower = content.toLowerCase();
  let bestIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx < 0) return esc(content.slice(0, maxLen)) + (content.length > maxLen ? "…" : "");
  const s = Math.max(0, bestIdx - 40);
  const snippet = content.slice(s, s + maxLen);
  return (s > 0 ? "…" : "") + highlightText(snippet, terms) + (s + maxLen < content.length ? "…" : "");
}

async function doSearch(q, opts = {}) {
  const idx = await getSearchIndex();
  const results = idx.search(q, {
    boost: { title: 4, tags: 2 },
    fuzzy: 0.2,
    prefix: true,
    combineWith: opts.combineWith || "AND",
    filter: opts.filter || null,
  });
  return results.slice(0, opts.limit || 30);
}

function extractTerms(q) {
  return cnTokenizer(q).filter((t) => t.length >= 2 || /[\u4e00-\u9fa5]/.test(t));
}

/* ---------- Markdown 渲染 ---------- */
function mdToHtml(md, baseDir) {
  if (!md) return "";
  let body = md;
  /* Obsidian 图片语法 ![[文件名.png]] → 工作台内联渲染
     baseDir: 当前阅读文件所在目录（如 原始素材/ppt/前缀/），图片从该目录解析 */
  const imgBase = baseDir ? baseDir.replace(/\/?$/, "/") : "原始素材/图片/";
  const imgFallback = "原始素材/图片/";
  body = body.replace(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (m, name) => {
    const clean = name.trim().replace(/\.md$/, "");
    if (/\.(png|jpg|jpeg|webp|gif|svg)$/i.test(clean)) {
      const primary = "/" + encodeURIComponent(imgBase + clean);
      const fb = "/" + encodeURIComponent(imgFallback + clean);
      const onerr = imgBase === imgFallback ? "" : ` onerror="this.onerror=null;this.src='${fb}';"`;
      return `<img class="obs-img" src="${primary}" alt="${esc(clean)}"${onerr}>`;
    }
    return m;
  });
  body = body.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a class="wikilink" data-t="$1">$2</a>');
  body = body.replace(/\[\[([^\]|]+)\]\]/g, '<a class="wikilink" data-t="$1">$1</a>');
  /* 原始素材裸路径 → 可点击来源链接（.md 打开转换稿 / 图片 lightbox 预览）
     lookbehind 排除 wikilink 的 data-t 属性值；惰性匹配到扩展名，兼容文件名中的中文括号 */
  body = body.replace(/(?<!data-t=")(原始素材\/[^\s<>]+?\.(?:md|png|jpg|jpeg|webp|gif|svg))/g, (m) => `<a class="src-link" data-rel="${esc(m)}">${esc(m)}</a>`);
  const html = marked.parse(body, { breaks: true, gfm: true });
  return html;
}

function renderFm(fm) {
  if (!fm || !Object.keys(fm).length) return "";
  const chips = [];
  if (fm.title) chips.push(`<span class="fm-chip">标题：${esc(fm.title)}</span>`);
  if (fm.type) chips.push(`<span class="fm-chip">类型：${TYPE_CN[fm.type] || fm.type}</span>`);
  if (fm.tags && Array.isArray(fm.tags)) chips.push(...fm.tags.slice(0, 6).map((t) => `<span class="fm-chip">#${esc(t)}</span>`));
  if (fm.confidence) chips.push(`<span class="fm-chip">置信度：${fm.confidence}</span>`);
  if (fm.created) chips.push(`<span class="fm-chip">创建：${fm.created}</span>`);
  return `<div class="fm-chips">${chips.join("")}</div>`;
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* 返回 rel 的目录部分（不含文件名），用于解析同目录图片 */
function relDir(rel) {
  const i = (rel || "").lastIndexOf("/");
  return i > 0 ? rel.slice(0, i) : "";
}

/* ---------- 来源素材（知识层 → 原始素材 溯源链接） ---------- */
/* 展开来源路径：支持单文件 与 通配（xxx-1~12.png → xxx-1.png … xxx-12.png） */
function expandSource(src) {
  const s = String(src || "").trim();
  if (!s) return [];
  const m = s.match(/^(.*)-(\d+)~(\d+)\.([A-Za-z0-9]+)$/);
  if (m) {
    const out = [];
    for (let i = +m[2]; i <= +m[3]; i++) out.push(`${m[1]}-${i}.${m[4]}`);
    return out;
  }
  return [s];
}
function isImgRel(rel) { return /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(rel); }

/* frontmatter source → 来源素材区块 HTML（.md 链接 + 图片缩略图网格，支持 1~12 通配展开）
   body 兜底：frontmatter 未解析出 source 时（旧服务端），从正文"来源："行提取路径 */
function extractSourceFromBody(body) {
  if (!body) return [];
  const re = /(原始素材\/[^\s<>]+?\.(?:md|png|jpg|jpeg|webp|gif|svg))/g;
  return body.match(re) || [];
}
function sourceBlockHtml(fm, body) {
  const raw = fm && fm.source;
  let sources = [];
  if (raw && raw !== "") (Array.isArray(raw) ? raw : [raw]).forEach((s) => sources.push(s));
  else sources = extractSourceFromBody(body);
  if (!sources.length) return "";
  const files = [];
  sources.forEach((s) => expandSource(s).forEach((p) => files.push(p)));
  if (!files.length) return "";
  const mds = files.filter((p) => p.endsWith(".md"));
  const imgs = files.filter(isImgRel);
  const mdHtml = mds.length
    ? `<div class="src-mds">${mds.map((p) => `<a class="src-md" data-rel="${esc(p)}" title="${esc(p)}">📄 ${esc(p.split("/").pop())}</a>`).join("")}</div>`
    : "";
  const imgsHtml = imgs.length
    ? `<div class="src-thumbs" data-list="${esc(JSON.stringify(imgs))}">${imgs.map((p) => `<img class="src-thumb" src="/${esc(p)}" alt="" loading="lazy" onerror="this.style.display='none'">`).join("")}</div>`
    : "";
  if (!mdHtml && !imgsHtml) return "";
  return `<div class="src-block">
    <div class="src-block-h">🧩 来源素材（${files.length}）</div>
    ${mdHtml}${imgsHtml}
  </div>`;
}

/* ---------- 阅读器 ---------- */
/* 阅读字号控制（localStorage 记忆，默认 17px 适合阅读） */
let readerFontSize = Number(localStorage.getItem("wbReaderFont") || 17);
function applyReaderFont() {
  document.querySelectorAll(".reader").forEach((r) => { r.style.fontSize = readerFontSize + "px"; });
}
/* 双栏阅读器：左 = 文件内容，右 = AI 检索台（提问搜全库 + 本文相关 + 认知写回）*/
function renderReaderWithAI(el, rel, f, opts = {}) {
  autoCollapseForReading();
  /* 阅读模式：放大阅览框（收起左侧文件树） */
  const splitHost = el.closest ? el.closest(".split") : null;
  if (splitHost) splitHost.classList.add("reading");
  if (opts.pane) { el.style.padding = "0"; el.style.overflow = "hidden"; }
  const title = f.fm.title || rel.split("/").pop().replace(".md", "");
  el.innerHTML = `
    <div class="ai-split">
      <div class="ai-doc">
        <div class="read-toolbar">
          ${splitHost ? `<button class="btn ghost read-back" style="padding:5px 12px;font-size:12px;">← 返回列表</button>` : ""}
          <span class="read-title" title="${esc(rel)}">${esc(title)}</span>
          <div class="read-font">
            <button id="fontMinus" title="减小字号">A−</button>
            <span id="fontVal">${readerFontSize}px</span>
            <button id="fontPlus" title="增大字号">A+</button>
          </div>
        </div>
        <div class="fm-line mono" style="margin-bottom:8px;">${esc(rel)}</div>
        ${renderFm(f.fm)}
        <div class="reader">${mdToHtml(f.body, relDir(rel))}</div>
        ${sourceBlockHtml(f.fm, f.body)}
        ${f.links && f.links.length ? `<div style="margin-top:20px;border-top:1px solid var(--line);padding-top:12px;font-size:12px;color:var(--text3);">🔗 出链 ${f.links.length}：${f.links.map((l) => `<a class="wikilink" data-t="${esc(l)}">${esc(l)}</a>`).join(" · ")}</div>` : ""}
      </div>
      <aside class="ai-panel">
        <div class="panel-tabs">
          <button class="ptab active" data-tab="note">📝 笔记</button>
          <button class="ptab" data-tab="understand">💡 理解</button>
          <button class="ptab" data-tab="ingest">📥 入库</button>
        </div>

        <div class="ptab-pane" data-pane="note">
          <div class="ai-sec-h">📝 文档笔记</div>
          <p class="ai-panel-d">选中正文后点「存笔记」自动带原文引用；也可直接手写。</p>
          <div class="sel-chip" id="curSel" style="display:none;"></div>
          <div id="noteList"></div>
          <textarea class="brain-input" id="noteInput" placeholder="新建笔记…" style="min-height:64px;font-size:12px;margin-top:10px;"></textarea>
          <button class="btn" id="noteAdd" style="margin-top:8px;width:100%;">💾 存笔记</button>
        </div>

        <div class="ptab-pane" data-pane="understand" style="display:none;">
          <div class="ai-sec-h">💡 原文理解</div>
          <p class="ai-panel-d">选中正文 → 提问（可不填，AI 直接解释原文）→ 发送本地 Agent。</p>
          <div class="sel-quote" id="selQuote">← 先在左侧正文选中一段文字</div>
          <textarea class="brain-input" id="myQuestion" placeholder="我对这段话的疑问是……（可不填，AI 会直接解释原文）" style="min-height:56px;font-size:12px;margin-top:8px;"></textarea>
          <button class="btn" id="askBtn" style="margin-top:8px;width:100%;background:#2c2450;">🚀 发送给本地 Agent</button>
          <div id="aiUnd" style="margin-top:10px;font-size:12px;color:var(--text3);line-height:1.7;"></div>
          <div class="ai-sec">
            <div class="ai-sec-h" id="askSecH">📜 提问记录（0）</div>
            <div id="askList"></div>
          </div>
          <div class="ai-sec">
            <div class="ai-sec-h">🔍 全库检索</div>
            <div style="display:flex;gap:6px;">
              <input class="brain-input" id="aiQ" placeholder="关键词检索全库…" style="min-height:0;padding:8px 10px;font-size:12px;">
              <button class="btn" id="aiGo" style="padding:8px 12px;white-space:nowrap;">搜</button>
            </div>
            <div id="aiRes"></div>
          </div>
          <div class="ai-sec" id="aiRel"></div>
        </div>

        <div class="ptab-pane" data-pane="ingest" style="display:none;">
          <div class="ai-sec-h">📥 手动入库审查</div>
          <p class="ai-panel-d">汇总本篇的笔记与理解结果，一键入库到 输出/查询/drafts/。</p>
          <div id="ingestTable"></div>
          <input class="brain-input" id="ingestTitle" placeholder="入库标题（默认：文件名-阅读笔记）" style="min-height:0;padding:8px 10px;font-size:12px;margin-top:8px;">
          <button class="btn" id="ingestBtn" style="margin-top:8px;width:100%;">📥 入库</button>
          <div id="ingestMsg" style="margin-top:8px;font-size:12px;"></div>
        </div>
      </aside>
    </div>`;
  bindReaderAI(el, rel, f.body);
  bindWikiLinks();
  el.scrollTop = 0;
}

function bindReaderAI(el, rel, body) {
  /* 阅读工具条：返回列表 + 字号调节 */
  const backBtn = el.querySelector(".read-back");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      const splitHost = el.closest ? el.closest(".split") : null;
      if (splitHost) splitHost.classList.remove("reading");
      else if (typeof goBack === "function") goBack();
    });
  }
  const fontMinus = el.querySelector("#fontMinus");
  const fontPlus = el.querySelector("#fontPlus");
  const fontVal = el.querySelector("#fontVal");
  if (fontMinus) fontMinus.addEventListener("click", () => { readerFontSize = Math.max(13, readerFontSize - 1); setReaderFont(); });
  if (fontPlus) fontPlus.addEventListener("click", () => { readerFontSize = Math.min(24, readerFontSize + 1); setReaderFont(); });
  function setReaderFont() {
    localStorage.setItem("wbReaderFont", String(readerFontSize));
    if (fontVal) fontVal.textContent = readerFontSize + "px";
    const docEl = el.querySelector(".ai-doc");
    if (docEl) { const r = docEl.querySelector(".reader"); if (r) r.style.fontSize = readerFontSize + "px"; }
  }
  applyReaderFont();
  const res = el.querySelector("#aiRes");
  const qEl = el.querySelector("#aiQ");
  const relBox = el.querySelector("#aiRel");
  const undEl = el.querySelector("#aiUnd");
  const doc = el.querySelector(".ai-doc");

  /* ---------- 三模块：笔记 / 理解 / 入库 ---------- */
  /* 阅读会话状态（按文件缓存） */
  if (!el._rs) el._rs = { notes: [], quotes: [] }; // notes: {text, quote, time}; quotes: {quote, q, answer, time}
  const rs = el._rs;
  let curSelText = "";

  /* Tab 切换 */
  el.querySelectorAll(".ptab").forEach((t) => t.addEventListener("click", () => {
    el.querySelectorAll(".ptab").forEach((x) => x.classList.toggle("active", x === t));
    el.querySelectorAll(".ptab-pane").forEach((p) => { p.style.display = p.dataset.pane === t.dataset.tab ? "" : "none"; });
  }));
  function switchTab(tab) {
    el.querySelectorAll(".ptab").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
    el.querySelectorAll(".ptab-pane").forEach((p) => { p.style.display = p.dataset.pane === tab ? "" : "none"; });
  }

  /* 选区监听：选中正文 → 同步到笔记(curSel)和理解(selQuote) */
  const selQuote = el.querySelector("#selQuote");
  const curSel = el.querySelector("#curSel");
  const onSel = () => {
    const t = getSelText();
    curSelText = (t && t.length >= 2) ? t : "";
    if (curSelText) {
      selQuote.textContent = "「" + curSelText.slice(0, 90) + (curSelText.length > 90 ? "…" : "") + "」";
      selQuote.classList.add("has");
      curSel.textContent = "已选：" + curSelText.slice(0, 40) + (curSelText.length > 40 ? "…" : "");
      curSel.style.display = "";
    } else {
      selQuote.textContent = "← 先在左侧正文选中一段文字";
      selQuote.classList.remove("has");
      curSel.style.display = "none";
    }
  };
  doc.addEventListener("mouseup", () => setTimeout(onSel, 10));
  doc.addEventListener("keyup", onSel);

  /* 笔记：渲染 + 新增 */
  const noteList = el.querySelector("#noteList");
  function renderNotes() {
    noteList.innerHTML = rs.notes.length ? rs.notes.map((n, i) => `
      <div class="note-card">
        ${n.quote ? `<div class="note-quote">${esc(n.quote)}</div>` : ""}
        <div class="note-text">${esc(n.text)}</div>
        <div class="note-meta">${n.time} <span class="note-del" data-i="${i}">删除</span></div>
      </div>`).join("") : `<div class="note-empty">暂无笔记，选中正文或手写一条</div>`;
    noteList.querySelectorAll(".note-del").forEach((d) => d.addEventListener("click", () => { rs.notes.splice(Number(d.dataset.i), 1); renderNotes(); if (typeof el._renderIngest === "function") el._renderIngest(); }));
  }
  renderNotes();
  el.querySelector("#noteAdd").addEventListener("click", () => {
    const txt = el.querySelector("#noteInput").value.trim();
    if (!txt) { el.querySelector("#noteInput").focus(); return; }
    rs.notes.unshift({ text: txt, quote: curSelText || "", time: new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5) });
    el.querySelector("#noteInput").value = "";
    curSelText = ""; curSel.style.display = "none";
    renderNotes();
    if (typeof el._renderIngest === "function") el._renderIngest();
  });

  /* 理解：发送本地 Agent —— 发送即入列（进度/历史可见） */
  const askListEl = el.querySelector("#askList");
  const askSecH = el.querySelector("#askSecH");
  function renderAskList() {
    if (!askListEl) return;
    if (askSecH) askSecH.textContent = `📜 提问记录（${rs.quotes.length}）`;
    askListEl.innerHTML = rs.quotes.length ? rs.quotes.map((x) => `
      <div class="ask-card ${x.status}">
        <div class="ask-head">
          <span class="ask-status">${x.status === "pending" ? "⏳ 处理中" : x.status === "error" ? "⚠️ 失败" : "✅ 已回传"}</span>
          <span class="ask-time">${x.time || ""}</span>
        </div>
        ${x.quote ? `<div class="ask-quote">${esc(x.quote)}</div>` : ""}
        <div class="ask-q"><b>问：</b>${esc(x.q || "（直接解释原文）")}</div>
        ${x.status === "pending" ? `<div class="ask-wait">Agent 正在阅读原文并检索知识库…</div>` : x.status === "error" ? `<div class="ask-err">${esc(x.answer || "提交失败")}</div>` : `<div class="ask-ans">${mdToHtml(x.answer || "")}</div>`}
        ${x.rel ? `<div class="ask-foot"><a class="open-answer" data-rel="${esc(x.rel)}" style="cursor:pointer;color:var(--acc2);font-size:11px;">打开回答文件 ↗</a></div>` : ""}
      </div>`).join("") : `<div class="note-empty">还没有提问，选中正文问一个吧</div>`;
    askListEl.querySelectorAll(".open-answer").forEach((a) => a.addEventListener("click", () => openFile(a.dataset.rel)));
  }
  renderAskList();
  el._renderAskList = renderAskList;
  el.querySelector("#askBtn").addEventListener("click", () => {
    const q = el.querySelector("#myQuestion").value.trim();
    const sel = curSelText || "";
    if (!sel && !q) { undEl.innerHTML = `<span style="color:var(--red);">请先选中正文或输入问题</span>`; return; }
    /* 立即入列（pending），进度可见；记录引用传给 askWithContext 供回传更新 */
    const rec = { quote: sel, q: q || "请解释这段原文的含义", status: "pending", answer: null, time: new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5) };
    rs.quotes.unshift(rec);
    renderAskList();
    if (typeof el._renderIngest === "function") el._renderIngest();
    el.querySelector("#myQuestion").value = "";
    askWithContext(el, rel, body, q, sel, rs, rec);
  });

  /* 入库：汇总笔记 + 理解结果 */
  el.querySelector("#ingestBtn").addEventListener("click", async () => {
    const msgEl = el.querySelector("#ingestMsg");
    const title = el.querySelector("#ingestTitle").value.trim() || (rel.split("/").pop().replace(".md", "") + "-阅读笔记");
    const total = rs.notes.length + rs.quotes.length;
    if (!total) { msgEl.innerHTML = `<span style="color:var(--amber);">暂无笔记和理解结果，先去读并记录</span>`; return; }
    const parts = [`# ${title}`, "", `> 来源：${rel}`, `> 入库时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`, ""];
    if (rs.notes.length) { parts.push("## 📝 读书笔记", ""); rs.notes.forEach((n) => { if (n.quote) parts.push(`> 原文：${n.quote}`, ""); parts.push(n.text, ""); }); }
    if (rs.quotes.length) { parts.push("## 💡 原文理解", ""); rs.quotes.forEach((x) => { parts.push(`> 原文：${x.quote}`, "", `**问题：** ${x.q || "（直接解释原文）"}`, "", `**回答：** ${x.answer || "（待回答）"}`, ""); }); }
    const r = await fetch(API + "/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content: parts.join("\n") }) });
    const j = await r.json();
    msgEl.innerHTML = j.ok ? `<span style="color:var(--green);">✅ 已入库：${esc(j.file)}（${total} 条）</span>` : `<span style="color:var(--red);">入库失败：${esc(j.error)}</span>`;
  });

  /* 入库审查表渲染 */
  function renderIngest() {
    const tb = el.querySelector("#ingestTable");
    const rows = [];
    rs.notes.forEach((n) => rows.push({ t: "📝 笔记", c: n.text, s: n.quote ? "含原文引用" : "纯手写" }));
    rs.quotes.forEach((x) => rows.push({ t: "💡 理解", c: (x.q || "解释原文"), s: x.status === "pending" ? "⏳ 处理中" : x.status === "error" ? "⚠️ 失败" : "✅ 已回传" }));
    tb.innerHTML = rows.length ? `<table class="ingest-table"><thead><tr><th>类型</th><th>内容摘要</th><th>状态</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.t}</td><td>${esc(r.c.slice(0, 28))}${r.c.length > 28 ? "…" : ""}</td><td>${r.s}</td></tr>`).join("")}</tbody></table>` : `<div class="note-empty">暂无待入库内容</div>`;
  }
  renderIngest();
  el._renderIngest = renderIngest;

  /* 本文相关（含来源素材：生成本篇知识的原始素材 .md 转换稿） */
  const loadRelated = async () => {
    try {
      const rels = await api("/api/related?path=" + encodeURIComponent(rel));
      const srcRaw = f.fm && f.fm.source && f.fm.source !== "" ? (Array.isArray(f.fm.source) ? f.fm.source : [f.fm.source]) : extractSourceFromBody(f.body);
      const srcMds = srcRaw.map(expandSource).flat().filter((p) => p.endsWith(".md"));
      const srcHtml = srcMds.length
        ? `<div class="ai-sec-h" style="margin-top:14px;">🧩 来源素材（${srcMds.length}）</div>` + srcMds.map((r) => `<button class="ai-rel-item" data-rel="${esc(r)}">${esc(r.split("/").pop())} <span style="font-size:10px;color:var(--text3);float:right;">原始素材</span></button>`).join("")
        : "";
      relBox.innerHTML = `<div class="ai-sec-h">📎 本文相关（${rels.length}）</div>` +
        (rels.length ? rels.map((r) => `<button class="ai-rel-item" data-rel="${esc(r.rel)}">${esc(r.title)} <span style="font-size:10px;color:var(--text3);float:right;">${TYPE_CN[r.type] || ""}</span></button>`).join("")
        : `<div style="font-size:12px;color:var(--text3);">暂无强相关页面</div>`) + srcHtml;
      relBox.querySelectorAll(".ai-rel-item").forEach((b) => b.addEventListener("click", () => openFile(b.dataset.rel)));
    } catch (e) { relBox.innerHTML = `<div class="ai-sec-h">📎 本文相关</div><div style="font-size:12px;color:var(--text3);">加载失败</div>`; }
  };
  loadRelated();

  /* 全库检索 */
  el.querySelector("#aiGo").addEventListener("click", async () => {
    const q = qEl.value.trim();
    if (!q) return;
    const btn = el.querySelector("#aiGo");
    btn.disabled = true; btn.textContent = "检索中…";
    const hits = await doSearch(q, { limit: 20 });
    btn.disabled = false; btn.textContent = "搜";
    const cur = hits.find((h) => h.rel === rel);
    const others = hits.filter((h) => h.rel !== rel).slice(0, 8);
    const items = cur ? [cur, ...others] : others;
    res.innerHTML = `<div class="ai-sec-h">🔍 「${esc(q)}」命中 ${hits.length} 条</div>` +
      (items.length ? items.map((h) => `
        <div class="ai-hit ${h.rel === rel ? "ai-cur" : ""}" data-rel="${esc(h.rel)}">
          <div class="t">${h.rel === rel ? "📄 本文 · " : ""}${esc(h.title)}</div>
          <div class="s">${h.content ? buildSnippet(h.content, extractTerms(q)) : "(标题命中)"}</div>
        </div>`).join("") : `<div style="font-size:12px;color:var(--text3);">无命中，换个问法试试</div>`);
    res.querySelectorAll(".ai-hit").forEach((b) => b.addEventListener("click", () => openFile(b.dataset.rel)));
  });
  el.querySelector("#aiQ").addEventListener("keydown", (e) => { if (e.key === "Enter") el.querySelector("#aiGo").click(); });
}

async function openFile(rel, opts = {}) {
  autoCollapseForReading();
  /* 非 md 附件（如上传的 docx 纪要）：直接触发下载 */
  if (!/\.md$/i.test(rel)) {
    const a = document.createElement("a");
    a.href = API + "/" + rel;
    a.download = rel.split("/").pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const f = await api("/api/file?path=" + encodeURIComponent(rel));
  if (!f || f.error) { alert("文件不存在：" + rel); return; }
  /* 浏览历史：非"返回"触发时，记录当前页面作为上一个页面（供 ← 返回 回溯） */
  if (!opts.fromBack && currentRel && currentRel !== rel) backStack.push(currentRel);
  currentRel = rel;
  const back = currentPage === "library" || currentPage === "wiki" || currentPage === "hotspots";
  const isPending = f.fm && f.fm.review === "pending";
  $("#content").innerHTML = `
    <div class="page active">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
        <button class="btn ghost" onclick="goBack()">← 返回</button>
        <span class="page-h" style="margin:0;">${esc(f.fm.title || rel.split("/").pop().replace(".md", ""))}</span>
        ${isPending ? `
          <span style="margin-left:auto;display:flex;gap:8px;align-items:center;">
            <span class="pending-badge" id="revBadge" style="font-size:11px;">📝 待审核</span>
            <button class="btn" id="revOk" style="padding:6px 14px;font-size:12px;">✅ 确认通过</button>
            <button class="btn ghost" id="revRej" style="padding:6px 14px;font-size:12px;">🔁 打回重写</button>
          </span>` : ""}
      </div>
      <div id="readerHost"></div>
    </div>`;
  renderReaderWithAI($("#readerHost"), rel, f);
  if (isPending) {
    const okBtn = $("#revOk");
    const rejBtn = $("#revRej");
    const badge = $("#revBadge");
    const finish = (act, label) => {
      badge.textContent = label;
      badge.style.background = act === "done" ? "rgba(22,163,74,.14)" : "rgba(217,119,6,.14)";
      badge.style.color = act === "done" ? "var(--green)" : "var(--amber)";
      okBtn.disabled = true; rejBtn.disabled = true;
      okBtn.style.opacity = ".5"; rejBtn.style.opacity = ".5";
    };
    okBtn.addEventListener("click", async () => {
      const r = await fetch(API + "/api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rel, action: "done" }) });
      const j = await r.json();
      if (j.ok) { finish("done", "✅ 已确认通过"); setTimeout(() => { if (currentPage === "dashboard") navigate("dashboard"); }, 1500); }
      else alert("操作失败：" + j.error);
    });
    rejBtn.addEventListener("click", async () => {
      const r = await fetch(API + "/api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rel, action: "reject" }) });
      const j = await r.json();
      if (j.ok) { finish("reject", "🔁 已打回重写"); setTimeout(() => { if (currentPage === "dashboard") navigate("dashboard"); }, 1500); }
      else alert("操作失败：" + j.error);
    });
  }
}

/* 获取阅读区当前选中文本 */
function getSelText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  return sel.toString().replace(/\s+/g, " ").trim();
}

/* 发送「原文理解」提问：问题 + 选区原文 + 整篇上下文；rec = 提问记录引用（回传后更新状态） */
async function askWithContext(el, rel, body, question, sel, rs, rec) {
  const und = el.querySelector("#aiUnd");
  const q = question || "请解释这段原文的含义";
  const ctx = sel ? `【原文引用】${sel}\n\n【全文上下文】${(body || "").slice(0, 8000)}` : (body || "").slice(0, 8000);
  try {
    const r = await fetch(API + "/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q.slice(0, 500), context: ctx }) });
    const j = await r.json();
    if (!j.ok) {
      und.innerHTML = `<span style="color:var(--red);">提交失败：${esc(j.error)}</span>`;
      if (rec) { rec.status = "error"; rec.answer = j.error; if (el._renderAskList) el._renderAskList(); if (el._renderIngest) el._renderIngest(); }
      return;
    }
    /* 立即唤醒 WorkBuddy 取件（替代每小时轮询） */
    let wakeNote = "";
    try {
      const w = await fetch(API + "/api/trigger", { method: "POST" });
      const wj = await w.json();
      wakeNote = wj.ok ? "" : `<br><span style="font-size:11px;color:var(--amber);">（自动唤醒失败：${esc(wj.error || "")}，将按每小时兜底取件）</span>`;
    } catch (e) { wakeNote = `<br><span style="font-size:11px;color:var(--amber);">（唤醒失败，将按每小时兜底取件）</span>`; }
    und.innerHTML = `⏳ 已发送给 <b>WorkBuddy</b>（AI-${j.id}），正在基于整篇原文答疑…${wakeNote}`;
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      try {
        const ans = await api("/api/answers");
        const hit = ans.find((a) => a.id === j.id);
        if (hit) {
          clearInterval(t);
          und.innerHTML = `✅ 回答已回传：<a class="open-answer" data-rel="${esc(hit.rel)}" style="cursor:pointer;color:var(--acc2);">${esc(hit.question || "").slice(0, 50)}… ↗</a><div class="reader" style="font-size:12px;margin-top:6px;max-height:200px;overflow:hidden;">${mdToHtml(hit.body || "")}</div>`;
          und.querySelectorAll(".open-answer").forEach((x) => x.addEventListener("click", () => openFile(x.dataset.rel)));
          /* 更新提问记录（pending → done）+ 刷新列表/入库表 */
          if (rec) { rec.status = "done"; rec.answer = hit.body || ""; rec.rel = hit.rel; }
          if (el._renderAskList) el._renderAskList();
          if (el._renderIngest) el._renderIngest();
        } else if (tries > 120) { clearInterval(t); und.innerHTML = `⏳ 仍在处理（AI-${j.id}）… <a href="#/ai" style="color:var(--acc2);">去 AI 对话页查看 ↗</a>`; }
      } catch (e) { /* 忽略瞬时错误 */ }
    }, 5000);
  } catch (e) {
    und.innerHTML = `<span style="color:var(--red);">提交失败：${esc(e.message)}</span>`;
    if (rec) { rec.status = "error"; rec.answer = e.message; if (el._renderAskList) el._renderAskList(); if (el._renderIngest) el._renderIngest(); }
  }
}

function goBack() {
  /* 优先回溯浏览历史（来源链接/双链跳转后返回上一个页面），栈空才回列表 */
  if (backStack.length) {
    const prev = backStack.pop();
    openFile(prev, { fromBack: true });
    return;
  }
  if (currentPage === "library" || currentPage === "wiki" || currentPage === "hotspots") renderPage(currentPage);
  else navigate(currentPage);
}

async function bindWikiLinks() {
  document.querySelectorAll("a.wikilink").forEach((a) => {
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      const target = a.dataset.t.replace(/\.md$/, "");
      /* 支持两种格式：完整路径（知识层/概念/xxx）或短名（xxx）——都尝试匹配 */
      const files = await api("/api/files?type=wiki");
      let hit = files.find((f) => f === target || f.replace(/\.md$/, "") === target);
      if (!hit) {
        const name = target.split("/").pop();
        hit = files.find((f) => f.split("/").pop().replace(".md", "") === name);
      }
      if (hit) openFile(hit);
      else {
        const raws = await api("/api/files?type=raw");
        const tname = target.split("/").pop();
        let hit2 = raws.find((f) => f === target || f.split("/").pop().replace(/\.(md|png|jpg|jpeg|webp|gif|pptx|ppt)$/i, "") === tname);
        if (hit2) openFile(hit2);
        else alert("未找到页面：" + target);
      }
    });
  });

  /* 来源素材链接：.md → 打开转换稿阅读；图片 → lightbox 预览 */
  document.querySelectorAll("a.src-link, a.src-md").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const r = a.dataset.rel;
      if (isImgRel(r)) openLightbox(expandSource(r), 0);
      else openFile(r);
    });
  });
  /* 来源素材缩略图 → lightbox（整组左右切换） */
  document.querySelectorAll(".src-thumbs").forEach((box) => {
    const list = JSON.parse(box.dataset.list || "[]");
    box.querySelectorAll("img.src-thumb").forEach((img, i) => {
      img.addEventListener("click", () => openLightbox(list, i));
    });
  });
}

/* ---------- 图片查看器（来源素材缩略图 → 全屏 lightbox） ---------- */
let lbList = [], lbIdx = 0;
function openLightbox(list, idx) {
  if (!list || !list.length) return;
  lbList = list; lbIdx = Math.min(idx || 0, list.length - 1);
  let lb = document.getElementById("srcLightbox");
  if (!lb) {
    lb = document.createElement("div");
    lb.id = "srcLightbox";
    lb.className = "src-lightbox";
    lb.innerHTML = `<div class="lb-stage">
        <img class="lb-img" alt="">
        <div class="lb-cap"></div>
        <button class="lb-close" title="关闭 (Esc)">✕</button>
        <button class="lb-nav lb-prev" title="上一张 (←)">‹</button>
        <button class="lb-nav lb-next" title="下一张 (→)">›</button>
      </div>`;
    document.body.appendChild(lb);
    lb.addEventListener("click", (e) => { if (e.target === lb) closeLightbox(); });
    lb.querySelector(".lb-close").addEventListener("click", closeLightbox);
    lb.querySelector(".lb-prev").addEventListener("click", (e) => { e.stopPropagation(); lbStep(-1); });
    lb.querySelector(".lb-next").addEventListener("click", (e) => { e.stopPropagation(); lbStep(1); });
    document.addEventListener("keydown", (e) => {
      if (!lb.classList.contains("show")) return;
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") lbStep(-1);
      else if (e.key === "ArrowRight") lbStep(1);
    });
  }
  lbShow();
}
function lbShow() {
  const lb = document.getElementById("srcLightbox");
  if (!lb || !lbList.length) return;
  const rel = lbList[lbIdx];
  lb.querySelector(".lb-img").src = "/" + rel;
  const name = rel.split("/").pop();
  lb.querySelector(".lb-cap").textContent = lbList.length > 1 ? `${name}（${lbIdx + 1} / ${lbList.length}）` : name;
  lb.querySelector(".lb-prev").style.display = lbList.length > 1 ? "" : "none";
  lb.querySelector(".lb-next").style.display = lbList.length > 1 ? "" : "none";
  lb.classList.add("show");
}
function lbStep(d) { lbIdx = (lbIdx + d + lbList.length) % lbList.length; lbShow(); }
function closeLightbox() {
  const lb = document.getElementById("srcLightbox");
  if (lb) lb.classList.remove("show");
}

/* ---------- 页面渲染 ---------- */
async function renderPage(page) {
  const c = $("#content");
  const loaders = { dashboard: renderDashboard, graph: renderGraph, library: renderLibrary, hotspots: renderHotspots, wiki: renderWiki, brainstorm: renderBrainstorm, ai: renderAIchat, todo: renderTodoPage, ledger: renderLedgerPage, studio: renderStudio, archive: renderArchive, bookshelf: renderBookshelf };
  c.innerHTML = `<div class="page active" style="padding:10px 0;color:var(--text3);">加载中…</div>`;
  try {
    await loaders[page](c);
  } catch (e) {
    c.innerHTML = `<div class="page active">加载失败：${esc(e.message)}</div>`;
  }
}

/* --- Dashboard --- */
async function renderDashboard(c) {
  const s = await api("/api/stats");
  const todo = await api("/api/todo");
  const cnt = s.counts;
  const done = todo.filter((t) => t.done).length;
  const pct = todo.length ? Math.round((done / todo.length) * 100) : 0;
  const ringR = 26, ringC = 2 * Math.PI * ringR;
  const groups = (s.groups || []).filter((g) => g.k !== "全部");
  const gMax = Math.max(...groups.map((g) => g.count), 1);
  c.innerHTML = `
    <div class="page active">
      <div class="dash-banner">
        <img src="/assets/banner.png" alt="" onerror="this.style.display='none'">
        <div class="banner-overlay">
          <div class="banner-title">💙 __USER_NAME__的专属工作台</div>
          <div class="banner-sub">知识库 · 工作台 · 生活舱 —— 同一份资产，三个战场</div>
        </div>
      </div>
      <div class="grid c4" style="margin-bottom:14px;">
        <div class="stat"><div class="num">${s.wikiTotal}</div><div class="lbl">知识层页面</div><div class="sub">概念 ${cnt.concept} · 实体 ${cnt.entity} · 摘要 ${cnt.source}</div></div>
        <div class="stat"><div class="num">${s.rawFiles}</div><div class="lbl">素材转换稿</div><div class="sub">原始素材 / 文章</div></div>
        <div class="stat"><div class="num">${cnt.comparison + cnt.synthesis}</div><div class="lbl">对比 + 综述</div><div class="sub">横向分析成果</div></div>
        <div class="stat ring-stat">
          <div class="ring-wrap">
            <svg viewBox="0 0 64 64" width="64" height="64">
              <circle cx="32" cy="32" r="${ringR}" fill="none" stroke="#e8e1f8" stroke-width="7"/>
              <circle cx="32" cy="32" r="${ringR}" fill="none" stroke="${pct > 0 ? "var(--green)" : "var(--acc)"}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${ringC.toFixed(1)}" stroke-dashoffset="${(ringC * (1 - pct / 100)).toFixed(1)}" transform="rotate(-90 32 32)"/>
            </svg>
            <div class="ring-center"><div class="num2">${pct}%</div><div style="font-size:10px;color:var(--text3);">完成</div></div>
          </div>
          <div style="min-width:0;">
            <div class="lbl">ToDo 完成度</div>
            <div class="sub">${done}/${todo.length} 已完成 · P0/P1/P2</div>
          </div>
        </div>
      </div>
      <div class="grid c3" style="margin-bottom:14px;">
        <div class="card" style="grid-column:span 1">
          <h3>🎯 战场状态</h3>
          <div style="font-size:13px;line-height:2;color:var(--text2);">
            <div>◆ 闭环：<span style="color:var(--green)">精读→知识卡→案例卡→方案→复盘 ✅</span></div>
            <div>◆ 阶段：第二阶段（14 天第一阶段 100%）</div>
            <div>◆ 六模块：案例/方案/复盘 🟢 · 情报/地图 🟡 · 作战室 🔴</div>
            <div>◆ 制度脉络：国家 → 省 → 市 三级贯通</div>
            <div>◆ 摄入质检：${s.pendingReview ? `<span class="pending-badge">📝 ${s.pendingReview} 张待审</span>` : `<span style="color:var(--green)">✅ 全部确认</span>`} ${s.pendingReview ? `<span style="font-size:11px;color:var(--text3);">见下方模块</span>` : ""}</div>
          </div>
        </div>
        <div class="card" style="grid-column:span 1">
          <h3>📝 摄入质检 <span style="font-weight:400;font-size:11px;color:var(--text3);">点卡片查看 → 确认/打回</span></h3>
          <div id="reviewList" style="max-height:230px;overflow-y:auto;">
            ${s.pendingReviewList && s.pendingReviewList.length ? s.pendingReviewList.map((r, i) => `
              <div class="rev-item" data-rel="${esc(r.rel)}" data-title="${esc(r.title)}" style="${i > 0 ? "border-top:1px solid var(--line);" : ""}">
                <span class="rev-open">${esc(r.title)}</span>
                <span class="rev-actions">
                  <button class="rev-btn ok" data-act="done" title="确认通过">✅</button>
                  <button class="rev-btn no" data-act="reject" title="打回重写">🔁</button>
                </span>
              </div>`).join("") : `<div style="color:var(--green);padding:12px 0;text-align:center;">✅ 无待审卡片</div>`}
          </div>
        </div>
        <div class="card" style="grid-column:span 1">
          <h3>📋 作战清单（ToDo）</h3>
          ${todo.length ? todo.map((t) => {
            const sec = t.section || "";
            const secShort = /^W\d+/.test(sec) ? sec.match(/^W\d+/)[0] : (sec.length > 10 ? sec.slice(0, 10) + "…" : sec);
            return `
            <div style="display:flex;gap:10px;padding:6px 0;font-size:13px;border-bottom:1px solid var(--line);align-items:flex-start;">
              <span style="flex-shrink:0;color:${t.done ? "var(--green)" : "var(--text3)"}">${t.done ? "☑" : "☐"}</span>
              <span style="flex:1;min-width:0;word-break:break-word;color:${t.done ? "var(--text3)" : "var(--text)"};${t.done ? "text-decoration:line-through" : ""}">${esc(t.text)}</span>
              <span style="flex-shrink:0;font-size:11px;color:var(--text3);white-space:nowrap;" title="${esc(sec)}">${esc(secShort)}</span>
            </div>`;}).join("") : "<div style='color:var(--text3)'>暂无任务</div>"}
        </div>
      </div>
      <div class="grid c3" style="margin-bottom:14px;">
        <div class="card" style="grid-column:span 1">
          <h3>🗃 素材分布（${s.rawFiles} 篇）</h3>
          <div style="padding-top:4px;">
            ${groups.map((g) => `
              <div class="mini-row">
                <span class="mb-lbl">${esc(g.k)}</span>
                <div class="mb-track"><div class="mb-fill" style="width:${(g.count / gMax * 100).toFixed(1)}%"></div></div>
                <span class="mb-num">${g.count}</span>
              </div>`).join("")}
          </div>
          <div style="font-size:11px;color:var(--text3);margin-top:8px;">按文件名关键词归类 · 点击素材库页可分组浏览</div>
        </div>
        <div class="card" style="grid-column:span 2">
          <h3>🕘 最近操作</h3>
          ${s.recent.map((l) => `<div class="tl-item"><span class="tl-time">${esc(l.slice(0, 17))}</span><div class="tl-text">${esc(l.slice(18))}</div></div>`).join("")}
        </div>
      </div>
    </div>`;
  /* 摄入质检模块：点标题打开阅读器，确认/打回按钮 */
  const rv = $("#reviewList");
  if (rv) {
    rv.querySelectorAll(".rev-open").forEach((el) => {
      el.addEventListener("click", () => openFile(el.parentElement.dataset.rel));
    });
    rv.querySelectorAll(".rev-btn").forEach((b) => {
      b.addEventListener("click", async () => {
        const item = b.closest(".rev-item");
        const rel = item.dataset.rel;
        const act = b.dataset.act;
        const r = await fetch(API + "/api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rel, action: act }) });
        const j = await r.json();
        if (j.ok) {
          item.style.opacity = "0.3";
          item.style.pointerEvents = "none";
          item.querySelector(".rev-open").textContent = (act === "done" ? "✅ " : "🔁 ") + item.dataset.title;
          setTimeout(() => renderDashboard(c), 800); // 刷新看板
        } else {
          alert("操作失败：" + j.error);
        }
      });
    });
  }
}

/* --- 知识星图（d3-force 力导向）--- */
let graphCache = null;
let graphData = null;
let graphSimulation = null;

async function renderGraph(c) {
  if (!graphCache) graphCache = await api("/api/graph");
  const g = graphCache;
  graphData = g;
  const types = Object.entries(TYPE_COLOR).filter(([k]) => TYPE_CN[k]);
  c.innerHTML = `<div class="page active">
    <div class="graph-wrap">
      <div class="graph-legend">
        ${types.map(([k, v]) => `<span class="gfilter" data-type="${k}" style="cursor:pointer;opacity:1;"><i style="background:${v}"></i>${TYPE_CN[k]}</span>`).join("")}
      </div>
      <div id="graphPop"></div>
      <svg id="graphSvg"></svg>
    </div>
    <div style="font-size:11px;color:var(--text3);margin-top:8px;">节点 ${g.nodes.length} · 关系 ${g.links.length}｜滚轮缩放 · 拖拽节点 · 点击查看相邻 · 点图例筛选</div>
  </div>`;
  await loadD3();
  drawGraphD3(g);
  c.querySelectorAll(".gfilter").forEach((el) => {
    el.addEventListener("click", () => {
      const t = el.dataset.type;
      el.style.opacity = el.style.opacity === "1" ? "0.35" : "1";
      toggleGraphFilter(t);
    });
  });
}

let graphHiddenTypes = new Set();
function toggleGraphFilter(type) {
  if (graphHiddenTypes.has(type)) graphHiddenTypes.delete(type);
  else graphHiddenTypes.add(type);
  if (graphSimulation) drawGraphD3(graphData);
}

/* 星图相邻页面弹层（复刻案例：点击节点 → 相邻页面列表 + 双向标注）*/
function showGraphNeighbors(rel) {
  const g = graphData;
  if (!g) return;
  const node = g.nodes.find((n) => n.rel === rel);
  if (!node) return;
  const outLinks = g.links.filter((l) => l.source === rel).map((l) => l.target);
  const inLinks = g.links.filter((l) => l.target === rel).map((l) => l.source);
  const all = [...new Set([...outLinks, ...inLinks])];
  const pop = document.querySelector("#graphPop");
  const name = (r) => { const n = g.nodes.find((x) => x.rel === r); return n ? n.title || n.name : r.split("/").pop(); };
  const type = (r) => { const n = g.nodes.find((x) => x.rel === r); return n ? n.type : "page"; };
  pop.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <b style="font-size:13px;flex:1;">${esc(node.title || node.name)}</b>
      <button class="btn ghost" style="padding:4px 10px;font-size:11px;" id="gpOpen">打开</button>
      <button class="btn ghost" style="padding:4px 8px;font-size:11px;" id="gpClose">✕</button>
    </div>
    <div style="font-size:11px;color:var(--text3);margin-bottom:6px;">相邻页面 ${all.length} 个</div>
    ${all.length ? all.map((r) => {
      const bidir = outLinks.includes(r) && inLinks.includes(r);
      return `<div class="gp-item" data-rel="${esc(r)}">
        <span class="tag ${type(r)}">${TYPE_CN[type(r)] || ""}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(name(r))}</span>
        ${bidir ? `<span style="font-size:10px;color:var(--green);white-space:nowrap;">双向</span>` : ""}
      </div>`;
    }).join("") : `<div style="font-size:12px;color:var(--text3);">无相邻页面</div>`}`;
  pop.style.display = "";
  pop.querySelector("#gpClose").addEventListener("click", () => { pop.style.display = "none"; });
  pop.querySelector("#gpOpen").addEventListener("click", () => openFile(rel));
  pop.querySelectorAll(".gp-item").forEach((x) => x.addEventListener("click", () => openFile(x.dataset.rel)));
}

function drawGraphD3(g) {
  if (graphSimulation) { graphSimulation.stop(); graphSimulation = null; }
  const svgEl = $("#graphSvg");
  const W = svgEl.clientWidth || 900, H = svgEl.clientHeight || 600;

  d3.select(svgEl).selectAll("*").remove();
  const svg = d3.select(svgEl);
  svg.attr("viewBox", `0 0 ${W} ${H}`);

  const defs = svg.append("defs");
  defs.append("marker").attr("id", "garrow").attr("markerWidth", 6).attr("markerHeight", 6).attr("refX", 5).attr("refY", 3).attr("orient", "auto")
    .append("path").attr("d", "M0,0 L6,3 L0,6 Z").attr("fill", "#a78bfa");

  const filterTypes = graphHiddenTypes.size > 0 ? graphHiddenTypes : null;
  const visNodes = g.nodes.filter((n) => !filterTypes || !filterTypes.has(n.type));
  const visSet = new Set(visNodes.map((n) => n.rel));
  const visLinks = g.links.filter((l) => visSet.has(l.source) && visSet.has(l.target));

  const nodeRadius = (n) => n.type === "concept" ? 16 : n.type === "entity" ? 14 : n.type === "synthesis" ? 14 : 11;

  const nodes = visNodes.map((d) => ({ ...d }));
  const links = visLinks.map((d) => ({ source: d.source, target: d.target }));

  const gMain = svg.append("g");

  const zoom = d3.zoom().scaleExtent([0.3, 4]).on("zoom", (event) => gMain.attr("transform", event.transform));
  svg.call(zoom);

  const link = gMain.append("g").attr("class", "graph-links")
    .selectAll("line").data(links).join("line")
    .attr("stroke", "#d9ccf5").attr("stroke-width", 1).attr("marker-end", "url(#garrow)");

  const node = gMain.append("g").attr("class", "graph-nodes")
    .selectAll("g").data(nodes).join("g")
    .attr("class", "graph-node").attr("data-rel", (d) => d.rel)
    .style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (event, d) => { if (!event.active) graphSimulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on("end", (event, d) => { if (!event.active) graphSimulation.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  node.append("circle")
    .attr("r", nodeRadius)
    .attr("fill", (d) => TYPE_COLOR[d.type] || "#8b84ab")
    .attr("fill-opacity", 0.16)
    .attr("stroke", (d) => TYPE_COLOR[d.type] || "#8b84ab")
    .attr("stroke-width", 1.5);

  node.append("text")
    .attr("y", (d) => nodeRadius(d) + 11)
    .attr("text-anchor", "middle")
    .attr("font-size", 10)
    .attr("fill", "#6b6485")
    .style("pointer-events", "none")
    .text((d) => (d.title || d.name).slice(0, 14));

  node.on("mouseover", function() { d3.select(this).select("circle").attr("stroke-width", 2.5).attr("filter", "drop-shadow(0 0 6px rgba(111,76,255,0.45))"); })
    .on("mouseout", function() { d3.select(this).select("circle").attr("stroke-width", 1.5).attr("filter", null); })
    .on("click", (event, d) => { event.stopPropagation(); showGraphNeighbors(d.rel); });

  graphSimulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.rel).distance(90).strength(0.3))
    .force("charge", d3.forceManyBody().strength(-320))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collide", d3.forceCollide().radius((d) => nodeRadius(d) + 8))
    .alphaDecay(0.025)
    .on("tick", () => {
      link.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
          .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });
}

/* --- 素材库 --- */
let rawCache = null;
async function renderLibrary(c) {
  if (!rawCache) rawCache = await api("/api/files?type=raw");
  /* 内容分类（关键词） */
  const LIB_GROUPS = [
    { k: "全部", kw: [] },
    { k: "制度政策", kw: ["管理办法", "实施细则", "暂行办法", "规范", "规定", "条例", "通知", "指导意见", "实施方案", "价格", "登记"] },
    { k: "汇报交流", kw: ["汇报", "发言稿", "报告", "务虚", "交流", "座谈", "周报"] },
    { k: "申报材料", kw: ["申报书", "申报", "大赛", "资金申请", "试点", "项目建议"] },
    { k: "工具模板", kw: ["培训", "课件", "操作手册", "指引", "指南", "清单", "报价", "岗位", "流程", "架构", "模板"] },
    { k: "商务合作", kw: ["协议", "合同", "保密", "合作", "采购", "招标", "框架"] },
    { k: "技术能力", kw: ["数据空间", "可信", "密态", "隐私", "区块链", "沙箱", "连接器", "智能体", "AI", "大模型", "算力"] },
    { k: "业务场景", kw: ["政务平台", "授权运营", "资产入表", "数据资产", "金融", "信用", "医保", "保险", "就业", "汽车服务", "汽车", "教育"] },
  ];
  /* 素材类型（对应 原始素材/ 一级子目录） */
  const TYPES = ["全部", "ppt", "文章", "热点", "论文", "逐字稿", "数据", "随手笔记", "图片", "附件"];
  c.innerHTML = `<div class="page active"><div class="split">
    <div class="file-tree">
      <div style="display:flex;gap:8px;padding:8px;margin-bottom:6px;">
        <input class="brain-input" style="min-height:0;padding:8px 12px;font-size:13px;" id="libFilter" placeholder="过滤文件名…">
      </div>
      <div style="display:flex;gap:6px;padding:0 8px 6px;flex-wrap:wrap;align-items:center;">
        <select id="libType" class="lib-select" title="素材类型"><option value="全部">📁 素材类型</option></select>
        <select id="libGroup" class="lib-select" title="内容分类"><option value="全部">🏷 内容分类</option></select>
        <button class="btn ghost lib-sort" id="libSort" style="padding:5px 10px;font-size:11px;margin-left:auto;" title="按入库时间排序">⏱ 时间 ↓</button>
      </div>
      <div id="libList"></div>
    </div>
    <div class="reader-pane" id="libReader"><div class="empty">← 从左侧选择一篇素材<br><br>${rawCache.length} 条素材 · 双筛 + 时间排序 · 可全文阅读</div></div>
  </div></div>`;
  const listEl = $("#libList");
  const typeEl = $("#libType");
  const grpEl = $("#libGroup");
  const sortEl = $("#libSort");
  typeEl.innerHTML += TYPES.map((t) => {
    const cnt = t === "全部" ? rawCache.length : rawCache.filter((f) => f.type === t).length;
    return `<option value="${t}">${t} (${cnt})</option>`;
  }).join("");
  /* 级联：根据给定的素材子集，动态重算内容分类选项（只保留该子集下确实命中的分类） */
  function updateGrpOptions(items) {
    const groups = LIB_GROUPS.filter((g) => g.kw.length);
    const rows = groups.map((g) => ({
      k: g.k,
      cnt: items.filter((f) => g.kw.some((w) => (f.rel || f).toLowerCase().includes(w.toLowerCase()))).length,
    })).filter((r) => r.cnt > 0);
    grpEl.innerHTML = `<option value="全部">全部 (${items.length})</option>` + rows.map((r) => `<option value="${r.k}">${r.k} (${r.cnt})</option>`).join("");
  }
  updateGrpOptions(rawCache);
  let sortDir = -1; // -1 最新在前 / 1 最早在前
  function currentItems() {
    let items = rawCache.slice();
    const type = typeEl.value;
    const grp = grpEl.value;
    if (type && type !== "全部") items = items.filter((f) => f.type === type);
    if (grp && grp !== "全部") {
      const g = LIB_GROUPS.find((x) => x.k === grp);
      if (g) items = items.filter((f) => g.kw.some((w) => (f.rel || f).toLowerCase().includes(w.toLowerCase())));
    }
    return items;
  }
  /* 树形渲染：按 rel 路径组织（Obsidian 目录树结构） */
  if (!window.__libTreeState) window.__libTreeState = {}; // 全局折叠状态
  const treeState = window.__libTreeState;
  function renderTree(items) {
    /* 构建树: { type: { folderName: { fileName: rel } } } */
    const tree = {}; // type -> { folder: [files] } 或 type -> [files]
    for (const f of items) {
      const rel = f.rel || f;
      const segs = rel.split("/"); // 原始素材/type/...
      if (segs.length < 3) continue;
      const type = segs[1];
      const rest = segs.slice(2);
      if (!tree[type]) tree[type] = { folders: {}, files: [] };
      if (rest.length > 1) {
        const folder = rest.slice(0, -1).join("/");
        if (!tree[type].folders[folder]) tree[type].folders[folder] = [];
        tree[type].folders[folder].push(f);
      } else {
        tree[type].files.push(f);
      }
    }
    let html = "";
    const types = Object.keys(tree).sort();
    const isAll = typeEl.value === "全部";
    for (const type of types) {
      const t = tree[type];
      const typeKey = "T:" + type;
      /* 默认：全部时类型展开（文件夹折叠）；选具体类型时自动展开该类型 */
      const typeOpen = treeState[typeKey] === true || (isAll && treeState[typeKey] === undefined) || (!isAll && typeEl.value === type);
      const folderNames = Object.keys(t.folders).sort();
      const fcnt = t.files.length + folderNames.length;
      html += `<div class="tree-node tree-type ${typeOpen ? "open" : ""}" data-key="${typeKey}"><span class="tree-arrow">${typeOpen ? "▾" : "▸"}</span><span class="tree-ico">${typeIco(type)}</span> ${esc(type)} <span class="tree-cnt">${fcnt}</span></div>`;
      if (typeOpen) {
        html += `<div class="tree-children" data-parent="${typeKey}">`;
        for (const folder of folderNames) {
          const fKey = typeKey + "/" + folder;
          /* 文件夹默认折叠；"全部"时类型层展开但文件夹折叠 */
          const fOpen = treeState[fKey] === true;
          const files = convFirst(t.folders[folder]);
          html += `<div class="tree-node tree-folder ${fOpen ? "open" : ""}" data-key="${fKey}"><span class="tree-arrow">${fOpen ? "▾" : "▸"}</span><span class="tree-ico">📂</span> ${esc(folder)} <span class="tree-cnt">${files.length}</span></div>`;
          if (fOpen) {
            html += `<div class="tree-children" data-parent="${fKey}">` + files.map(fileHtml).join("") + `</div>`;
          }
        }
        html += convFirst(t.files).map(fileHtml).join("");
        html += `</div>`;
      }
    }
    return html || `<div style="padding:8px;color:var(--text3);font-size:12px;">该组合暂无素材</div>`;
  }
  /* 文件夹内文件排序：仅 ppt 类型的转换稿（⭐）置顶，其余保持原序（时间序） */
  function convFirst(arr) {
    const conv = arr.filter((f) => f.type === "ppt" && (f.rel || f).endsWith("-转换稿.md"));
    const rest = arr.filter((f) => !(f.type === "ppt" && (f.rel || f).endsWith("-转换稿.md")));
    return conv.concat(rest);
  }
  function fileHtml(f) {
    const rel = f.rel || f;
    const raw = rel.split("/").pop();
    /* 星标仅限 ppt 类型转换稿 */
    const isConv = f.type === "ppt" && raw.endsWith("-转换稿.md");
    const name = raw.replace(/\.(md|png|jpg|jpeg|webp|gif|pptx|ppt)$/i, "").replace("-转换稿", "");
    const dt = f.mtime ? new Date(f.mtime).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "";
    const star = isConv ? `<span class="star" title="转换稿">⭐</span>` : "";
    const cls = "f " + (currentRel === rel ? "active" : "") + (isConv ? " is-conv" : "");
    return `<div class="${cls}" data-rel="${esc(rel)}">${star}<span class="lib-type">${esc(f.type || "")}</span> ${esc(name)}<span class="lib-date">${dt}</span></div>`;
  }
  function typeIco(t) {
    return ({ ppt: "📽", 文章: "📄", 图片: "🖼", 热点: "🔥", 论文: "📜", 逐字稿: "🎙", 数据: "📊", 随手笔记: "✍️", 附件: "📎" })[t] || "📁";
  }
  /* 树节点点击：文件夹展开/折叠（仅绑定一次，委托最新 renderList） */
  if (!window.__libTreeBound) {
    window.__libTreeBound = true;
    listEl.addEventListener("click", (e) => {
      const node = e.target.closest(".tree-node");
      if (!node) return;
      const key = node.dataset.key;
      if (key && (key.startsWith("T:") || key.includes("/"))) {
        treeState[key] = node.classList.contains("open") ? false : true;
        if (typeof window.renderListRef === "function") window.renderListRef($("#libFilter").value.trim());
      }
    });
  }
  function renderList(kw) {
    window.renderListRef = renderList;
    let items = currentItems();
    if (kw) items = items.filter((f) => (f.rel || f).toLowerCase().includes(kw.toLowerCase()));
    items.sort((a, b) => sortDir * ((b.mtime || 0) - (a.mtime || 0)));
    if (!kw) {
      listEl.innerHTML = renderTree(items);
    } else {
      const shown = items.slice(0, 400);
      listEl.innerHTML = shown.map((f) => {
        const rel = f.rel || f;
        const raw = rel.split("/").pop();
        const isConv = f.type === "ppt" && raw.endsWith("-转换稿.md");
        const name = raw.replace(/\.(md|png|jpg|jpeg|webp|gif|pptx|ppt)$/i, "").replace("-转换稿", "");
        const dt = f.mtime ? new Date(f.mtime).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "";
        const star = isConv ? `<span class="star" title="转换稿">⭐</span>` : "";
        return `<div class="f ${isConv ? "is-conv" : ""}" data-rel="${esc(rel)}">${star}<span class="lib-type">${esc(f.type || "")}</span> ${esc(name)}<span class="lib-date">${dt}</span></div>`;
      }).join("") + (items.length > 400 ? `<div style="padding:8px;color:var(--text3);font-size:11px;">…共 ${items.length} 条，输入关键字过滤</div>` : "");
    }
    listEl.querySelectorAll(".f").forEach((el) => el.addEventListener("click", async () => {
      listEl.querySelectorAll(".f").forEach((x) => x.classList.remove("active"));
      el.classList.add("active");
      const rel = el.dataset.rel;
      if (/\.(pptx|ppt)$/i.test(rel)) {
        /* PPT 源文件：新窗口打开（系统 PowerPoint/WPS 打开） */
        $("#libReader").innerHTML = `<div style="height:100%;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;color:var(--text3);">
          <div style="font-size:40px;">📽</div>
          <div class="fm-line mono" style="margin-bottom:8px;">${esc(rel)}</div>
          <a class="btn" href="/${esc(rel)}" target="_blank" style="padding:8px 18px;">在新标签页打开源文件 ↗</a>
          <div style="font-size:11px;color:var(--text3);">PPT 源文件（系统 PowerPoint / WPS 打开）· 文字版见同目录「-转换稿.md」</div>
        </div>`;
        return;
      }
      if (/\.(png|jpg|jpeg|webp|gif)$/i.test(rel)) {
        $("#libReader").innerHTML = `<div style="height:100%;display:flex;flex-direction:column;gap:10px;">
          <div class="fm-line mono" style="margin-bottom:8px;">${esc(rel)}</div>
          <img src="/${esc(rel)}" style="max-width:100%;border-radius:12px;border:1px solid var(--line);box-shadow:0 8px 24px rgba(97,66,200,.12);" alt="">
          <a class="wikilink" href="/${esc(rel)}" target="_blank">在新标签页打开原图 ↗</a>
        </div>`;
        return;
      }
      const f = await api("/api/file?path=" + encodeURIComponent(rel));
      renderReaderWithAI($("#libReader"), rel, f, { pane: true });
    }));
  }
  typeEl.addEventListener("change", () => {
    /* 级联刷新：类型变化 → 内容分类选项只保留当前类型实际命中的分类，并回退「全部」 */
    const type = typeEl.value;
    const sub = type === "全部" ? rawCache : rawCache.filter((f) => f.type === type);
    grpEl.value = "全部";
    updateGrpOptions(sub);
    renderList($("#libFilter").value.trim());
  });
  grpEl.addEventListener("change", () => renderList($("#libFilter").value.trim()));
  sortEl.addEventListener("click", () => {
    sortDir *= -1;
    sortEl.textContent = sortDir === -1 ? "⏱ 时间 ↓" : "⏱ 时间 ↑";
    renderList($("#libFilter").value.trim());
  });
  $("#libFilter").addEventListener("input", (e) => renderList(e.target.value.trim()));
  renderList("");
}

/* --- 每日热点 --- */
let hotspotsCache = null;
async function renderHotspots(c) {
  if (!hotspotsCache) hotspotsCache = await api("/api/hotspots");
  const hs = hotspotsCache;
  c.innerHTML = `<div class="page active"><div class="split">
    <div class="file-tree">
      <div style="padding:10px 8px;font-size:12px;color:var(--text2);">🔥 AI 资讯自动补给线<br>每日 8 点自动化抓取 · 入库 原始素材/热点/</div>
      <div id="hsList"></div>
    </div>
    <div class="reader-pane" id="hsReader">
      ${hs.length ? `<div class="empty">← 选择一期热点日报<br><br>共 ${hs.length} 期 · 最新 ${hs[0].date || ""}</div>` : `<div class="empty">暂无热点日报<br><br>自动化将于每日 8 点生成，也可手动触发</div>`}
    </div>
  </div></div>`;
  const listEl = $("#hsList");
  listEl.innerHTML = hs.map((h) => `
    <div class="list-item" data-rel="${esc(h.rel)}">
      <span style="font-size:15px;">🔥</span>
      <span class="t">${esc(h.date || h.name)}${h.count ? ` <span style="font-size:10px;color:var(--text3);">${h.count} 条</span>` : ""}</span>
      <span style="margin-left:auto;font-size:10px;color:var(--text3);white-space:nowrap;">${esc(h.title.replace(/^(热点日报|每日热点)/, ""))}</span>
    </div>`).join("") || `<div style="padding:10px;color:var(--text3);font-size:12px;">暂无数据</div>`;
  listEl.querySelectorAll(".list-item").forEach((el) => el.addEventListener("click", async () => {
    listEl.querySelectorAll(".list-item").forEach((x) => x.style.background = "");
    el.style.background = "rgba(239,68,68,0.14)";
    const rel = el.dataset.rel;
    const f = await api("/api/file?path=" + encodeURIComponent(rel));
    renderReaderWithAI($("#hsReader"), rel, f, { pane: true });
  }));
}

/* --- 知识层 --- */
let wikiCache = null;
async function renderWiki(c) {
  if (!wikiCache) wikiCache = await api("/api/files?type=wiki");
  const types = ["全部", "concept", "entity", "source", "comparison", "synthesis"];
  c.innerHTML = `<div class="page active"><div class="split">
    <div class="file-tree">
      <div style="display:flex;gap:6px;flex-wrap:wrap;padding:8px;margin-bottom:4px;" id="wikiTabs"></div>
      <div id="wikiList"></div>
    </div>
    <div class="reader-pane" id="wikiReader"><div class="empty">← 从左侧选择知识层页面<br><br>AI 编译的知识网络</div></div>
  </div></div>`;
  const tabEl = $("#wikiTabs");
  tabEl.innerHTML = types.map((t) => `<span class="tag ${t === "concept" ? "concept" : ""}" data-type="${t}" style="cursor:pointer;">${t === "全部" ? "全部" : TYPE_CN[t]}</span>`).join("");
  const listEl = $("#wikiList");
  async function renderList(type) {
    const metas = [];
    for (const rel of wikiCache) {
      if (rel.includes("/README") || rel.startsWith("_") || rel.includes("/_")) continue;
      const base = rel.split("/").pop().replace(".md", "");
      const f = await api("/api/file?path=" + encodeURIComponent(rel));
      if (!f || f.error) continue;
      if (type !== "全部" && f.fm.type !== type) continue;
      metas.push({ rel, fm: f.fm, title: f.fm.title || base, type: f.fm.type || "page" });
    }
    metas.sort((a, b) => (b.fm.updated || "").localeCompare(a.fm.updated || ""));
    listEl.innerHTML = metas.map((m) => `
      <div class="list-item" data-rel="${esc(m.rel)}">
        <span class="tag ${m.type}">${TYPE_CN[m.type] || m.type}</span>
        <span class="t">${esc(m.title)}</span>
        <span style="margin-left:auto;font-size:11px;color:var(--text3);white-space:nowrap;">${esc(m.fm.confidence || "")}</span>
      </div>`).join("");
    listEl.querySelectorAll(".list-item").forEach((el) => el.addEventListener("click", async () => {
      listEl.querySelectorAll(".list-item").forEach((x) => x.style.background = "");
      el.style.background = "rgba(59,130,246,0.12)";
      const rel = el.dataset.rel;
      const f = await api("/api/file?path=" + encodeURIComponent(rel));
      renderReaderWithAI($("#wikiReader"), rel, f, { pane: true });
    }));
  }
  tabEl.querySelectorAll(".tag").forEach((t) => t.addEventListener("click", () => {
    tabEl.querySelectorAll(".tag").forEach((x) => x.style.opacity = "0.5");
    t.style.opacity = "1";
    renderList(t.dataset.type);
  }));
  tabEl.querySelectorAll(".tag")[0].style.opacity = "1";
  renderList("全部");
}

/* --- 头脑风暴 --- */
async function renderBrainstorm(c) {
  c.innerHTML = `<div class="page active">
    <div class="card">
      <h3>💡 头脑风暴 — 读库 → 追问 → 写回</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:12px;">输入一个真实问题，AI 检索知识层与素材库，返回相关片段；基于片段头脑风暴，新认知可写回知识库。</p>
      <textarea class="brain-input" id="bsQ" placeholder="例：江西公共数据授权运营的价格机制是什么？与浙江有什么差异？"></textarea>
      <div style="display:flex;gap:10px;margin-top:10px;align-items:center;">
        <button class="btn" id="bsGo">🔍 检索并头脑风暴</button>
        <span style="font-size:11px;color:var(--text3);">检索范围：知识层 + 素材库（关键词匹配）</span>
      </div>
    </div>
    <div id="bsResult" style="margin-top:14px;display:flex;flex-direction:column;gap:10px;"></div>
  </div>`;
  $("#bsGo").addEventListener("click", async () => {
    const q = $("#bsQ").value.trim();
    if (!q) return;
    const btn = $("#bsGo");
    btn.disabled = true; btn.textContent = "检索中…";
    const res = await doSearch(q, { limit: 20 });
    const scope = await doSearch(q, { limit: 20, filter: (doc) => doc.rel.startsWith("知识层/") });
    btn.disabled = false; btn.textContent = "🔍 检索并头脑风暴";
    $("#bsResult").innerHTML = `
      <div class="card">
        <h3>🧠 相关片段（${res.length + scope.length} 条命中）</h3>
        <div style="display:flex;flex-direction:column;gap:8px;max-height:360px;overflow-y:auto;">
          ${[...scope, ...res].slice(0, 12).map((h) => `
            <div class="hit" data-rel="${esc(h.rel)}">
              <div class="t">${esc(h.title)} <span style="font-size:10px;color:var(--text3);">${esc(h.rel)}</span></div>
              <div class="s">${h.content ? buildSnippet(h.content, extractTerms(q)) : "(标题命中)"}</div>
            </div>`).join("") || "<div style='color:var(--text3)'>无命中，换关键词试试</div>"}
        </div>
      </div>
      <div class="card">
        <h3>✍️ 头脑风暴写回（新认知沉淀）</h3>
        <p style="font-size:12px;color:var(--text2);margin-bottom:8px;">基于检索结果，把结论/洞察写在这里，保存后入库 输出/查询/drafts/。</p>
        <input class="brain-input" id="bsTitle" placeholder="草稿标题（必填）" style="min-height:0;padding:10px 14px;margin-bottom:10px;">
        <textarea class="brain-input" id="bsContent" placeholder="结论 / 洞察 / 追问…" style="min-height:140px;"></textarea>
        <div style="margin-top:10px;"><button class="btn ghost" id="bsSave">💾 写回知识库（存草稿）</button></div>
      </div>`;
    $("#bsResult").querySelectorAll(".hit").forEach((el) => el.addEventListener("click", () => openFile(el.dataset.rel)));
    $("#bsSave").addEventListener("click", async () => {
      const title = $("#bsTitle").value.trim();
      const content = $("#bsContent").value.trim();
      if (!title || !content) { alert("标题与内容必填"); return; }
      const r = await fetch(API + "/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content }) });
      const j = await r.json();
      alert(j.ok ? "已写回：" + j.file : "失败：" + j.error);
      if (j.ok) { $("#bsTitle").value = ""; $("#bsContent").value = ""; }
    });
  });
}

/* --- AI 对话（信箱桥：提问入箱 → Agent 回答 → 取回展示）--- */
let aiTimer = null;
async function renderAIchat(c) {
  if (aiTimer) { clearInterval(aiTimer); aiTimer = null; }
  c.innerHTML = `<div class="page active">
    <div class="card" style="margin-bottom:14px;">
      <h3>🤖 AI 对话 — 读库 → 追问 → 写回</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:10px;">提问入箱（inbox）→ Agent 读取知识库回答 → 回答写回（answers）→ 本页自动取回。Agent 处理中请稍候，页面每 10 秒自动刷新。</p>
      <textarea class="brain-input" id="aiAskQ" placeholder="例：基于知识库，江西公共数据授权运营的价格机制是什么？与浙江有何差异？"></textarea>
      <div style="display:flex;gap:10px;margin-top:10px;align-items:center;">
        <button class="btn" id="aiAskGo">📮 发送给 WorkBuddy</button>
        <span id="aiAskInfo" style="font-size:11px;color:var(--text3);"></span>
      </div>
    </div>
    <div class="card" id="aiPending" style="margin-bottom:14px;display:none;">
      <h3>⏳ 处理中（inbox）</h3>
      <div id="aiPendingList"></div>
    </div>
    <div class="card">
      <h3>💬 历史提问（answers）<span style="font-weight:400;font-size:11px;color:var(--text3);"> · 可勾选后一键入库</span></h3>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
        <label style="font-size:12px;color:var(--text2);display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="aiSelAll"> 全选</label>
        <span style="font-size:11px;color:var(--text3);" id="aiSelCount">已选 0 条</span>
        <button class="btn ghost" id="aiSelIngest" style="margin-left:auto;padding:6px 14px;">📥 勾选入库</button>
      </div>
      <div id="aiThread" style="display:flex;flex-direction:column;gap:10px;"></div>
    </div>
  </div>`;
  $("#aiAskGo").addEventListener("click", doAsk);
  $("#aiAskQ").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doAsk(); });
  $("#aiSelAll").addEventListener("change", () => {
    const all = $("#aiSelAll").checked;
    document.querySelectorAll(".ai-sel-cb").forEach((cb) => { cb.checked = all; });
    updateSelCount();
  });
  $("#aiSelIngest").addEventListener("click", ingestSelected);
  await refreshAIthread();
  aiTimer = setInterval(refreshAIthread, 10000);
  function updateSelCount() {
    const n = document.querySelectorAll(".ai-sel-cb:checked").length;
    $("#aiSelCount").textContent = `已选 ${n} 条`;
  }
  async function ingestSelected() {
    const cbs = [...document.querySelectorAll(".ai-sel-cb:checked")];
    if (!cbs.length) { alert("请先勾选要入库的历史提问"); return; }
    const title = $("#aiIngestTitle") && $("#aiIngestTitle").value.trim() ? $("#aiIngestTitle").value.trim() : "历史提问精选-" + new Date().toISOString().slice(0, 10);
    const parts = [`# ${title}`, "", `> 入库时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`, ""];
    let n = 0;
    for (const cb of cbs) {
      const item = JSON.parse(cb.dataset.ans || "{}");
      if (!item.question) continue;
      n++;
      parts.push(`## ${n}. ${item.question}`, "", `> 提问时间：${item.answeredAt || ""}`, "");
      if (item.inbox && /原文引用/.test(item.inbox)) {
        const m = item.inbox.match(/【原文引用】([\s\S]*?)(?:\n\n【全文上下文】|$)/);
        if (m && m[1].trim()) parts.push(`> **原文引用：** ${m[1].trim().slice(0, 200)}`, "");
      }
      parts.push(`**回答：**`, "", item.body || "", "");
    }
    if (!n) { alert("所选条目缺少问题信息"); return; }
    const r = await fetch(API + "/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content: parts.join("\n") }) });
    const j = await r.json();
    alert(j.ok ? `✅ 已入库 ${n} 条：${j.file}` : "入库失败：" + j.error);
  }
  async function doAsk() {
    const q = $("#aiAskQ").value.trim();
    if (!q) return;
    const btn = $("#aiAskGo");
    btn.disabled = true;
    try {
      const r = await fetch(API + "/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
      const j = await r.json();
      if (j.ok) {
        /* 立即唤醒 WorkBuddy 取件 */
        let wakeNote = "";
        try {
          const w = await fetch(API + "/api/trigger", { method: "POST" });
          const wj = await w.json();
          wakeNote = wj.ok ? "" : `（唤醒失败：${esc(wj.error || "")}，将按每小时兜底）`;
        } catch (e) { wakeNote = "（唤醒失败，将按每小时兜底）"; }
        $("#aiAskInfo").textContent = "已发送给 WorkBuddy，处理中…（约 1 分钟内回）" + wakeNote;
        $("#aiAskQ").value = "";
        await refreshAIthread();
      } else {
        $("#aiAskInfo").textContent = "失败：" + j.error;
      }
    } catch (e) { $("#aiAskInfo").textContent = "提交失败：" + e.message; }
    btn.disabled = false;
  }
}

async function refreshAIthread() {
  const pending = await api("/api/inbox");
  const answers = await api("/api/answers");
  const pEl = $("#aiPending");
  const plEl = $("#aiPendingList");
  if (pending.length) {
    pEl.style.display = "";
    plEl.innerHTML = pending.map((p) => `
      <div style="padding:8px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;font-size:13px;color:var(--text2);">
        <span style="color:var(--amber);">⏳</span> ${esc(p.question.slice(0, 80))}
        <span style="margin-left:auto;font-size:11px;color:var(--text3);">${esc(p.askedAt || "")}</span>
      </div>`).join("");
  } else {
    pEl.style.display = "none";
  }
  const tEl = $("#aiThread");
  if (!tEl) return;
  /* 保留已勾选状态（10s 轮询刷新时不清空用户选择） */
  const prevChecked = new Set();
  tEl.querySelectorAll(".ai-sel-cb:checked").forEach((cb) => prevChecked.add(cb.dataset.id));
  tEl.innerHTML = answers.length ? answers.map((a) => `
    <div style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--bg2);">
      <div style="display:flex;gap:10px;align-items:flex-start;">
        <input type="checkbox" class="ai-sel-cb" data-id="${esc(a.id)}" data-ans='${esc(JSON.stringify({ question: a.question, body: a.body, answeredAt: a.answeredAt, inbox: a.inbox || "" }))}' ${prevChecked.has(a.id) ? "checked" : ""} style="margin-top:3px;flex-shrink:0;" onchange="document.querySelector('#aiSelAll').checked = document.querySelectorAll('.ai-sel-cb:checked').length === document.querySelectorAll('.ai-sel-cb').length; document.querySelector('#aiSelCount').textContent = '已选 ' + document.querySelectorAll('.ai-sel-cb:checked').length + ' 条';">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:500;color:var(--acc2);margin-bottom:2px;">❓ ${esc(a.question || a.name)} ${a.hasContext ? '<span style="font-size:10px;background:rgba(111,76,255,.10);color:var(--acc2);padding:1px 7px;border-radius:999px;margin-left:4px;">带原文引用</span>' : ""}</div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:8px;">${esc(a.answeredAt || "")} · <a class="open-answer" data-rel="${esc(a.rel)}" style="cursor:pointer;">打开全文 ↗</a></div>
          <div class="reader" style="font-size:12.5px;max-height:140px;overflow:hidden;position:relative;">${mdToHtml(a.body || "")}</div>
        </div>
      </div>
    </div>`).join("") : `<div style="color:var(--text3);font-size:13px;padding:20px 0;text-align:center;">暂无对话记录 — 提交一个问题，Agent 会读库回答</div>`;
  tEl.querySelectorAll(".open-answer").forEach((x) => x.addEventListener("click", () => openFile(x.dataset.rel)));
  updateSelCountGlobal();
  function updateSelCountGlobal() {
    const sc = $("#aiSelCount");
    if (sc) sc.textContent = `已选 ${document.querySelectorAll(".ai-sel-cb:checked").length} 条`;
  }
}

/* --- __USER_NAME__的日常（拆分为 待办 / 记账 两个独立页）--- */
let dailyDate = fmtDate(new Date());
let dailyMonth = dailyDate.slice(0, 7);
let dailyState = { todos: [], works: [], entries: [], done: [], allTodos: [] };
let meetingList = [];
let catData = { expense: [], income: [] };
function dateNavHTML() {
  dailyMonth = dailyMonth || dailyDate.slice(0, 7);
  return `<div class="card daily-cal-card" style="margin-bottom:14px;">
    <div class="dcal-top">
      <div>
        <div class="dcal-title">${dailyMonth.replace("-", "年")}月</div>
        <div class="dcal-sub">当前选中：${dailyDate} · ${weekdayCN(dailyDate)}</div>
      </div>
      <div class="dcal-actions">
        <button class="btn ghost dcal-nav" id="dMonthPrev">‹ 上月</button>
        <button class="btn ghost dcal-nav" id="dToday">今天</button>
        <button class="btn ghost dcal-nav" id="dMonthNext">下月 ›</button>
      </div>
      <span id="dSaved" class="dcal-saved"></span>
    </div>
    <div class="dcal-weekrow">${["一", "二", "三", "四", "五", "六", "日"].map((w) => `<span>${w}</span>`).join("")}</div>
    <div class="daily-calendar" id="dCalendarGrid"><div class="dcal-loading">日历加载中…</div></div>
    <div class="dcal-legend">
      <span><i class="lg-todo"></i> 有待办日期标黄</span>
      <span><i class="lg-done"></i> 已办结日期底部蓝线</span>
      <span><i class="lg-selected"></i> 当前选中日期</span>
    </div>
  </div>`;
}
async function loadDailyBase() {
  const d = await api("/api/daily?date=" + dailyDate);
  dailyState = { todos: d.todos || [], works: d.works || [], entries: d.entries || [], done: d.done || [], allTodos: d.allTodos || [], allDone: d.allDone || [] };
  const list = await api("/api/daily/list");
  const mp = $("#dMonthPrev"), mn = $("#dMonthNext"), mt = $("#dToday");
  if (mp) mp.addEventListener("click", async () => { dailyMonth = shiftMonth(dailyMonth, -1); renderDailyCalendar(await api("/api/daily/list")); });
  if (mn) mn.addEventListener("click", async () => { dailyMonth = shiftMonth(dailyMonth, 1); renderDailyCalendar(await api("/api/daily/list")); });
  if (mt) mt.addEventListener("click", () => { dailyDate = fmtDate(new Date()); dailyMonth = dailyDate.slice(0, 7); renderPage(currentPage); });
  await renderDailyCalendar(list);
  return d;
}
async function renderDailyCalendar(list) {
  const grid = $("#dCalendarGrid");
  const title = document.querySelector(".dcal-title");
  const sub = document.querySelector(".dcal-sub");
  if (!grid) return;
  if (title) title.textContent = dailyMonth.replace("-", "年") + "月";
  if (sub) sub.textContent = `当前选中：${dailyDate} · ${weekdayCN(dailyDate)}`;
  grid.innerHTML = `<div class="dcal-loading">日历加载中…</div>`;
  const monthDates = (list || []).filter((x) => x.startsWith(dailyMonth));
  const status = {};
  await Promise.all(monthDates.map(async (date) => {
    try {
      const d = date === dailyDate ? dailyState : await api("/api/daily?date=" + date);
      const todos = d.todos || [];
      const done = d.done || [];
      status[date] = {
        todo: todos.length,
        openTodo: todos.filter((t) => !t.done).length,
        done: done.length,
      };
    } catch { status[date] = { todo: 0, openTodo: 0, done: 0 }; }
  }));
  const [y, m] = dailyMonth.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const offset = (first.getDay() + 6) % 7;
  const today = fmtDate(new Date());
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(`<div class="dcal-empty"></div>`);
  for (let day = 1; day <= days; day++) {
    const date = `${dailyMonth}-${String(day).padStart(2, "0")}`;
    const st = status[date] || { todo: 0, openTodo: 0, done: 0 };
    const cls = ["dcal-day"];
    if (date === dailyDate) cls.push("selected");
    if (date === today) cls.push("today");
    if (st.todo > 0) cls.push("has-todo");
    if (st.done > 0) cls.push("has-done");
    cells.push(`<button class="${cls.join(" ")}" data-date="${date}" title="${date}${st.todo ? ` · 待办 ${st.todo}` : ""}${st.done ? ` · 已办 ${st.done}` : ""}">
      <span class="dcal-num">${day}</span>
      ${(st.todo || st.done) ? `<span class="dcal-counts">${st.todo ? `待 ${st.todo}` : ""}${st.todo && st.done ? " · " : ""}${st.done ? `办 ${st.done}` : ""}</span>` : ""}
    </button>`);
  }
  grid.innerHTML = cells.join("");
  grid.querySelectorAll(".dcal-day").forEach((b) => b.addEventListener("click", () => {
    dailyDate = b.dataset.date;
    dailyMonth = dailyDate.slice(0, 7);
    renderPage(currentPage);
  }));
}
function dflash(msg) { const el = $("#dSaved"); if (el) { el.textContent = msg; setTimeout(() => { el.textContent = ""; }, 2500); } }
/* --- 待办页 --- */
async function renderTodoPage(c) {
  if (!meetingList.length) { try { meetingList = await api("/api/meetings"); } catch {} }
  c.innerHTML = `<div class="page active">${dateNavHTML()}
    <div class="card daily-work-card">
      <h3>🛠 每日工作</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:10px;">按时间记录今天做了什么 · 每晚 20:00 自动生成日报 · 每周六 20:00 自动生成周报</p>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <input class="brain-input" id="dWorkTime" placeholder="时间（可选，如 09:30）" style="min-height:0;padding:9px 12px;font-size:13px;width:110px;flex:0 0 auto;">
        <input class="brain-input" id="dWorkInput" placeholder="做了什么…（回车即存）" style="min-height:0;padding:9px 12px;font-size:13px;flex:1;">
        <button class="btn" id="dWorkAdd" style="padding:9px 14px;white-space:nowrap;">➕ 记录</button>
      </div>
      <div id="dWorkList"></div>
    </div>
    <div class="card" style="margin-top:14px;">
      <h3>📋 待办事项</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:12px;">按日一页 · 智能排期（时间词自动归档）· 依赖链：<span class="dep-badge dep-wait" style="cursor:default;">⏳ 等待前置</span> 与 <span class="dep-down" style="cursor:default;">🔗 下游依赖</span>（悬浮查看）· 勾选完成 → 可「办结归档」</p>
      <div style="display:flex;gap:8px;margin:10px 0 14px;">
        <input class="brain-input" id="dTodoInput" placeholder="添加待办…（回车即存；带时间词自动排期）" style="min-height:0;padding:9px 12px;font-size:13px;">
        <button class="btn" id="dTodoAdd" style="padding:9px 14px;white-space:nowrap;">➕ 添加</button>
      </div>
      <div id="dTodoList"></div>
    </div>
    <div class="card" style="margin-top:14px;">
      <h3>✅ 已办结事项</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:10px;">与待办对应 · 涉及会议的挂会议纪要（📄 点击阅读）</p>
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:12px;align-items:center;">
        <input class="brain-input" id="dDoneInput" placeholder="办结事项…（如：金融团队业务周会）" style="min-height:0;padding:9px 12px;font-size:13px;">
        <select id="dDoneMeeting" style="background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:8px;font-size:12px;">
          <option value="">📄 关联会议纪要（可选）</option>
          ${meetingList.map((m) => `<option value="${esc(m.rel)}">${esc(m.name)}</option>`).join("")}
        </select>
        <button class="btn" id="dDoneAdd" style="padding:9px 14px;white-space:nowrap;">🎉 办结</button>
      </div>
      <div id="dDoneList"></div>
    </div>
  </div>`;
  await loadDailyBase();
  $("#dWorkAdd").addEventListener("click", addWork);
  $("#dWorkInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addWork(); });
  $("#dTodoAdd").addEventListener("click", addTodo);
  $("#dTodoInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
  $("#dDoneAdd").addEventListener("click", addDone);
  $("#dDoneInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addDone(); });
  renderWorkList();
  renderTodoList();
  renderDoneList();
  async function addWork() {
    const v = $("#dWorkInput").value.trim();
    if (!v) return;
    const time = $("#dWorkTime").value.trim();
    dailyState.works.push({ time, text: v });
    $("#dWorkInput").value = ""; $("#dWorkTime").value = "";
    await saveDaily(); renderWorkList();
  }
  function renderWorkList() {
    const box = $("#dWorkList");
    if (!box) return;
    box.innerHTML = dailyState.works.length ? dailyState.works.map((w, i) => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;font-size:13.5px;background:rgba(111,76,255,0.045);">
        <span style="font-size:13px;font-weight:700;color:var(--acc);white-space:nowrap;min-width:52px;flex-shrink:0;">${w.time ? esc(w.time) : "—"}</span>
        <span style="flex:1;min-width:0;word-break:break-word;">${esc(w.text)}</span>
        <button class="btn ghost d-work-edit" data-i="${i}" title="编辑时间/内容" style="flex-shrink:0;padding:3px 8px;font-size:11px;color:var(--acc);">✏️</button>
        <button class="btn ghost d-work-del" data-i="${i}" style="flex-shrink:0;padding:3px 8px;font-size:11px;color:var(--red);">✕</button>
      </div>`).join("") : `<div style="color:var(--text3);font-size:13px;padding:14px 0;text-align:center;">今天还没有工作记录，记录一下做了什么吧 ✍️</div>`;
    box.querySelectorAll(".d-work-del").forEach((el) => el.addEventListener("click", () => { dailyState.works.splice(Number(el.dataset.i), 1); saveDaily(); renderWorkList(); }));
    box.querySelectorAll(".d-work-edit").forEach((el) => el.addEventListener("click", async () => {
      const w = dailyState.works[Number(el.dataset.i)];
      if (!w) return;
      const sel = await dPrompt("✏️ 编辑工作记录", [
        { id: "time", label: "时间（可选，如 14:30）", value: w.time || "" },
        { id: "text", label: "工作内容", value: w.text }
      ]);
      if (!sel) return;
      const nt = (sel.time || "").trim();
      const nx = (sel.text || "").trim();
      if (!nx) { dflash("内容不能为空，未保存"); return; }
      w.time = nt; w.text = nx;
      saveDaily(); renderWorkList();
    }));
  }
  async function addTodo() {
    const v = $("#dTodoInput").value.trim();
    if (!v) return;
    const today = fmtDate(new Date());
    const target = dailyDate === today ? parseTodoDate(v) : null;
    if (target && target !== today) {
      const td = await api("/api/daily?date=" + target);
      const tlist = td.todos || [];
      tlist.push({ done: false, text: v });
      await fetch(API + "/api/daily", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: target, todos: tlist, works: td.works || [], entries: td.entries || [], done: td.done || [] }) });
      $("#dTodoInput").value = "";
      dflash("⏰ 已排到 " + target + "（" + weekdayCN(target) + "）的待办");
      return;
    }
    dailyState.todos.push({ done: false, text: v });
    $("#dTodoInput").value = "";
    await saveDaily(); renderTodoList();
  }
  async function addDone() {
    const v = $("#dDoneInput").value.trim();
    if (!v) return;
    dailyState.done.push({ date: dailyDate, text: v, meeting: $("#dDoneMeeting").value || undefined });
    $("#dDoneInput").value = ""; $("#dDoneMeeting").value = "";
    await saveDaily(); renderDoneList();
  }
  async function saveDaily() {
    const r = await fetch(API + "/api/daily", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: dailyDate, todos: dailyState.todos, works: dailyState.works, entries: dailyState.entries, done: dailyState.done }) });
    const j = await r.json();
    dflash(j.ok ? "已保存 · " + dailyDate : "保存失败：" + j.error);
  }
  /* 通用输入弹层：替代 window.prompt（Electron 渲染进程不支持 prompt，调用即抛错）
   * fields: [{ id, label, value, type: "text"|"select"|"searchselect", placeholder, options, initial, search }]
   *   select 用 options；searchselect = 搜索框 + 结果列表，search(kw) → [{v,l}...]，initial 为预置项
   * 返回 Promise：确定 → { id: value, ... }；取消/点遮罩 → null */
  function dPrompt(title, fields) {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "te-mask";
      mask.innerHTML = `
        <div class="te-box">
          <h3>${esc(title)}</h3>
          ${fields.map((f, i) => {
            if (f.type === "select") {
              return `
            <label>${esc(f.label)}</label>
            <select id="dpF${i}" data-fid="${esc(f.id || "f" + i)}">
              ${(f.options || []).map((o) => { const ov = typeof o === "string" ? o : o.v; const ol = typeof o === "string" ? o : (o.l || o.v); return `<option value="${esc(ov)}" ${f.value === ov ? "selected" : ""}>${esc(ol)}</option>`; }).join("")}
            </select>`;
            }
            if (f.type === "searchselect") {
              return `
            <label>${esc(f.label)}</label>
            <input type="text" id="dpQ${i}" placeholder="${esc(f.placeholder || "输入关键词搜索…")}">
            <select id="dpS${i}" data-fid="${esc(f.id || "f" + i)}" size="6" style="width:100%;margin-top:8px;height:auto;background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:11px;padding:6px;font-size:13px;">
              ${(f.initial || []).map((o) => { const ov = typeof o === "string" ? o : o.v; const ol = typeof o === "string" ? o : (o.l || o.v); return `<option value="${esc(ov)}" ${f.value === ov ? "selected" : ""}>${esc(ol)}</option>`; }).join("")}
            </select>`;
            }
            return `
            <label>${esc(f.label)}</label>
            <input type="text" id="dpF${i}" data-fid="${esc(f.id || "f" + i)}" value="${esc(f.value || "")}" placeholder="${esc(f.placeholder || "")}">`;
          }).join("")}
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
            <button class="btn ghost" id="dpCancel">取消</button>
            <button class="btn" id="dpOk">💾 确定</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      /* searchselect：搜索框防抖调 search() 刷新结果列表 */
      fields.forEach((f, i) => {
        if (f.type !== "searchselect" || typeof f.search !== "function") return;
        const q = document.getElementById("dpQ" + i);
        const sel = document.getElementById("dpS" + i);
        if (!q || !sel) return;
        let timer = null;
        const refresh = async (kw) => {
          try {
            const items = await f.search(kw);
            const cur = sel.value;
            sel.innerHTML = (items && items.length ? items : [{ v: "", l: "（无结果）" }]).map((o) => { const ov = typeof o === "string" ? o : o.v; const ol = typeof o === "string" ? o : (o.l || o.v); return `<option value="${esc(ov)}">${esc(ol)}</option>`; }).join("");
            if (cur && Array.from(sel.options).some((o) => o.value === cur)) sel.value = cur;
          } catch (e) { sel.innerHTML = `<option value="">（搜索失败）</option>`; }
        };
        q.addEventListener("input", () => {
          clearTimeout(timer);
          timer = setTimeout(() => refresh(q.value.trim()), 300);
        });
        refresh("");
      });
      const close = (val) => { mask.remove(); resolve(val); };
      $("#dpCancel").addEventListener("click", () => close(null));
      mask.addEventListener("click", (e) => { if (e.target === mask) close(null); });
      $("#dpOk").addEventListener("click", () => {
        const out = {};
        mask.querySelectorAll("[data-fid]").forEach((el) => { out[el.dataset.fid] = el.value; });
        close(out);
      });
      const first = mask.querySelector("input, select");
      if (first) setTimeout(() => first.focus(), 60);
    });
  }
  function renderTodoList() {
    const box = $("#dTodoList");
    box.innerHTML = dailyState.todos.length ? dailyState.todos.map((t, i) => {
      const dep = depInfo(t);
      const down = downInfo(t);
      return `
      <div style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;font-size:13.5px;cursor:pointer;" data-i="${i}">
        <span style="flex-shrink:0;font-size:15px;color:${t.done ? "var(--green)" : "var(--text3)"};">${t.done ? "✅" : "⬜"}</span>
        <span style="flex:1 1 auto;min-width:0;word-break:break-word;${t.done ? "text-decoration:line-through;color:var(--text3);" : ""}">${esc(t.text)}</span>
        ${down}
        ${t.done ? `<button class="btn ghost d-archive" data-i="${i}" style="flex-shrink:0;padding:3px 8px;font-size:11px;color:var(--green);">🎉 办结归档</button>` : ""}
        <button class="btn ghost d-edit" data-i="${i}" title="编辑待办（时间/内容/依赖）" style="flex-shrink:0;padding:3px 8px;font-size:11px;color:var(--acc);">✏️</button>
        <button class="btn ghost d-del" data-i="${i}" style="flex-shrink:0;padding:3px 8px;font-size:11px;color:var(--red);">✕</button>
        ${dep ? `<div style="flex-basis:100%;margin:-2px 0 0 25px;font-size:11.5px;min-width:0;word-break:break-word;">${dep.html}</div>` : ""}
      </div>`;}).join("") : `<div style="color:var(--text3);font-size:13px;padding:16px 0;text-align:center;">今天还没有待办，加一条吧 ✍️</div>`;
    box.querySelectorAll("[data-i]").forEach((el) => {
      if (el.classList.contains("d-edit")) el.addEventListener("click", (e) => { e.stopPropagation(); openTodoEditor(Number(el.dataset.i)); });
      else if (el.classList.contains("d-del")) el.addEventListener("click", (e) => { e.stopPropagation(); dailyState.todos.splice(Number(el.dataset.i), 1); saveDaily(); renderTodoList(); });
      else if (el.classList.contains("d-archive")) el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const t = dailyState.todos[Number(el.dataset.i)];
        if (!t) return;
        /* 直接归档（不再弹窗询问会议 —— Electron 不支持 window.prompt，会抛错中断）：
           需要挂会议纪要时，归档后点已办结列表的「📎 纪要」按钮补关联 */
        dailyState.todos.splice(Number(el.dataset.i), 1);
        dailyState.done.unshift({ date: dailyDate, text: t.text, meeting: undefined });
        await saveDaily(); renderTodoList(); renderDoneList();
        dflash("🎉 已办结归档 · 可点「📎 纪要」挂会议纪要");
      });
      else el.addEventListener("click", (e) => { if (e.target.closest(".dep-wait") || e.target.closest(".dep-down")) return; dailyState.todos[Number(el.dataset.i)].done = !dailyState.todos[Number(el.dataset.i)].done; saveDaily(); renderTodoList(); });
    });
    box.querySelectorAll(".dep-wait").forEach((el) => el.addEventListener("click", () => { dailyDate = el.dataset.dep; renderPage(currentPage); }));
    box.querySelectorAll(".dep-down").forEach((el) => el.addEventListener("click", () => { if (el.dataset.go) { dailyDate = el.dataset.go; renderPage(currentPage); } }));
  }
  function renderDoneList() {
    const box = $("#dDoneList");
    box.innerHTML = dailyState.done.length ? dailyState.done.map((d, i) => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;font-size:13.5px;background:rgba(34,197,94,0.06);">
        <span style="flex-shrink:0;font-size:15px;color:var(--green);">✅</span>
        <span style="flex:1;min-width:0;word-break:break-word;">${esc(d.text)}</span>
        ${d.meeting ? `<button class="btn ghost d-meeting" data-rel="${esc(d.meeting)}" title="打开关联文档" style="flex-shrink:0;padding:3px 9px;font-size:11px;color:var(--acc);">📄 打开</button>` : ""}
        <button class="btn ghost d-donemeet" data-i="${i}" title="关联 / 更换 / 清除文档（任意文档 · 可搜索或上传）" style="flex-shrink:0;padding:3px 9px;font-size:11px;color:${d.meeting ? "var(--amber)" : "var(--acc)"};">${d.meeting ? "🔁" : "📎"} 文档</button>
        <span style="flex-shrink:0;font-size:11px;color:var(--text3);white-space:nowrap;">${esc(d.date)}</span>
        <button class="btn ghost d-donerestore" data-i="${i}" title="误点了？还原为未办结待办" style="flex-shrink:0;padding:3px 8px;font-size:11px;color:var(--amber);">↩️ 还原</button>
        <button class="btn ghost d-donedel" data-i="${i}" style="flex-shrink:0;padding:3px 8px;font-size:11px;color:var(--red);">✕</button>
      </div>`).join("") : `<div style="color:var(--text3);font-size:13px;padding:14px 0;text-align:center;">暂无已办结事项 · 待办勾选完成后可「办结归档」</div>`;
    box.querySelectorAll(".d-meeting").forEach((el) => el.addEventListener("click", () => openFile(el.dataset.rel)));
    box.querySelectorAll(".d-donemeet").forEach((el) => el.addEventListener("click", async () => {
      const d = dailyState.done[Number(el.dataset.i)];
      if (!d) return;
      const curName = d.meeting ? d.meeting.split("/").pop().replace(/\.(md|docx)$/i, "") : "";
      const sel = await dPrompt("📎 关联文档（任意文档 · 可搜索）", [{
        id: "doc", label: "搜索并选择文档（输入关键词过滤，或直接滚动选择）", type: "searchselect",
        value: d.meeting || "",
        initial: d.meeting ? [{ v: d.meeting, l: "（当前）" + curName }] : [],
        search: async (kw) => {
          const list = await api("/api/docs?q=" + encodeURIComponent(kw));
          return [{ v: "__upload__", l: "➕ 上传新文档（md / txt / docx）" }].concat(list.map((x) => ({ v: x.rel, l: (x.scope ? "[" + x.scope + "] " : "") + x.name })));
        }
      }]);
      if (!sel) return;
      if (sel.doc === "__upload__") {
        /* 上传新文档：选完本地文件即传即关联 */
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".md,.txt,.docx";
        input.onchange = async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          const fd = new FormData();
          fd.append("file", file);
          dflash("📤 上传中…");
          try {
            const r = await fetch(API + "/api/meetings/upload", { method: "POST", body: fd });
            const j = await r.json();
            if (!j.ok) { dflash("上传失败：" + (j.error || "")); return; }
            d.meeting = j.rel;
            await saveDaily(); renderDoneList();
            dflash("📤 已上传并关联：" + j.name);
          } catch (e) { dflash("上传失败：" + e.message); }
        };
        input.click();
        return;
      }
      d.meeting = sel.doc || undefined;
      await saveDaily(); renderDoneList();
      dflash(sel.doc ? "📎 已关联文档" : "已清除文档关联");
    }));
    box.querySelectorAll(".d-donerestore").forEach((el) => el.addEventListener("click", () => {
      const d = dailyState.done[Number(el.dataset.i)];
      if (!d) return;
      dailyState.done.splice(Number(el.dataset.i), 1);
      const target = d.date || dailyDate;
      if (target === dailyDate) {
        dailyState.todos.push({ done: false, text: d.text });
        saveDaily(); renderTodoList(); renderDoneList();
      } else {
        api("/api/daily?date=" + target).then((td) => {
          const tlist = td.todos || [];
          tlist.push({ done: false, text: d.text });
          fetch(API + "/api/daily", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: target, todos: tlist, works: td.works || [], entries: td.entries || [], done: td.done || [] }) });
        });
        saveDaily(); renderDoneList();
        dflash("↩️ 已还原到 " + target + " 的待办（" + weekdayCN(target) + "）");
      }
    }));
    box.querySelectorAll(".d-donedel").forEach((el) => el.addEventListener("click", () => { dailyState.done.splice(Number(el.dataset.i), 1); saveDaily(); renderDoneList(); }));
  }
  /* 待办编辑弹层：可修改日期（跨日移动）、时段、内容、前置依赖关键词 */
  function openTodoEditor(i) {
    const t = dailyState.todos[i];
    if (!t) return;
    let period = "", content = t.text;
    const pm = content.match(/^(上午|中午|下午|晚上|早上|傍晚|凌晨)[:：]?\s*/);
    if (pm) { period = pm[1]; content = content.slice(pm[0].length); }
    let dep = "";
    const dm = content.match(/（依赖：([^）]+)）/);
    if (dm) { dep = dm[1].trim(); content = content.replace(/（依赖：[^）]+）/g, "").trim(); }
    closeTodoEditor();
    const mask = document.createElement("div");
    mask.className = "te-mask";
    mask.id = "teMask";
    mask.innerHTML = `
      <div class="te-box">
        <h3>✏️ 编辑待办</h3>
        <label>日期</label>
        <input type="date" id="teDate" value="${dailyDate}">
        <label>时段</label>
        <select id="tePeriod">
          <option value="">（无 · 全天）</option>
          <option>上午</option><option>中午</option><option>下午</option>
          <option>晚上</option><option>早上</option><option>傍晚</option><option>凌晨</option>
        </select>
        <label>内容</label>
        <input type="text" id="teContent" value="${esc(content)}" placeholder="待办内容…">
        <label>前置依赖（关键词，可留空）</label>
        <input type="text" id="teDep" value="${esc(dep)}" placeholder="如：对接情况表 — 下游待办会自动同步识别">
        <p style="font-size:11px;color:var(--text3);margin-top:10px;">💡 改日期会把这条待办移动到目标日；改依赖关键词会同步更新上下游徽标。</p>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
          <button class="btn ghost" id="teCancel">取消</button>
          <button class="btn" id="teSave">💾 保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    $("#tePeriod").value = period;
    $("#teCancel").addEventListener("click", closeTodoEditor);
    mask.addEventListener("click", (e) => { if (e.target === mask) closeTodoEditor(); });
    $("#teContent").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#teSave").click(); });
    $("#teSave").addEventListener("click", () => saveTodoEditor(i, mask));
  }
  function closeTodoEditor() { const m = $("#teMask"); if (m) m.remove(); }
  async function saveTodoEditor(i, mask) {
    const t = dailyState.todos[i];
    if (!t) return;
    const date = $("#teDate").value || dailyDate;
    const period = $("#tePeriod").value.trim();
    const content = $("#teContent").value.trim();
    const dep = $("#teDep").value.trim();
    if (!content) { alert("内容不能为空"); return; }
    let text = (period ? period + "：" : "") + content;
    if (dep) text += "（依赖：" + dep + "）";
    mask.remove();
    if (date === dailyDate) {
      t.text = text;
      await saveDaily();
      renderTodoList(); renderDoneList();
      dflash("✏️ 已更新待办");
    } else {
      const td = await api("/api/daily?date=" + date);
      const tlist = td.todos || [];
      tlist.push({ done: t.done, text });
      await fetch(API + "/api/daily", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: date, todos: tlist, works: td.works || [], entries: td.entries || [], done: td.done || [] }) });
      dailyState.todos.splice(i, 1);
      await saveDaily();
      renderTodoList(); renderDoneList();
      dflash("✏️ 已移动到 " + date + "（" + weekdayCN(date) + "）的待办");
      renderDailyCalendar(await api("/api/daily/list"));
    }
  }
  /* 前置依赖：文本「（依赖：关键词）」→ 全库找对应待办 → 状态徽标 */
  function depInfo(t) {
    const m = t.text.match(/（依赖：([^）]+)）/);
    if (!m) return null;
    const kw = m[1].trim();
    const hit = (dailyState.allTodos || []).find((a) => a.date !== dailyDate && a.text.includes(kw));
    /* 前置待办若已办结归档，待办索引里找不到 → 查已办结索引 */
    const doneHit = !hit ? (dailyState.allDone || []).find((a) => a.date !== dailyDate && a.text.includes(kw)) : null;
    let html;
    if (hit) {
      if (hit.done) html = `<span class="dep-badge dep-ready">✅ 前置就绪：${esc(kw)}（${esc(hit.date)}）</span>`;
      else html = `<span class="dep-badge dep-wait" data-dep="${esc(hit.date)}">⏳ 等待前置：${esc(kw)}（${esc(hit.date)}，点此查看）</span>`;
    } else if (doneHit) {
      html = `<span class="dep-badge dep-ready">✅ 前置已办结：${esc(kw)}（${esc(doneHit.date)}）</span>`;
    } else {
      html = `<span class="dep-badge">🔗 依赖：${esc(kw)}（未找到对应待办）</span>`;
    }
    return { kw, html };
  }
  /* 下游依赖（反向）：全库含「（依赖：关键词）」且命中本条待办的，做标志 + hover 气泡 */
  function downInfo(t) {
    const list = (dailyState.allTodos || []).filter((a) => {
      const m = a.text.match(/（依赖：([^）]+)）/);
      return m && a.date !== dailyDate && t.text.includes(m[1].trim());
    });
    if (!list.length) return "";
    const tip = list.map((x) => (x.done ? "✅" : "⏳") + " " + x.date + " " + x.text.replace(/（依赖[^）]*）/g, "").trim().slice(0, 24)).join("\n");
    return `<span class="dep-down" data-tip="${esc(tip)}" data-go="${esc(list[0].date)}" title="下游 ${list.length} 个待办依赖它，悬浮查看" style="flex-shrink:0;">🔗 下游 ${list.length}</span>`;
  }
}
/* --- 记账页 --- */
async function renderLedgerPage(c) {
  c.innerHTML = `<div class="page active">${dateNavHTML()}
    <div class="card">
      <h3>💰 记账手册</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:12px;">按日一页 · 一二级分类联动 · 时间留空=当前时刻 · 数据存 <span class="mono">日常/YYYY-MM-DD.md</span>（Obsidian 同步可见）</p>
      <div style="display:grid;grid-template-columns:58px 52px 1fr 1fr 78px 1fr auto;gap:6px;margin:10px 0 12px;align-items:center;">
        <input class="brain-input" id="dETime" placeholder="时间(留空=当前)" style="min-height:0;padding:8px 8px;font-size:12px;">
        <select id="dEType" style="background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:8px;font-size:12px;"><option>支出</option><option>收入</option></select>
        <select id="dECat1" style="background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:8px;font-size:12px;"><option value="">一级分类…</option></select>
        <select id="dECat2" style="background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:8px;font-size:12px;"><option value="">二级分类…</option></select>
        <input class="brain-input" id="dEAmount" type="number" step="0.01" placeholder="金额" style="min-height:0;padding:8px 8px;font-size:12px;">
        <input class="brain-input" id="dENote" placeholder="说明" style="min-height:0;padding:8px 8px;font-size:12px;">
        <button class="btn" id="dEAdd" style="padding:8px 12px;font-size:12px;">➕</button>
      </div>
      <table style="width:100%;font-size:12.5px;border-collapse:collapse;" id="dEntryTable">
        <thead><tr style="color:var(--text3);text-align:left;border-bottom:1px solid var(--line);">
          <th style="padding:6px 4px;">时间</th><th>类型</th><th>一级分类</th><th>二级分类</th><th style="text-align:right;">金额</th><th>说明</th><th></th>
        </tr></thead>
        <tbody id="dEntryBody"></tbody>
      </table>
      <div id="dSum" style="margin-top:10px;font-size:13px;color:var(--text2);"></div>
    </div>
  </div>`;
  await loadDailyBase();
  await loadCats();
  $("#dEAdd").addEventListener("click", addEntry);
  $("#dETime").addEventListener("keydown", (e) => { if (e.key === "Enter") addEntry(); });
  $("#dEAmount").addEventListener("keydown", (e) => { if (e.key === "Enter") addEntry(); });
  $("#dEType").addEventListener("change", syncCat1);
  $("#dECat1").addEventListener("change", syncCat2);
  renderEntryList();
  async function loadCats() {
    try { catData = await api("/api/categories"); } catch (e) { catData = { expense: [], income: [] }; }
    syncCat1();
  }
  function syncCat1() {
    const type = $("#dEType").value === "收入" ? "income" : "expense";
    const list = catData[type] || [];
    $("#dECat1").innerHTML = list.map((x) => `<option value="${esc(x.cat)}">${esc(x.cat)}</option>`).join("") || '<option value="">（无分类）</option>';
    syncCat2();
  }
  function syncCat2() {
    const type = $("#dEType").value === "收入" ? "income" : "expense";
    const cat1 = $("#dECat1").value;
    const grp = (catData[type] || []).find((x) => x.cat === cat1);
    $("#dECat2").innerHTML = (grp ? grp.subs : []).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("") || '<option value="">（无）</option>';
  }
  function renderEntryList() {
    const body = $("#dEntryBody");
    body.innerHTML = dailyState.entries.length ? dailyState.entries.map((e, i) => `
      <tr style="border-bottom:1px solid var(--line);">
        <td style="padding:6px 4px;color:var(--text3);">${esc(e.time)}</td>
        <td style="color:${e.type === "收入" ? "var(--green)" : "var(--red)"};">${e.type === "收入" ? "↑ 收入" : "↓ 支出"}</td>
        <td>${esc(e.cat || "—")}</td>
        <td style="color:var(--text2);">${esc(e.subcat || "—")}</td>
        <td style="text-align:right;font-family:var(--mono);${e.type === "收入" ? "color:var(--green);" : "color:var(--red);"}">${e.type === "收入" ? "+" : "-"}¥${Number(e.amount).toFixed(2)}</td>
        <td style="color:var(--text2);">${esc(e.note || "")}</td>
        <td><button class="btn ghost d-edel" data-i="${i}" style="padding:2px 7px;font-size:11px;color:var(--red);">✕</button></td>
      </tr>`).join("") : `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:14px 0;">今天还没有账目，记一笔吧 💸</td></tr>`;
    body.querySelectorAll(".d-edel").forEach((b) => b.addEventListener("click", () => { dailyState.entries.splice(Number(b.dataset.i), 1); saveDaily(); renderEntryList(); }));
    const exp = dailyState.entries.filter((e) => e.type === "支出").reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const inc = dailyState.entries.filter((e) => e.type === "收入").reduce((s, e) => s + (Number(e.amount) || 0), 0);
    $("#dSum").innerHTML = `今日合计：<span style="color:var(--red);font-family:var(--mono);">支出 ¥${exp.toFixed(2)}</span> · <span style="color:var(--green);font-family:var(--mono);">收入 ¥${inc.toFixed(2)}</span> · <b>结余 ¥${(inc - exp).toFixed(2)}</b>`;
  }
  async function addEntry() {
    const amount = Number($("#dEAmount").value);
    if (!(amount > 0)) { alert("请输入金额"); return; }
    dailyState.entries.push({ time: $("#dETime").value || new Date().toTimeString().slice(0, 5), type: $("#dEType").value, cat: $("#dECat1").value, subcat: $("#dECat2").value || undefined, amount, note: $("#dENote").value.trim() });
    $("#dETime").value = ""; $("#dEAmount").value = ""; $("#dENote").value = "";
    await saveDaily(); renderEntryList();
  }
  async function saveDaily() {
    const r = await fetch(API + "/api/daily", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: dailyDate, todos: dailyState.todos, works: dailyState.works, entries: dailyState.entries, done: dailyState.done }) });
    const j = await r.json();
    dflash(j.ok ? "已保存 · " + dailyDate : "保存失败：" + j.error);
  }
}
function shiftDay(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
function shiftMonth(monthStr, n) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
/* 解析待办文本中的时间词 → 目标日期（YYYY-MM-DD），无时间信息返回 null */
function parseTodoDate(text) {
  const t = text;
  let m = t.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return fmtDate(new Date(+m[1], +m[2] - 1, +m[3]));
  m = t.match(/(\d{1,2})月(\d{1,2})日?/);
  if (m) { const now = new Date(); return fmtDate(new Date(now.getFullYear(), +m[1] - 1, +m[2])); }
  const now = new Date();
  const todayDow = now.getDay();
  const weekMap = [["周日", 0], ["星期天", 0], ["礼拜天", 0], ["星期日", 0], ["礼拜日", 0], ["周一", 1], ["星期一", 1], ["周二", 2], ["星期二", 2], ["周三", 3], ["星期三", 3], ["周四", 4], ["星期四", 4], ["周五", 5], ["星期五", 5], ["周六", 6], ["星期六", 6]];
  for (const [k, w] of weekMap) {
    if (t.includes(k)) {
      const d = new Date(now);
      d.setDate(d.getDate() + ((w - todayDow + 7) % 7));
      return fmtDate(d);
    }
  }
  if (t.includes("后天")) return fmtDate(addDays(now, 2));
  if (t.includes("明天")) return fmtDate(addDays(now, 1));
  if (t.includes("今天") || t.includes("今晚")) return fmtDate(now);
  return null;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtDate(d) { const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0"); const dd = String(d.getDate()).padStart(2, "0"); return `${y}-${m}-${dd}`; }
function weekdayCN(dateStr) { const w = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]; return w[new Date(dateStr + "T00:00:00").getDay()]; }

/* --- 方案工坊 --- */
async function renderStudio(c) {
  const files = await api("/api/files?type=wiki");
  const templates = files.filter((f) => f.includes("/_模板/"));
  const synths = files.filter((f) => f.includes("/综述/"));
  const metas = [];
  for (const rel of templates) {
    const f = await api("/api/file?path=" + encodeURIComponent(rel));
    if (f && !f.error) metas.push({ rel, title: f.fm.title || rel.split("/").pop(), type: "方案组件", icon: "🧩" });
  }
  for (const rel of synths) {
    const f = await api("/api/file?path=" + encodeURIComponent(rel));
    if (f && !f.error) metas.push({ rel, title: f.fm.title || rel.split("/").pop(), type: "实战产出", icon: "📜" });
  }
  c.innerHTML = `<div class="page active">
    <div class="card">
      <h3>🏭 方案工坊 — 组件 + 产出</h3>
      <p style="font-size:12px;color:var(--text2);">沉淀的方案组件（复用框架）与实战产出（已完成的方案成果）。</p>
    </div>
    <div style="margin-top:14px;display:flex;flex-direction:column;gap:8px;">
      ${metas.map((m) => `<div class="list-item" data-rel="${esc(m.rel)}">
        <span>${m.icon}</span><span class="tag ${m.type === "方案组件" ? "comparison" : "synthesis"}">${m.type}</span>
        <span class="t">${esc(m.title)}</span></div>`).join("")}
    </div>
  </div>`;
  c.querySelectorAll(".list-item").forEach((el) => el.addEventListener("click", () => openFile(el.dataset.rel)));
}

/* --- 运行档案 --- */
async function renderArchive(c) {
  const logs = await api("/api/log");
  c.innerHTML = `<div class="page active">
    <div class="card">
      <h3>🗒 运行档案 — 操作日志时间线</h3>
      <div class="tl">
        ${logs.map((l) => {
          const m = l.match(/^-\s*\[([^\]]+)\]\s*([^|]+)\|(.*)$/);
          return `<div class="tl-item"><span class="tl-time">${esc(m ? m[1] : l.slice(0, 17))}</span><div class="tl-text">${esc(m ? (m[2] + " · " + m[3]) : l)}</div></div>`;
        }).join("")}
      </div>
    </div>
  </div>`;
}

/* --- 书架 --- */
const BOOK_COLORS = ["#e74c3c","#e67e22","#f1c40f","#2ecc71","#1abc9c","#3498db","#9b59b6","#34495e","#e91e63","#00bcd4"];
function bookColor(title) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash);
  return BOOK_COLORS[Math.abs(hash) % BOOK_COLORS.length];
}

async function renderBookshelf(c) {
  const books = await api("/api/bookshelf");
  c.innerHTML = `<div class="page active">
    <div class="bookshelf-head">
      <h3>📚 我的书架</h3>
      <div style="display:flex;gap:8px;align-items:center;">
        <span style="font-size:12px;color:var(--text3);">${books.length} 本书</span>
        <label class="btn" style="cursor:pointer;padding:6px 14px;font-size:12px;">
          📥 导入 PDF/TXT
          <input type="file" accept=".pdf,.txt" id="bsUpload" style="display:none;">
        </label>
      </div>
    </div>
    <div class="bs-tabs">
      ${["全部","待读","在读","已读"].map((t) => `<span class="bs-tab" data-filter="${t}">${t}</span>`).join("")}
    </div>
    <div class="bs-grid" id="bsGrid"></div>
  </div>`;

  const grid = c.querySelector("#bsGrid");
  let activeFilter = "全部";
  let sortBy = "最近";

  function renderBooks(filter) {
    let filtered = books;
    if (filter === "待读") filtered = books.filter((b) => b.status === "unread");
    else if (filter === "在读") filtered = books.filter((b) => b.status === "reading");
    else if (filter === "已读") filtered = books.filter((b) => b.status === "done");
    grid.innerHTML = filtered.length
      ? filtered.map((b) => {
          const pct = b.progress || 0;
          const coverColor = bookColor(b.title);
          const initials = b.title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "").slice(0, 2) || "书";
          const statusLabel = { unread: "待读", reading: "在读", done: "已读" }[b.status] || "";
          const statusCls = b.status === "reading" ? "bs-status-reading" : b.status === "done" ? "bs-status-done" : "bs-status-unread";
          return `<div class="bs-card" data-id="${b.id}">
            <div class="bs-cover" style="background:${coverColor};">
              <span class="bs-cover-text">${esc(initials)}</span>
              <span class="bs-status ${statusCls}">${statusLabel}</span>
            </div>
            <div class="bs-info">
              <div class="bs-title" title="${esc(b.title)}">${esc(b.title)}</div>
              ${b.author ? `<div class="bs-author">${esc(b.author)}</div>` : ""}
              <div class="bs-progress-bar"><div class="bs-progress-fill" style="width:${pct}%;${pct >= 100 ? 'background:var(--green);' : ''}"></div></div>
              <div class="bs-meta">
                ${b.status !== "unread" && b.currentPage ? `<span>📄 ${b.currentPage}${b.pages ? "/" + b.pages : ""}页</span>` : ""}
                <span>${pct}%</span>
              </div>
            </div>
          </div>`;
        }).join("")
      : `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text3);">
        <div style="font-size:48px;margin-bottom:12px;">📭</div>
        <div>书架为空，用右上角「导入 PDF/TXT」添加本地书籍</div>
      </div>`;
    // bind click -> open reader
    grid.querySelectorAll(".bs-card").forEach((card) => {
      card.addEventListener("click", () => openBookReader(card.dataset.id, books));
    });
  }

  renderBooks("全部");
  c.querySelectorAll(".bs-tab").forEach((tab, i) => {
    tab.addEventListener("click", () => {
      c.querySelectorAll(".bs-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activeFilter = ["全部","待读","在读","已读"][i];
      renderBooks(activeFilter);
    });
  });
  c.querySelector(".bs-tab:first-child").classList.add("active");

  c.querySelector("#bsUpload").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!/\.(pdf|txt)$/i.test(file.name)) { alert("只支持 PDF / TXT 文件"); return; }
    const btn = c.querySelector(".btn");
    btn.textContent = "上传中…"; btn.disabled = true;
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch(API + "/api/bookshelf/upload", { method: "POST", body: form });
      const j = await r.json();
      if (j.ok) {
        const updated = await api("/api/bookshelf");
        updated.forEach((b) => books.find((x) => x.id === b.id) || books.push(b));
        renderBooks(activeFilter);
        c.querySelector(".bookshelf-head span:first-child").textContent = books.length + " 本书";
      } else {
        alert("上传失败：" + j.error);
      }
    } catch (e) {
      alert("上传失败：" + e.message);
    }
    btn.textContent = "📥 导入 PDF/TXT"; btn.disabled = false;
    e.target.value = "";
  });
}

async function openBookReader(id, books) {
  const book = books.find((b) => b.id === id);
  if (!book) return;
  /* 打开书 = 开始读：待读书首次打开自动升级「在读」，避免读了大半仍显示"待读" */
  if (book.status === "unread") {
    book.status = "reading";
    book.startedAt = new Date().toISOString();
    fetch(API + "/api/bookshelf/progress", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: book.id, status: "reading" })
    }).catch(() => {});
  }
  backStack.push({ page: currentPage, rel: currentRel });
  currentPage = "bookshelf-reader";
  currentRel = id;
  const c = $("#content");
  const pdfUrl = "/" + book.filepath;
  const pc = book.currentPage || 1;
  /* TXT 书 = 上传时已自动转 md：走文本阅读引擎（复用 mdToHtml 排版） */
  const isTxt = book.type === "txt" || /\.md$/i.test(book.filepath);
  c.innerHTML = `<div class="page active bs-reader-wrap">
    <div class="bs-reader-bar">
      <button class="btn ghost" id="bsReaderBack">← 返回书架</button>
      <span style="font-size:14px;font-weight:600;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:26%;">${esc(book.title)}</span>
      <div class="bs-reader-controls">
        <button class="btn ghost bs-nav" id="bsPrev" title="上一页">◀ 上页</button>
        <span class="bs-page-ind">p.<input type="number" id="bsPageInput" value="${pc}" min="1" inputmode="numeric"> / <span id="bsPageTotal">${book.pages || "…"}</span></span>
        <button class="btn ghost bs-nav" id="bsNext" title="下一页">下页 ▶</button>
        <span class="bs-divider"></span>
        <button class="btn ghost bs-view-btn" id="bsViewSingle" title="单页模式">📄 单页</button>
        <button class="btn ghost bs-view-btn" id="bsViewDouble" title="双页对开">📖 双页</button>
        <span class="bs-divider"></span>
        <button class="btn ghost bs-nav" id="bsZoomOut" title="缩小">−</button>
        <span class="bs-zoom-ind" id="bsZoomInd">70%</span>
        <button class="btn ghost bs-nav" id="bsZoomIn" title="放大">+</button>
        <span class="bs-divider"></span>
        <button class="btn ghost" id="bsMarkPage" title="标记当前页为进度">📍 标记</button>
        ${book.status !== "reading" ? `<button class="btn" id="bsStartRead" style="padding:4px 12px;font-size:12px;">🔁 重新阅读</button>` : ''}
        ${book.status === "reading" ? `<button class="btn" id="bsMarkDone" style="padding:4px 12px;font-size:12px;">✅ 读完</button>` : ''}
      </div>
    </div>
    <div class="bs-reader-stage">
      <button class="bs-flip-btn bs-flip-left" id="bsFlipLeft" title="上一页（←）" aria-label="上一页">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="bs-viewer" id="bsViewer">
        <div class="bs-loading">📖 正在加载 PDF…</div>
      </div>
      <button class="bs-flip-btn bs-flip-right" id="bsFlipRight" title="下一页（→）" aria-label="下一页">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
    </div>
  </div>`;

  let pdfDoc = null;
  let curPage = pc;
  let viewMode = "single";   // single | double
  let zoom = 0.7;            // 默认 70%（PDF A4 100% 在屏上偏大；txt 字号以 70% 为基准换算回 15px）
  let renderSeq = 0;
  /* TXT 阅读状态：按段落分页 */
  let txtParas = [];
  let txtPages = 1;
  const TXT_PER_PAGE = 12;

  const viewer = c.querySelector("#bsViewer");
  const pageInput = c.querySelector("#bsPageInput");
  const pageTotal = c.querySelector("#bsPageTotal");
  const zoomInd = c.querySelector("#bsZoomInd");

  if (isTxt) {
    /* TXT 阅读：隐藏 PDF 专属控件（单页/双页对开） */
    const sv = c.querySelector("#bsViewSingle"), dv = c.querySelector("#bsViewDouble");
    if (sv) sv.style.display = "none";
    if (dv) dv.style.display = "none";
    if (viewer) viewer.innerHTML = `<div class="bs-loading">📖 正在加载文本…</div>`;
  }

  const saveProgress = async (pg) => {
    try {
      await fetch(API + "/api/bookshelf/progress", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: book.id, currentPage: pg })
      });
    } catch {}
  };

  /* --- 渲染核心：TXT（md）分支 --- */
  function renderTxt() {
    const start = (curPage - 1) * TXT_PER_PAGE;
    const chunk = txtParas.slice(start, start + TXT_PER_PAGE).join("\n\n");
    let html;
    try {
      html = mdToHtml(chunk, "");
    } catch (e) {
      /* marked 未加载（离线）时降级为纯文本 */
      html = `<div style="white-space:pre-wrap;">${esc(chunk)}</div>`;
    }
    viewer.innerHTML = `<div class="bs-txt-page" style="font-size:${Math.round(15 * zoom / 0.7)}px;line-height:1.95;max-width:780px;margin:0 auto;padding:26px 22px;">${html}</div>`;
    pageInput.value = curPage;
    zoomInd.textContent = Math.round(zoom * 100) + "%";
    pageTotal.textContent = txtPages;
  }

  async function render() {
    if (isTxt) { renderTxt(); return; }
    if (!pdfDoc) return;
    const seq = ++renderSeq;
    const stage = c.querySelector(".bs-reader-stage");
    const vw = (stage ? stage.clientWidth : window.innerWidth) - 110; // 扣除两侧悬浮按钮宽度
    const pages = viewMode === "double" ? [curPage, curPage + 1] : [curPage];
    viewer.innerHTML = "";
    const gap = viewMode === "double" ? 14 : 0;
    for (const pn of pages) {
      if (pn < 1 || pn > pdfDoc.numPages) continue;
      if (seq !== renderSeq) return;
      const page = await pdfDoc.getPage(pn);
      if (seq !== renderSeq) return;
      const base = page.getViewport({ scale: 1 });
      let w = viewMode === "double" ? (vw - gap) / 2 : vw;
      w = Math.max(120, Math.min(w, 1500));
      const scale = (w / base.width) * zoom;
      const vp = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = vp.width + "px";
      canvas.style.height = vp.height + "px";
      canvas.className = "bs-page-canvas" + (viewMode === "double" ? " bs-page-canvas-double" : "");
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      viewer.appendChild(canvas);
      try {
        const task = page.render({ canvasContext: ctx, viewport: vp });
        await task.promise;
      } catch (e) { /* render cancelled */ }
    }
    if (seq !== renderSeq) return;
    pageInput.value = curPage;
    const left = viewMode === "double" ? curPage : curPage;
    const right = viewMode === "double" ? Math.min(curPage + 1, pdfDoc.numPages) : null;
    zoomInd.textContent = Math.round(zoom * 100) + "%";
    pageTotal.textContent = pdfDoc.numPages;
  }

  async function goTo(pg) {
    if (isTxt) {
      pg = Math.max(1, Math.min(Math.round(pg) || 1, txtPages));
      curPage = pg;
      renderTxt();
      saveProgress(pg);
      return;
    }
    if (!pdfDoc) return;
    pg = Math.max(1, Math.min(Math.round(pg) || 1, pdfDoc.numPages));
    curPage = pg;
    await render();
    saveProgress(pg);
  }

  async function loadTxt() {
    try {
      const resp = await fetch("/" + book.filepath);
      const md = await resp.text();
      txtParas = md.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
      txtPages = Math.max(1, Math.ceil(txtParas.length / TXT_PER_PAGE));
      pageTotal.textContent = txtPages;
      if (book.pages !== txtPages) {
        await fetch(API + "/api/bookshelf/progress", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: book.id, pages: txtPages })
        });
        book.pages = txtPages;
      }
      curPage = Math.max(1, Math.min(curPage, txtPages));
      renderTxt();
    } catch (e) {
      viewer.innerHTML = `<div class="bs-loading">❌ 文本加载失败：${esc(e.message || String(e))}</div>`;
    }
  }

  async function loadBook() {
    if (isTxt) { await loadTxt(); return; }
    if (typeof pdfjsLib === "undefined") {
      viewer.innerHTML = `<div class="bs-loading">⚠️ PDF 引擎未加载（assets/pdfjs/pdf.min.js 缺失），请检查工作台资源</div>`;
      return;
    }
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "assets/pdfjs/pdf.worker.min.js";
      const task = pdfjsLib.getDocument({ url: pdfUrl });
      pdfDoc = await task.promise;
      if (pdfDoc.numPages && pdfDoc.numPages !== book.pages) {
        await fetch(API + "/api/bookshelf/progress", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: book.id, pages: pdfDoc.numPages })
        });
        book.pages = pdfDoc.numPages;
      }
      pageTotal.textContent = pdfDoc.numPages;
      await render();
    } catch (e) {
      viewer.innerHTML = `<div class="bs-loading">❌ PDF 加载失败：${esc(e.message || String(e))}</div>`;
    }
  }

  /* --- 事件绑定 --- */
  c.querySelector("#bsReaderBack").addEventListener("click", () => {
    const prev = backStack.pop();
    if (prev) { currentPage = prev.page; currentRel = prev.rel; }
    else currentPage = "bookshelf";
    navigate(currentPage);
  });
  c.querySelector("#bsPrev").addEventListener("click", () => goTo(curPage - (viewMode === "double" ? 2 : 1)));
  c.querySelector("#bsNext").addEventListener("click", () => goTo(curPage + (viewMode === "double" ? 2 : 1)));
  c.querySelector("#bsFlipLeft").addEventListener("click", () => goTo(curPage - (viewMode === "double" ? 2 : 1)));
  c.querySelector("#bsFlipRight").addEventListener("click", () => goTo(curPage + (viewMode === "double" ? 2 : 1)));
  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goTo(parseInt(pageInput.value) || 1);
  });
  c.querySelector("#bsMarkPage").addEventListener("click", () => {
    const pg = parseInt(pageInput.value) || 1;
    goTo(pg);
    alert("已标记第 " + pg + " 页");
  });
  const setViewMode = (m) => {
    viewMode = m;
    c.querySelector("#bsViewSingle").classList.toggle("active", m === "single");
    c.querySelector("#bsViewDouble").classList.toggle("active", m === "double");
    render();
  };
  c.querySelector("#bsViewSingle").addEventListener("click", () => setViewMode("single"));
  c.querySelector("#bsViewDouble").addEventListener("click", () => setViewMode("double"));
  c.querySelector("#bsZoomOut").addEventListener("click", () => { zoom = Math.max(0.4, Math.round((zoom - 0.2) * 10) / 10); render(); });
  c.querySelector("#bsZoomIn").addEventListener("click", () => { zoom = Math.min(3, Math.round((zoom + 0.2) * 10) / 10); render(); });
  c.querySelector("#bsViewSingle").classList.add("active");
  /* 键盘翻页（阅读器激活时） */
  const kd = (e) => {
    if (currentPage !== "bookshelf-reader") return;
    if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); goTo(curPage - (viewMode === "double" ? 2 : 1)); }
    else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); goTo(curPage + (viewMode === "double" ? 2 : 1)); }
  };
  document.addEventListener("keydown", kd);
  const onUnload = () => document.removeEventListener("keydown", kd);
  window.addEventListener("hashchange", onUnload, { once: true });
  /* 窗口尺寸变化自动重排 */
  let rsTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(rsTimer);
    rsTimer = setTimeout(() => { if (currentPage === "bookshelf-reader") render(); }, 200);
  });

  const startBtn = c.querySelector("#bsStartRead");
  if (startBtn) startBtn.addEventListener("click", async () => {
    await fetch(API + "/api/bookshelf/progress", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: book.id, status: "reading", currentPage: curPage })
    }).then((r) => r.json());
    book.status = "reading";
    book.startedAt = new Date().toISOString();
    openBookReader(id, books);
  });
  const doneBtn = c.querySelector("#bsMarkDone");
  if (doneBtn) doneBtn.addEventListener("click", async () => {
    await fetch(API + "/api/bookshelf/progress", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: book.id, status: "done", progress: 100 })
    }).then((r) => r.json());
    book.status = "done";
    book.finishedAt = new Date().toISOString();
    book.progress = 100;
    navigate("bookshelf");
  });

  loadBook();
}

/* ---------- 搜索（MiniSearch 全文引擎）---------- */
let searchSuggestTimer = null;
let searchSuggestBox = null;

function ensureSuggestBox() {
  if (searchSuggestBox) return searchSuggestBox;
  searchSuggestBox = document.createElement("div");
  searchSuggestBox.id = "searchSuggest";
  searchSuggestBox.style.cssText = "position:absolute;top:100%;left:0;right:0;background:var(--bg2);border:1px solid var(--line2);border-radius:0 0 12px 12px;box-shadow:var(--shadow-lg);max-height:360px;overflow-y:auto;z-index:50;display:none;";
  const box = $(".search-box");
  box.style.position = "relative";
  box.appendChild(searchSuggestBox);
  document.addEventListener("click", (e) => {
    if (!box.contains(e.target)) searchSuggestBox.style.display = "none";
  });
  return searchSuggestBox;
}

$("#searchInput").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchSuggestTimer);
  if (q.length < 2) { if (searchSuggestBox) searchSuggestBox.style.display = "none"; return; }
  searchSuggestTimer = setTimeout(async () => {
    const box = ensureSuggestBox();
    const results = await doSearch(q, { limit: 8, combineWith: "OR" });
    if (!results.length) { box.style.display = "none"; return; }
    const terms = extractTerms(q);
    box.innerHTML = results.map((r) => `<div class="ss-item" data-rel="${esc(r.rel)}" style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--line);transition:background 0.15s;">
      <div style="font-size:12.5px;font-weight:600;color:var(--acc2);">${highlightText(r.title, terms)} <span style="font-size:10px;color:var(--text3);font-weight:400;">${TYPE_CN[r.type] || ""}</span></div>
    </div>`).join("");
    box.style.display = "block";
    box.querySelectorAll(".ss-item").forEach((el) => {
      el.addEventListener("mouseenter", () => el.style.background = "var(--bg3)");
      el.addEventListener("mouseleave", () => el.style.background = "transparent");
      el.addEventListener("click", () => {
        box.style.display = "none";
        openFile(el.dataset.rel);
      });
    });
  }, 200);
});

$("#searchInput").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const q = $("#searchInput").value.trim();
  if (!q) return;
  if (searchSuggestBox) searchSuggestBox.style.display = "none";
  const c = $("#content");
  c.innerHTML = `<div class="page active"><div class="page-h">搜索中…</div></div>`;
  const results = await doSearch(q, { limit: 30 });
  const terms = extractTerms(q);
  c.innerHTML = `<div class="page active">
    <div class="page-h">搜索结果：${esc(q)}</div>
    <div class="page-d">命中 ${results.length} 条 · 全文分词搜索 · 相关性排序</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${results.map((r) => {
        const snippet = r.content ? buildSnippet(r.content, terms) : "";
        return `<div class="hit" data-rel="${esc(r.rel)}">
          <div class="t">${highlightText(r.title, terms)} <span style="font-size:10px;color:var(--text3);">${esc(r.rel)}</span></div>
          <div class="s">${snippet || '<span style="color:var(--text3)">标题命中</span>'}</div>
        </div>`;
      }).join("") || "<div style='color:var(--text3)'>无命中，试试换个关键词或减少条件</div>"}
    </div></div>`;
  c.querySelectorAll(".hit").forEach((el) => el.addEventListener("click", () => openFile(el.dataset.rel)));
});

/* ---------- 状态灯 ---------- */
document.querySelectorAll(".nav-item").forEach((n) => {
  n.addEventListener("click", () => navigate(n.dataset.page));
});
(async function init() {
  initSidebar();
  try {
    // 并行加载：stats（仪表盘数据）+ search-index（搜索预热）
    const s = await api("/api/stats");
    $("#statusText").textContent = `已连接 · ${s.wikiTotal} 页 / ${s.rawFiles} 素材`;
    $("#statusDot").className = "dot green";
  } catch {
    $("#statusText").textContent = "离线（请启动 server.js）";
    $("#statusDot").className = "dot red";
  }
  getSearchIndex(); // 后台预热 MiniSearch 索引，不阻塞页面导航
  const h = location.hash.replace("#/", "");
  if (h.startsWith("file/")) openFile(decodeURIComponent(h.slice(5)));
  else if (PAGES[h]) navigate(h);
  else navigate(currentPage);
})();
