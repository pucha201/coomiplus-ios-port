/* =========================================================================
 * CoomiPlus 侧边栏运行时补丁：DeepSeek 风格「盖子滑开」（v2）
 * 追加在 ChatView 的 JS chunk 末尾。
 *
 * 逐帧只写两个 CSS 变量（--cp-f / --cp-w）到 :root，
 * 位移/缩放/圆角全部由 CSS 表达式消费（避开原规则的 !important）。
 *
 * 动画 spring(dampingRatio = 0.9, stiffness = 1500) —— Compose 等效解析解
 * 手势 拖拽跟手，松手按 50% 阈值吸附（anchoredDraggable 位置阈值）
 * ========================================================================= */
(function () {
  'use strict';
  if (window.__coomiDrawerMotion) return;
  window.__coomiDrawerMotion = true;

  var DAMPING = 0.9;
  var STIFFNESS = 1500;
  var root = document.documentElement;

  var f = 0;
  var raf = 0, animating = false, dragging = false, watchdog = 0;
  var lastF = -1;

  function springPos(from, to, z, stiffness) {
    var w0 = Math.sqrt(stiffness);
    var A = from - to;
    var B = (z * w0 * A) / (w0 * Math.sqrt(Math.max(1 - z * z, 0)));
    return function (t) {
      if (z === 0) return to + A * Math.cos(w0 * t);
      if (z < 1) {
        var wd = w0 * Math.sqrt(1 - z * z);
        var e = Math.exp(-z * w0 * t);
        return to + e * (A * Math.cos(wd * t) + B * Math.sin(wd * t));
      }
      if (z === 1) return to + (A + w0 * A * t) * Math.exp(-w0 * t);
      var r = w0 * Math.sqrt(z * z - 1);
      var r1 = -z * w0 + r, r2 = -z * w0 - r;
      var cb = (0 - A * r2) / (r1 - r2);
      return to + (A - cb) * Math.exp(r1 * t) + cb * Math.exp(r2 * t);
    };
  }

  function drawerRoot() { return document.querySelector('.drawer-root'); }
  function panelEl() { var r = drawerRoot(); return r ? r.querySelector('.panel') : null; }

  var cachedW = 0;
  function width() {
    if (cachedW > 0) return cachedW;
    var p = panelEl();
    var w = p ? p.offsetWidth : 0;
    cachedW = w > 0 ? w : Math.min(326, Math.round(window.innerWidth * 0.8));
    return cachedW;
  }

  var lastShell = null, lastPanel = null, lastTf = '', lastVis = '';
  function applyTransforms(v) {
    var W = width();
    var shell = document.querySelector('.chat > .shell');
    var panelElNow = panelEl();
    if (shell !== lastShell) { lastShell = shell; lastTf = ''; }
    if (panelElNow !== lastPanel) { lastPanel = panelElNow; lastTf = ''; lastVis = ''; }
    // 位移量 = 抽屉面板实际宽度（与 CSS 的 f*W 模型一致）。
    // 曾经写成 v*W*0.7 并叠加 scale(1-0.06v)，导致只露出一半对话页、且整页文字每帧重新栅格化（卡顿主因）。
    var shellTf = 'translate3d(' + (v * W).toFixed(2) + 'px,0,0)';
    var panelTf = 'translate3d(' + ((v - 1) * W).toFixed(2) + 'px,0,0) scale(' + (0.95 + 0.05 * v).toFixed(4) + ')';
    // 圆角/阴影不再逐帧算：只切一个开关态（CSS 里用 140ms 过渡补齐观感），
    // 避免每帧对整棵对话子树做样式重算 + 重绘 40px 模糊阴影。
    var host = document.querySelector('.chat');
    if (host) {
      var lidOn = v > 0.001;
      if (host.__lid !== lidOn) {
        host.__lid = lidOn;
        if (lidOn) host.setAttribute('data-lid', '1');
        else host.removeAttribute('data-lid');
      }
    }
    if (shell && shellTf !== lastTf) shell.style.setProperty('transform', shellTf, 'important');
    if (panelElNow) panelElNow.style.setProperty('transform', panelTf, 'important');
    lastTf = shellTf;
    // 关闭态整块摘出绘制：面板在 f=0 时只是被移出屏幕，合成层残留/WebView 恢复
    // 最后一帧时会漏出侧栏文字。可见性写内联（压得过 scoped 样式），
    // 拖拽与开合动画期间保持 visible，收尾到 0 才隐藏。
    if (panelElNow) {
      var vis = (v > 0.001 || isOpen() || dragging) ? 'visible' : 'hidden';
      if (vis !== lastVis) { panelElNow.style.setProperty('visibility', vis, 'important'); lastVis = vis; }
    }
  }
  function writeF(v) {
    f = v;
    // 直接写两个元素的 transform（内联 !important）：
    // 不再逐帧改 CSS 变量，避免每帧对整棵对话子树做样式重算。
    applyTransforms(v);
  }

  function syncWidth() { root.style.setProperty('--cp-w', width() + 'px'); }

  function animateTo(target) {
    if (animating) cancelAnimationFrame(raf);
    var pos = springPos(f, target, DAMPING, STIFFNESS);
    var t0 = performance.now();
    animating = true;
    setAnimClass(true);
    // 看门狗：页面被后台节流时 rAF 不跑，避免卡在半途
    clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      if (!animating) return;
      cancelAnimationFrame(raf);
      animating = false;
      writeF(target);
      setAnimClass(false);
    }, 900);
    (function step(now) {
      var t = (now - t0) / 1000;
      var v = pos(t);
      if (Math.abs(v - target) < 0.0008) {
        writeF(target);
        animating = false;
        clearTimeout(watchdog);
        setAnimClass(false);
        return;
      }
      writeF(v);
      raf = requestAnimationFrame(step);
    })(t0);
  }

  /** 动画期间摘掉顶栏模糊等昂贵效果（模糊层后面有内容在动，每帧都要重采样）。 */
  function setAnimClass(on) {
    var host = document.querySelector('.chat');
    if (host) host.classList.toggle('cp-anim', !!on);
  }

  function isOpen() {
    var r = drawerRoot();
    return !!(r && r.classList.contains('open'));
  }

  /* --------------------------- 点击关闭层 --------------------------- */
  var tap = null;
  function tapLayer() {
    if (tap) return tap;
    tap = document.createElement('div');
    tap.className = 'coomi-drawer-tap';
    tap.addEventListener('click', function () { closeViaApp(); });
    document.body.appendChild(tap);
    return tap;
  }
  function closeViaApp() {
    var scrim = document.querySelector('.drawer-root .scrim');
    if (scrim) scrim.click();
    else animateTo(0);
  }

  var lastOpen = null, refreshRaf = 0;
  function refresh() {
    applyTransforms(f);
    var open = isOpen();
    if (open !== lastOpen) { lastOpen = open; cachedW = 0; }
    var w = width();
    root.style.setProperty('--cp-w', w + 'px');
    var t = tapLayer();
    if (t.__cpw !== w) { t.__cpw = w; t.style.setProperty('--cp-w', w + 'px'); }
    t.classList.toggle('on', open);
    if (!dragging) {
      var target = open ? 1 : 0;
      if (Math.abs(target - f) > 0.0005 && !animating) animateTo(target);
    }
  }
  /** 类名变化很密集（Vue 每帧都在改 is-on/cur），合并到一帧只跑一次。 */
  function scheduleRefresh() {
    if (refreshRaf) return;
    refreshRaf = requestAnimationFrame(function () { refreshRaf = 0; refresh(); });
  }

  /* --------------------------- 滑动开合手势 ---------------------------
   * 打开态：面板或右侧露出的对话页上，左右滑动都能把抽屉推回去
   * 关闭态：对话页任意位置（非交互元素）左右滑动都能把抽屉拉出来
   * 左右都算：往哪边滑都有跟手反馈，松手按 50% 吸附 */
  function startDrag(ev) {
    var startX = ev.clientX, startY = ev.clientY, W = width(), moved = false;
    var wasOpen = isOpen();
    // 捕获指针：手指滑出元素边界后仍能收到 move，避免手势半路丢失。
    var pointerId = ev.pointerId;
    try { if (pointerId != null && ev.target && ev.target.setPointerCapture) ev.target.setPointerCapture(pointerId); } catch (e0) { /* ignore */ }
    function move(e2) {
      var dx = e2.clientX - startX, dy = e2.clientY - startY;
      if (!moved) {
        // 阈值与方向比都抬高：横向必须明显大于纵向，否则交还给滚动（缺陷 13 的误触）
        if (Math.abs(dx) < 12) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
        moved = true;
        dragging = true;
        setAnimClass(true);
        if (animating) { cancelAnimationFrame(raf); animating = false; }
      }
      if (e2.cancelable) e2.preventDefault();
      var v = wasOpen
        ? Math.max(0, 1 - Math.abs(dx) / W)   // 打开态：任意方向推回
        : Math.min(1, Math.abs(dx) / W);      // 关闭态：任意方向拉开
      writeF(v);
    }
    function up() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      try { if (pointerId != null && ev.target && ev.target.releasePointerCapture) ev.target.releasePointerCapture(pointerId); } catch (e0) { /* ignore */ }
      if (!moved) { dragging = false; return; }
      dragging = false;
      var target = f > 0.5 ? 1 : 0;
      animateTo(target);
      if (target === 1 && !isOpen()) {
        var menu = document.querySelector('.topbar .icon-btn');
        if (menu) menu.click();               // 让 App 自己进入 open 态
      } else if (target === 0 && isOpen()) {
        closeViaApp();
      }
    }
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  /* 手势起点是否落在「自己会横向滚动」的元素里（表格 / 代码块 / 横向 chip 行…）。
   * 这些地方左右滑是在滚内容，绝不能被当成开合抽屉（缺陷 13）。 */
  function inHScrollable(el) {
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 8; depth++) {
      if (node.matches && node.matches('.md-table-scroll,.md-table-full-body,table,[data-hscroll],.entry-row,.quick,.cm-chips,.cm-code')) return true;
      var ox = '';
      try { ox = window.getComputedStyle(node).overflowX || ''; } catch (e) { ox = ''; }
      if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth + 2) return true;
      node = node.parentElement;
    }
    return false;
  }

  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('input, textarea, button, a, select, pre, code, .cm-sheet-root, .cm-switch')) return;
    if (inHScrollable(e.target)) return;
    var open = isOpen();
    if (open) {
      // 面板、右侧露出的对话页、以及铺在露出区上的透明点击层都能起手
      // （tap 层是 body 直属节点，不在 .chat 里，之前漏了它 → 打开态左滑收回 100% 失效）
      if (!e.target.closest('.drawer-root .panel')
        && !e.target.closest('.chat')
        && !e.target.closest('.coomi-drawer-tap')) return;
    } else {
      if (!e.target.closest('.chat')) return;
    }
    startDrag(e);
  }, true);

  /* --------------------------- 观察 App 状态 --------------------------- */
  var mo = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target;
      if (!t.classList) continue;
      if (t.classList.contains('drawer-root') || t.classList.contains('shell')) {
        scheduleRefresh();
        return;
      }
    }
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });
  window.addEventListener('resize', function () { cachedW = 0; scheduleRefresh(); });
  window.addEventListener('coomi:drawer-sync', scheduleRefresh);
  // App 的开合状态是权威：它说关了（路由离开、系统返回），补丁的点击层必须立刻撤掉，
  // 否则这层固定覆盖物会留在新页面上吞点击。
  window.addEventListener('coomi:drawer-state', function (e) {
    if (e && e.detail && e.detail.open === false) animateTo(0);
    scheduleRefresh();
  });

  function boot() {
    syncWidth();
    writeF(isOpen() ? 1 : 0);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 80);
  setTimeout(boot, 500);

  window.__coomiDrawer = {
    get f() { return f; },
    set f(v) { animating = false; cancelAnimationFrame(raf); writeF(Math.min(1, Math.max(0, v))); },
    // open/close 必须和「手势松手」走同一条路径：光把 f 推到 1 而不通知 App，
    // App 的 drawerOpen 仍是 false —— 后续 isOpen() 判成关闭，滑动手感就全乱了。
    open: function () {
      animateTo(1);
      if (!isOpen()) {
        var menu = document.querySelector('.topbar .icon-btn');
        if (menu) menu.click();
      }
    },
    close: function () {
      animateTo(0);
      if (isOpen()) closeViaApp();
    },
    reset: function () { animating = false; cancelAnimationFrame(raf); dragging = false; writeF(0); },
    width: width,
    state: function () { return { f: f, open: isOpen(), w: width() }; },
  };
})();
