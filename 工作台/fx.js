/* ============================================================
   __USER_NAME__的专属工作台 · 动效增强层 fx.js
   ─────────────────────────────────────────────
   纯视觉增强，不修改任何功能逻辑：
   - 统计数字滚动动画（.stat .num）
   - 环形进度动画（.ring-wrap circle）
   - 条形图展开动画（.mb-fill）
   - 页面内容渐次入场（.card / .stat stagger）
   通过 MutationObserver 自动适配动态渲染的页面，
   尊重 prefers-reduced-motion。
   ============================================================ */
(() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return; // 用户偏好减少动效：直接退出

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  // ---- 数字滚动 ----
  function animateNum(el) {
    const raw = el.textContent.replace(/,/g, "").trim();
    const target = parseInt(raw, 10);
    if (isNaN(target) || target <= 0) return;
    if (el.dataset.fxDone === "1") return;

    const dur = 900;
    const t0 = performance.now();
    el.dataset.fxDone = "1";
    el.style.fontVariantNumeric = "tabular-nums";

    function step(now) {
      const p = Math.min((now - t0) / dur, 1);
      const val = Math.round(target * easeOut(p));
      el.textContent = String(val);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ---- 环形进度（从 0 转到目标） ----
  function animateRing(wrap) {
    const circle = wrap.querySelector("circle:nth-of-type(2)");
    if (!circle) return;
    const target = circle.getAttribute("stroke-dashoffset");
    if (!target || wrap.dataset.fxDone === "1") return;

    const ringC = 2 * Math.PI * 26; // 与模板 ringR 一致
    const start = ringC.toFixed(1);
    const end = parseFloat(target);
    wrap.dataset.fxDone = "1";
    circle.style.transition = "none";

    const dur = 1100;
    const t0 = performance.now();
    function step(now) {
      const p = Math.min((now - t0) / dur, 1);
      circle.setAttribute("stroke-dashoffset", (start - (start - end) * easeOut(p)).toFixed(1));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ---- 条形图展开 ----
  function animateBars(scope) {
    scope.querySelectorAll(".mb-fill").forEach((f, i) => {
      if (f.dataset.fxDone === "1") return;
      const target = f.style.width;
      f.dataset.fxDone = "1";
      f.style.width = "0%";
      f.style.transition = "none";
      // 强制重排后展开
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          f.style.transition = `width 0.8s cubic-bezier(0.22, 0.8, 0.32, 1) ${i * 90}ms`;
          f.style.width = target;
        });
      });
    });
  }

  // ---- 卡片渐次入场 ----
  function staggerCards(scope) {
    const items = scope.querySelectorAll(".stat, .card");
    items.forEach((el, i) => {
      if (el.dataset.fxStagger === "1") return;
      el.dataset.fxStagger = "1";
      el.style.opacity = "0";
      el.style.transform = "translateY(10px)";
      el.style.transition = `opacity 0.5s cubic-bezier(0.22,0.8,0.32,1) ${i * 70}ms, transform 0.5s cubic-bezier(0.22,0.8,0.32,1) ${i * 70}ms, box-shadow 0.25s ease`;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.style.opacity = "1";
          el.style.transform = "translateY(0)";
        });
      });
    });
  }

  // ---- 扫描一个容器并应用所有动效 ----
  function enhance(scope) {
    scope.querySelectorAll(".stat .num").forEach(animateNum);
    scope.querySelectorAll(".ring-wrap").forEach(animateRing);
    animateBars(scope);
    staggerCards(scope);
  }

  // ---- MutationObserver：监听内容容器变化 ----
  const content = document.getElementById("content");
  if (content) {
    const observer = new MutationObserver((muts) => {
      // 页面切换时对新增节点做延迟增强，等渲染稳定
      clearTimeout(observer._t);
      observer._t = setTimeout(() => enhance(content), 60);
    });
    observer.observe(content, { childList: true, subtree: true });
    // 初始增强
    setTimeout(() => enhance(content), 150);
  }
})();
