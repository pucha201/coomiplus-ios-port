/* =========================================================================
 * CoomiPlus · 本地/云端 模式 UI（纯界面层，追加在 ChatView 的 JS chunk 末尾）
 *
 * 只做界面：设备列表、目录、云端设置均以真实 bridge 状态为准；
 * 不做任何「模拟同步」动画，也不伪造设备/目录数据。
 * ========================================================================= */
(function () {
  'use strict';
  if (window.__coomiCloud) return;
  window.__coomiCloud = true;

  var LS_KEY = 'coomi.cloud.ui.v1';

  /* ------------------------------------------------------------- 图标 */
  function svg(path, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) +
      '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }
  var I = {
    laptop: svg('<rect x="3" y="5" width="18" height="12" rx="2.2"/><path d="M2 19.5h20"/>'),
    cloud: svg('<path d="M7.5 18.5h9.2a3.8 3.8 0 0 0 .5-7.57A5.2 5.2 0 0 0 7.2 9.6a4.5 4.5 0 0 0 .3 8.9Z"/>'),
    folder: svg('<path d="M3.5 8.2c0-1.2.9-2.2 2.1-2.2h3.1c.6 0 1.2.25 1.6.7l.9 1h7.2c1.2 0 2.1 1 2.1 2.2v6.4c0 1.2-.9 2.2-2.1 2.2H5.6c-1.2 0-2.1-1-2.1-2.2V8.2Z"/>'),
    file: svg('<path d="M6 3.5h6.5L18 9v11.5H6z"/><path d="M12.5 3.5V9H18"/>', 16),
    chev: svg('<path d="M9.5 6l6 6-6 6"/>', 16),
    chevDown: svg('<path d="M6 9.5l6 6 6-6"/>', 16),
    plus: svg('<path d="M12 5v14M5 12h14"/>', 18),
    trash: svg('<path d="M4.5 7h15M9.5 7V5.2c0-.7.5-1.2 1.2-1.2h2.6c.7 0 1.2.5 1.2 1.2V7M6.5 7l.8 11.1c0 .9.8 1.6 1.7 1.6h6c.9 0 1.7-.7 1.7-1.6L17.5 7"/>', 17),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 18),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>', 16),
    qr: svg('<rect x="4" y="4" width="6" height="6" rx="1.4"/><rect x="14" y="4" width="6" height="6" rx="1.4"/><rect x="4" y="14" width="6" height="6" rx="1.4"/><path d="M14 14h3v3h-3zM20 14v2M14 20h6"/>', 18),
    keypad: svg('<rect x="3" y="5" width="18" height="14" rx="2.4"/><path d="M7 10h.01M12 10h.01M17 10h.01M8.5 14.5h7"/>', 18),
    gear: svg('<circle cx="12" cy="12" r="3.1"/><path d="M12 3.5v2M12 18.5v2M4.9 7.5l1.7 1M17.4 15.5l1.7 1M4.9 16.5l1.7-1M17.4 8.5l1.7-1"/>', 18),
    sync: svg('<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5.5V11h-5.4"/>', 16),
    spark: svg('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5Z"/>', 16),
    lock: svg('<rect x="5" y="10.5" width="14" height="9.5" rx="2.4"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>', 16),
    logo: svg('<path d="M12 3.2 14.4 9.6 20.8 12l-6.4 2.4L12 20.8 9.6 14.4 3.2 12 9.6 9.6 12 3.2Z"/>', 15)
  };

  /* ------------------------------------------------------------- 状态 */
  var B = window.__coomiBridge || null;
  var S = {
    mode: (B && B.getMode) ? B.getMode() : 'local',
    deviceId: (B && B.getDeviceId) ? B.getDeviceId() : '',
    dir: (B && B.getDir) ? B.getDir() : '',
    appDir: '',
    devices: (B && B.devices) ? B.devices() : [],
    apps: [],
    dirs: ['/Users/coomi/Projects/deepseek-harness', '/Users/coomi/Documents/notes', '/Users/coomi/Downloads'],
    sync: { modelFromDevice: true, p2pUpload: true, mirror: true }
  };
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o.mode === 'local' || o.mode === 'cloud') S.mode = o.mode;
      if (typeof o.deviceId === 'string') S.deviceId = o.deviceId;
      if (typeof o.dir === 'string') S.dir = o.dir;
      if (o.sync) S.sync = Object.assign(S.sync, o.sync);
    }
  } catch (e) {}
  // bridge 存在时，真实状态优先于 localStorage 里的演示数据
  try { if (B && B.getMode) S.mode = B.getMode(); if (B && B.getDeviceId) S.deviceId = B.getDeviceId(); if (B && B.devices) S.devices = B.devices(); } catch (e) {}
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ mode: S.mode, deviceId: S.deviceId, dir: S.dir, sync: S.sync })); } catch (e) {}
    try { if (B && B.setMode) B.setMode(S.mode); if (B && B.setDir) B.setDir(S.dir); } catch (e) {}
  }
  function device() { for (var i = 0; i < S.devices.length; i++) if (S.devices[i].id === S.deviceId) return S.devices[i]; return null; }
  function isCloud() { return S.mode === 'cloud'; }

  /* ------------------------------------------------------------- 弹簧 */
  function spring(from, to, z, k) {
    var w0 = Math.sqrt(k), A = from - to;
    var B = (z * w0 * A) / (w0 * Math.sqrt(Math.max(1 - z * z, 0)));
    return function (t) {
      if (z < 1) {
        var wd = w0 * Math.sqrt(1 - z * z), e = Math.exp(-z * w0 * t);
        return to + e * (A * Math.cos(wd * t) + B * Math.sin(wd * t));
      }
      if (z === 1) return to + (A + w0 * A * t) * Math.exp(-w0 * t);
      var r = w0 * Math.sqrt(z * z - 1), r1 = -z * w0 + r, r2 = -z * w0 - r;
      var cb = (0 - A * r2) / (r1 - r2);
      return to + (A - cb) * Math.exp(r1 * t) + cb * Math.exp(r2 * t);
    };
  }
  function animateKnob(knob, toRatio, done) {
    var from = parseFloat(knob.dataset.ratio || '0');
    var span = toRatio - from;
    if (Math.abs(span) < 0.001) { knob.style.transform = 'translate3d(' + (toRatio * 100) + '%,0,0)'; if (done) done(); return; }
    var pos = spring(from, toRatio, 0.78, 620);
    var t0 = performance.now();
    (function step(now) {
      var t = (now - t0) / 1000;
      var v = pos(t);
      knob.style.transform = 'translate3d(' + (v * 100) + '%,0,0)';
      if (Math.abs(v - toRatio) < 0.002 || t > 1.2) {
        knob.style.transform = 'translate3d(' + (toRatio * 100) + '%,0,0)';
        if (done) done();
        return;
      }
      requestAnimationFrame(step);
    })(t0);
  }

  /* ------------------------------------------------------------- 工具 */
  function h(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  var toastEl = null, toastTimer = 0;
  function toast(msg) {
    if (!toastEl) {
      toastEl = h('div', 'cm-toast');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 1900);
  }

  /* ============================================================ 切换器 */
  var switches = [];
  function makeSwitch(mini) {
    var el = h('div', 'cm-switch' + (mini ? ' cm-switch--mini' : ''));
    el.setAttribute('role', 'tablist');
    el.setAttribute('aria-label', '本地 / 云端 模式');
    el.innerHTML =
      '<div class="cm-switch__track">' +
        '<span class="cm-switch__lbl cm-switch__lbl--local" role="tab">本地</span>' +
        '<span class="cm-switch__lbl cm-switch__lbl--cloud" role="tab">云端</span>' +
      '</div>' +
      '<div class="cm-switch__knob"><span class="cm-switch__ktext">本地</span></div>';
    var knob = el.querySelector('.cm-switch__knob');
    var ktext = el.querySelector('.cm-switch__ktext');
    knob.dataset.ratio = '0';

    var api = {
      el: el,
      set: function (mode, animate) {
        var to = mode === 'cloud' ? 1 : 0;
        el.dataset.mode = mode;
        el.querySelectorAll('.cm-switch__lbl').forEach(function (l) {
          l.setAttribute('aria-selected', String((l.classList.contains('cm-switch__lbl--cloud') ? 'cloud' : 'local') === mode));
        });
        ktext.textContent = mode === 'cloud' ? '云端' : '本地';
        knob.dataset.ratio = String(to);
        if (animate) animateKnob(knob, to);
        else knob.style.transform = 'translate3d(' + (to * 100) + '%,0,0)';
      }
    };
    switches.push(api);

    el.querySelector('.cm-switch__lbl--local').addEventListener('click', function () { setMode('local'); });
    el.querySelector('.cm-switch__lbl--cloud').addEventListener('click', function () { setMode('cloud'); });

    // 拖拽
    var drag = null;
    knob.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      drag = { x: e.clientX, w: el.clientWidth / 2, ratio: modeRatio() };
      el.classList.add('is-drag');
      knob.setPointerCapture && knob.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    knob.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var r = Math.min(1, Math.max(0, drag.ratio + (e.clientX - drag.x) / drag.w));
      knob.style.transform = 'translate3d(' + (r * 100) + '%,0,0)';
      knob.dataset.ratio = String(r);
    });
    function end() {
      if (!drag) return;
      var r = parseFloat(knob.dataset.ratio || '0');
      drag = null;
      el.classList.remove('is-drag');
      setMode(r > 0.5 ? 'cloud' : 'local');
    }
    knob.addEventListener('pointerup', end);
    knob.addEventListener('pointercancel', end);
    knob.addEventListener('lostpointercapture', end);

    function modeRatio() { return el.dataset.mode === 'cloud' ? 1 : 0; }
    return api;
  }

  /* ============================================================ 弹层 */
  var sheetRoot = null;
  function openSheet(opts) {
    closeSheet(true);
    var root = h('div', 'cm-sheet-root');
    root.innerHTML =
      '<div class="cm-backdrop"></div>' +
      '<div class="cm-sheet" role="dialog" aria-modal="true">' +
        '<div class="cm-grab"></div>' +
        '<div class="cm-sheet__head"><div class="cm-sheet__title"></div>' +
          '<button class="cm-sheet__x" aria-label="关闭">' + I.x + '</button></div>' +
        '<div class="cm-sheet__body"></div>' +
        (opts.foot ? '<div class="cm-sheet__foot"></div>' : '') +
      '</div>';
    root.querySelector('.cm-sheet__title').textContent = opts.title || '';
    var body = root.querySelector('.cm-sheet__body');
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    if (opts.foot) {
      var f = root.querySelector('.cm-sheet__foot');
      if (typeof opts.foot === 'string') f.innerHTML = opts.foot;
      else f.appendChild(opts.foot);
    }
    root.querySelector('.cm-backdrop').addEventListener('click', function () { closeSheet(); });
    root.querySelector('.cm-sheet__x').addEventListener('click', function () { closeSheet(); });
    document.body.appendChild(root);
    requestAnimationFrame(function () { root.classList.add('is-open'); });
    sheetRoot = root;
    if (opts.onMount) opts.onMount(root);
    return root;
  }
  function closeSheet(instant) {
    var r = sheetRoot;
    if (!r) return;
    sheetRoot = null;
    r.classList.remove('is-open');
    if (instant) { r.remove(); return; }
    setTimeout(function () { r.remove(); }, 300);
  }

  /* -------------------------------------------------- 设备列表弹层 */
  function sheetDevices() {
    // 在线状态由后台探活持续更新：打开弹层时先取一次最新值，别把启动那一刻的「离线」端给用户。
    try { if (B && B.devices) S.devices = B.devices(); } catch (e) {}
    var body = h('div', 'cm-anim-stagger');
    S.devices.forEach(function (d) {
      var it = h('button', 'cm-item' + (d.id === S.deviceId ? ' is-active' : ''));
      it.innerHTML =
        '<span class="cm-item__ico">' + I.laptop + '</span>' +
        '<span class="cm-item__body"><span class="cm-item__t">' + esc(d.name) + '</span>' +
        '<span class="cm-item__s">' + esc(d.host) + ' · ' + (d.online ? '在线' : '离线') + '</span>' +
        '<span class="cm-item__s cm-item__pair cm-item__pair--' + esc(d.pairingTone || 'ok') + '">' + esc(d.pairingText || '') + '</span></span>' +
        '<span class="cm-item__check">' + I.check + '</span>' +
        '<span class="cm-item__act" role="button" aria-label="删除设备">' + I.trash + '</span>';
      it.addEventListener('click', function (e) {
        if (e.target.closest('.cm-item__act')) return;
        // 「离线」只是上一次探活结论，不是拒绝连接的理由：用户点它就是要重连，
        // 真实可达性由传输层和后续探活回答（之前这里的硬拦截让新配对设备永远选不中）。
        S.deviceId = d.id; S.dir = ''; save();
        if (B && B.selectDevice) B.selectDevice(d.id);
        closeSheet();
        refreshAll();
        syncThenToast('已选择 ' + d.name + '，正在连接');
      });
      it.querySelector('.cm-item__act').addEventListener('click', function (e) {
        e.stopPropagation();
        confirmRemove(d);
      });
      body.appendChild(it);
    });
    var add = h('button', 'cm-add', I.plus + '<span>添加设备</span>');
    add.addEventListener('click', function () { closeSheet(); setTimeout(sheetAddDevice, 120); });
    body.appendChild(add);

    openSheet({
      title: '选择设备',
      body: body,
      foot: '扫码或粘贴连接码连接电脑后，手机上就能继续电脑上的对话。'
    });
    var foot = document.querySelector('.cm-sheet__foot');
    if (foot) foot.className = 'cm-hint', foot.innerHTML = I.cloud + '<span>扫码或粘贴连接码连接电脑后，手机上就能继续电脑上的对话</span>';
  }

  function confirmRemove(d) {
    var body = h('div', '', '<div class="cm-item" style="pointer-events:none">' +
      '<span class="cm-item__ico">' + I.laptop + '</span>' +
      '<span class="cm-item__body"><span class="cm-item__t">' + esc(d.name) + '</span>' +
      '<span class="cm-item__s">' + esc(d.host) + '</span></span></div>');
    var foot = h('div', '', '');
    foot.style.display = 'flex'; foot.style.gap = '10px'; foot.style.width = '100%';
    var cancel = h('button', 'cm-btn', '取消');
    var del = h('button', 'cm-btn cm-btn--danger', '删除设备');
    cancel.addEventListener('click', function () { closeSheet(); });
    del.addEventListener('click', function () {
      S.devices = S.devices.filter(function (x) { return x.id !== d.id; });
      if (S.deviceId === d.id) { S.deviceId = ''; S.dir = ''; }
      if (B && B.removeDevice) B.removeDevice(d.id);
      save(); closeSheet(); refreshAll(); toast('已删除设备');
    });
    foot.appendChild(cancel); foot.appendChild(del);
    openSheet({ title: '删除这台设备？', body: body, foot: foot });
  }

  /* -------------------------------------------------- 添加设备弹层 */
  function sheetAddDevice() {
    var body = h('div', 'cm-anim');
    /* 真实桥只认完整连接码（B.addDevice 走 coomi:// / JSON 解析），6 格短码是
       未来短码兑换的占位。以前真实环境下 6 格先展示、还自动聚焦弹键盘，
       用户输满 6 位「连接」仍然是灰的——表单在骗人。真实桥下直接收起 6 格。 */
    var real = !!(B && B.addDevice);
    body.innerHTML =
      (real ? '' :
        '<div class="cm-code">' +
          ['', '', '', '', '', ''].map(function () { return '<input maxlength="1" inputmode="text" aria-label="连接码">'; }).join('') +
        '</div>') +
      '<div class="cm-hint" style="margin:0 6px 10px">' + I.keypad + '<span>' +
        (real ? '粘贴电脑端生成的完整连接码，或扫描二维码' : '输入连接码（或扫描二维码）') +
      '</span></div>' +
      '<input class="cm-code-full" placeholder="粘贴完整连接码 / coomi://…" autocomplete="off" style="width:100%;box-sizing:border-box;height:44px;padding:0 12px;margin:0 0 14px;border:1px solid var(--border);border-radius:12px;background:var(--bg);color:var(--text);font-size:13px" />' +
      '<div class="cm-scan">' +
        '<i class="cm-scan__corner"></i><i class="cm-scan__corner"></i><i class="cm-scan__corner"></i><i class="cm-scan__corner"></i>' +
        '<i class="cm-scan__line"></i>' +
      '</div>' +
      '<div style="text-align:center;color:var(--text-3);font-size:12px;margin-bottom:6px">或扫描电脑端「设备连接」页的二维码</div>';

    var scanBox = body.querySelector('.cm-scan');
    var fullInput0 = body.querySelector('.cm-code-full');
    if (scanBox) {
      scanBox.style.cursor = 'pointer';
      scanBox.addEventListener('click', function () {
        if (!(B && B.scan)) { toast('当前环境不支持扫码'); return; }
        B.scan().then(function (text) {
          if (fullInput0) { fullInput0.value = text; fullInput0.dispatchEvent(new Event('input')); }
          toast('已读取连接码，点「连接」继续');
        }).catch(function (e) { toast(e && e.message ? e.message : '扫码失败'); });
      });
    }
    var inputs = body.querySelectorAll('.cm-code input');
    inputs.forEach(function (inp, i) {
      inp.addEventListener('input', function () {
        inp.value = (inp.value || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase().slice(0, 1);
        if (inp.value && inputs[i + 1]) inputs[i + 1].focus();
        check();
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !inp.value && inputs[i - 1]) inputs[i - 1].focus();
      });
    });

    var foot = h('div', '', '');
    foot.style.display = 'flex'; foot.style.gap = '10px'; foot.style.width = '100%';
    var cancel = h('button', 'cm-btn', '取消');
    var ok = h('button', 'cm-btn cm-btn--primary', '连接');
    ok.disabled = true;
    cancel.addEventListener('click', function () { closeSheet(); });
    var fullInput = body.querySelector('.cm-code-full');
    ok.addEventListener('click', function () {
      var six = Array.prototype.map.call(inputs, function (x) { return x.value || ''; }).join('');
      var full = (fullInput && fullInput.value || '').trim();
      var code = full || six;
      if (B && B.addDevice) {
        ok.disabled = true;
        Promise.resolve(B.addDevice(code)).then(function (dev) {
          if (!dev) { toast('连接失败：连接码无效或已过期，请在电脑上重新生成'); ok.disabled = false; return; }
          S.deviceId = dev.id; S.dir = ''; save();
          closeSheet(); refreshAll(); syncThenToast('设备已连接');
        }).catch(function (e) {
          toast('连接失败：' + (e && e.message ? e.message : e));
          ok.disabled = false;
        });
        return;
      }
      var id = 'd' + Date.now();
      S.devices.push({ id: id, name: '新设备 · ' + code.slice(0, 3), host: '已通过连接码配对', online: true });
      S.deviceId = id; S.dir = ''; save();
      closeSheet(); refreshAll(); syncThenToast('设备已连接');
    });
    foot.appendChild(cancel); foot.appendChild(ok);
    openSheet({ title: '添加设备', body: body, foot: foot });
    if (fullInput) fullInput.addEventListener('input', check);
    // 真实桥下不自动聚焦：一进来就弹键盘会把扫码区和「连接」按钮顶到键盘后面。
    if (!real) setTimeout(function () { inputs[0] && inputs[0].focus(); }, 240);

    function check() {
      var six = Array.prototype.every.call(inputs, function (x) { return !!x.value; });
      var full = !!(fullInput && fullInput.value && fullInput.value.trim());
      // 接真实配对时只认完整连接码；6 格短码仅保留给未来短码兑换
      ok.disabled = (B && B.addDevice) ? !full : !(six || full);
    }
  }

  /* ---------------------------------------- 文件夹选择框（Windows 风格）
 * 纯 UI：内置一份假文件树用于演示。
 * 接真实实现只需覆盖钩子（返回值/ Promise），本 UI 会自动走它：
 *   window.__coomiPickFolderHook = (opts) => Promise<string|null>
 *   例：window.__coomiPickFolderHook = (o) => window.CoomiAndroid.pickFolder(o.start)
 */
  var FS = {
    '此电脑': [{ n: 'C:', d: 1, p: 'C:\\' }],
    'C:\\': [{ n: 'Users', d: 1 }, { n: 'Program Files', d: 1 }, { n: 'Windows', d: 1 }, { n: 'ProgramData', d: 1 }],
    'C:\\Users': [{ n: 'coomi', d: 1 }, { n: 'Public', d: 1 }],
    'C:\\Users\\coomi': [{ n: 'Desktop', d: 1 }, { n: 'Documents', d: 1 }, { n: 'Downloads', d: 1 }, { n: 'Projects', d: 1 }],
    'C:\\Users\\coomi\\Desktop': [],
    'C:\\Users\\coomi\\Documents': [{ n: 'notes', d: 1 }, { n: '报表.xlsx', d: 0 }, { n: '合同.pdf', d: 0 }],
    'C:\\Users\\coomi\\Downloads': [{ n: 'deepseek.apk', d: 0 }],
    'C:\\Users\\coomi\\Projects': [{ n: 'deepseek-harness', d: 1 }, { n: 'coomi', d: 1 }, { n: 'comax', d: 1 }],
    'C:\\Users\\coomi\\Projects\\deepseek-harness': [{ n: 'deepseek-web', d: 1 }, { n: 'reports', d: 1 }],
    'C:\\Users\\coomi\\Projects\\deepseek-harness\\deepseek-web': [{ n: 'index.html', d: 0 }],
    'C:\\Users\\coomi\\Projects\\deepseek-harness\\reports': [],
    'C:\\Users\\coomi\\Projects\\coomi': [{ n: 'data', d: 1 }, { n: 'config.json', d: 0 }],
    'C:\\Users\\coomi\\Projects\\comax': [{ n: 'data', d: 1 }]
  };
  var SHORTCUTS = [
    { n: '此电脑', p: '此电脑' },
    { n: '桌面', p: 'C:\\Users\\coomi\\Desktop' },
    { n: '文档', p: 'C:\\Users\\coomi\\Documents' },
    { n: '下载', p: 'C:\\Users\\coomi\\Downloads' }
  ];
  function parentsOf(p) {
    if (!p || p === '此电脑') return ['此电脑'];
    var out = ['此电脑'];
    var parts = p.split('\\').filter(Boolean);
    var acc = '';
    for (var i = 0; i < parts.length; i++) {
      acc = i === 0 ? parts[i] + '\\'
                    : acc + parts[i] + (i < parts.length - 1 ? '\\' : '');
      out.push(acc);
    }
    return out;
  }
  function leafOf(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || p;
  }
  function joinPath(base, name) {
    if (base === '此电脑') return name;
    return base.replace(/\\$/, '') + '\\' + name;
  }
  function openFolderPicker(opts) {
    opts = opts || {};
    var start = opts.start && FS[opts.start] ? opts.start : 'C:\\Users\\coomi';
    var cur = start;
    return new Promise(function (resolve) {
      var root = h('div', 'cm-dlg-root');
      root.innerHTML =
        '<div class="cm-dlg-backdrop"></div>' +
        '<div class="cm-dlg" role="dialog" aria-modal="true" aria-label="选择文件夹">' +
          '<div class="cm-dlg__titlebar"><span class="cm-dlg__t"></span>' +
            '<button class="cm-dlg__x" aria-label="关闭">' + I.x + '</button></div>' +
          '<div class="cm-dlg__crumb"></div>' +
          '<div class="cm-dlg__body">' +
            '<div class="cm-dlg__side"></div>' +
            '<div class="cm-dlg__list"></div>' +
          '</div>' +
          '<div class="cm-dlg__foot">' +
            '<div class="cm-dlg__path"></div>' +
            '<button class="cm-btn" data-cancel>取消</button>' +
            '<button class="cm-btn cm-btn--primary" data-ok>选择</button>' +
          '</div>' +
        '</div>';
      root.querySelector('.cm-dlg__t').textContent = opts.title || '选择文件夹';
      var crumb = root.querySelector('.cm-dlg__crumb');
      var side = root.querySelector('.cm-dlg__side');
      var list = root.querySelector('.cm-dlg__list');
      var pathBox = root.querySelector('.cm-dlg__path');

      function done(v) {
        root.classList.remove('is-open');
        setTimeout(function () { root.remove(); }, 260);
        resolve(v);
      }
      root.querySelector('.cm-dlg__x').addEventListener('click', function () { done(null); });
      root.querySelector('.cm-dlg-backdrop').addEventListener('click', function () { done(null); });
      root.querySelector('[data-cancel]').addEventListener('click', function () { done(null); });
      root.querySelector('[data-ok]').addEventListener('click', function () {
        done(cur === '此电脑' ? 'C:\\' : cur);
      });

      function render() {
        // 面包屑
        crumb.innerHTML = '';
        var segs = parentsOf(cur);
        segs.forEach(function (p, idx) {
          if (idx) crumb.appendChild(h('span', 'sep', '›'));
          if (idx === segs.length - 1) {
            crumb.appendChild(h('span', 'cur', leafOf(p) || p));
          } else {
            var b = h('button', '', leafOf(p) || p);
            b.addEventListener('click', function () { cur = p; render(); });
            crumb.appendChild(b);
          }
        });
        // 左栏
        side.innerHTML = '';
        SHORTCUTS.forEach(function (s) {
          var b = h('button', (cur === s.p ? 'is-on' : ''), I.folder + '<span>' + s.n + '</span>');
          b.addEventListener('click', function () { cur = s.p; render(); });
          side.appendChild(b);
        });
        // 右侧列表
        list.innerHTML = '';
        var items = FS[cur] || [];
        if (!items.length) {
          list.appendChild(h('div', 'cm-dlg__empty', '此文件夹为空'));
        } else {
          items.forEach(function (it) {
            var row = h('button', 'cm-folder' + (it.d ? '' : ' is-file'));
            row.innerHTML =
              '<span class="cm-folder__ico">' + (it.d ? I.folder : I.file) + '</span>' +
              '<span class="cm-folder__n">' + esc(it.n) + '</span>' +
              (it.d ? '<span class="cm-folder__go">' + I.chev + '</span>' : '<span class="cm-folder__m">文件</span>');
            if (it.d) {
              row.addEventListener('click', function () { cur = it.p || joinPath(cur, it.n); render(); });
            }
            list.appendChild(row);
          });
        }
        pathBox.textContent = cur === '此电脑' ? '此电脑' : cur;
      }
      render();
      document.body.appendChild(root);
      requestAnimationFrame(function () { root.classList.add('is-open'); });
    });
  }

  /** 远端目录选择器：数据来自 bridge.listDir（/api/device/remote-fs/list）。 */
  function openRemoteFolderPicker(opts) {
    opts = opts || {};
    var cur = String(opts.start || '');
    return new Promise(function (resolve) {
      var root = h('div', 'cm-dlg-root');
      root.innerHTML =
        '<div class="cm-dlg-backdrop"></div>' +
        '<div class="cm-dlg" role="dialog" aria-modal="true" aria-label="选择文件夹">' +
          '<div class="cm-dlg__titlebar"><span class="cm-dlg__t">' + esc(opts.title || '选择文件夹') + '</span>' +
            '<button class="cm-dlg__x" aria-label="关闭">' + I.x + '</button></div>' +
          '<div class="cm-dlg__crumb"></div>' +
          '<div class="cm-dlg__body"><div class="cm-dlg__side"></div><div class="cm-dlg__list"></div></div>' +
          '<div class="cm-dlg__foot"><div class="cm-dlg__path"></div>' +
            '<button class="cm-btn" data-cancel>取消</button>' +
            '<button class="cm-btn cm-btn--primary" data-ok>选择</button></div>' +
        '</div>';
      var crumb = root.querySelector('.cm-dlg__crumb');
      var side = root.querySelector('.cm-dlg__side');
      var list = root.querySelector('.cm-dlg__list');
      var pathBox = root.querySelector('.cm-dlg__path');
      var curPath = '';
      var entries = [];
      var loading = false;

      function done(v) {
        root.classList.remove('is-open');
        setTimeout(function () { root.remove(); }, 260);
        resolve(v);
      }
      root.querySelector('.cm-dlg__x').addEventListener('click', function () { done(null) });
      root.querySelector('.cm-dlg-backdrop').addEventListener('click', function () { done(null) });
      root.querySelector('[data-cancel]').addEventListener('click', function () { done(null) });
      root.querySelector('[data-ok]').addEventListener('click', function () { done(curPath || null) });

      function normalizeRemotePath(p) {
        var s = String(p || '');
        if (s.indexOf('\\\\?\\') === 0) s = s.slice(4);
        if (s.indexOf('\\\\?\\UNC\\') === 0) s = '\\\\' + s.slice(8);
        return s;
      }
      function joinPath(base, name) {
        if (!base) return name;
        var sep = base.indexOf('\\') >= 0 ? '\\' : '/';
        return /[\\/]$/.test(base) ? base + name : base + sep + name;
      }
      function parentsOfPath(p) {
        if (!p) return [];
        var sep = p.indexOf('\\') >= 0 ? '\\' : '/';
        var hasRoot = p.charAt(0) === sep;
        var parts = p.split(/[\\/]/).filter(Boolean);
        var out = []; var acc = hasRoot ? sep : '';
        parts.forEach(function (part, i) {
          acc = i === 0 ? (hasRoot ? sep + part + sep : part + sep) : acc + part + (i < parts.length - 1 ? sep : '');
          out.push(acc);
        });
        return out;
      }
      function leaf(p) { var a = String(p).replace(/[\\/]+$/, '').split(/[\\/]/); return a[a.length - 1] || p; }

      function render() {
        // 面包屑
        crumb.innerHTML = '';
        var segs = parentsOfPath(curPath);
        var home = h('button', '', '此电脑');
        home.addEventListener('click', function () { void load(''); });
        crumb.appendChild(home);
        segs.forEach(function (p) {
          crumb.appendChild(h('span', 'sep', '›'));
          var b = h('button', p === curPath ? 'cur' : '', leaf(p));
          b.addEventListener('click', function () { void load(p); });
          crumb.appendChild(b);
        });
        // 左栏：设备根 + 当前路径的父级
        side.innerHTML = '';
        var shortcuts = [{ n: '此电脑', p: '' }];
        var rootName = opts.device || '电脑';
        shortcuts.push({ n: rootName + ' 工作目录', p: curPath.split(/[\\/]/).slice(0, 2).join('/') || '' });
        shortcuts.forEach(function (s) {
          var b = h('button', curPath === s.p ? 'is-on' : '', I.folder + '<span>' + esc(s.n) + '</span>');
          b.addEventListener('click', function () { void load(s.p); });
          side.appendChild(b);
        });
        // 列表
        list.innerHTML = '';
        if (loading) { list.appendChild(h('div', 'cm-dlg__empty', '正在读取电脑目录…')); }
        else if (!entries.length) { list.appendChild(h('div', 'cm-dlg__empty', '此文件夹为空')); }
        else {
          entries.forEach(function (it) {
            var row = h('button', 'cm-folder' + (it.is_dir ? '' : ' is-file'));
            row.innerHTML = '<span class="cm-folder__ico">' + (it.is_dir ? I.folder : I.file) + '</span>' +
              '<span class="cm-folder__n">' + esc(it.name) + '</span>' +
              (it.is_dir ? '<span class="cm-folder__go">' + I.chev + '</span>' : '<span class="cm-folder__m">文件</span>');
            if (it.is_dir) row.addEventListener('click', function () { void load(joinPath(curPath || '', it.name)); });
            list.appendChild(row);
          });
        }
        pathBox.textContent = curPath || '此电脑';
      }

      function load(path) {
        loading = true; render();
        return Promise.resolve(B.listDir(path)).then(function (data) {
          curPath = normalizeRemotePath(data && data.path ? data.path : path);
          entries = (data && data.entries || []).slice().sort(function (a, b) {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return String(a.name).localeCompare(String(b.name));
          });
          loading = false; render();
        }).catch(function (e) {
          loading = false;
          entries = [];
          render();
          toast('读取目录失败：' + (e && e.message ? e.message : e));
        });
      }
      document.body.appendChild(root);
      requestAnimationFrame(function () { root.classList.add('is-open'); });
      void load(cur);
    });
  }

  /** 对外接口：真机走远端浏览；没有真实目录来源时明确告知，不回退假文件树。 */
  function pickFolder(opts) {
    if (typeof window.__coomiPickFolderHook === 'function') {
      return Promise.resolve(window.__coomiPickFolderHook(opts));
    }
    if (B && B.listDir && device()) return openRemoteFolderPicker(opts);
    if (!device()) toast('请先选择设备');
    else toast('当前环境无法读取电脑目录');
    return Promise.resolve(null);
  }

  /* -------------------------------------------------- 目录入口 */
  function sheetDirs() {
    var d = device();
    if (!d) { toast('请先选择设备'); return; }
    pickFolder({ start: S.dir || '', device: d.name, title: '选择 ' + (d.name || '电脑') + ' 上的工作目录' })
      .then(function (p) {
        if (!p) return;
        S.dir = p; S.appDir = ''; save(); refreshAll();
        toast('工作目录：' + p);
      });
  }

  /* -------------------------------------------------- 云端状态弹层 */
  function sheetCloudSettings() {
    var d = device();
    var body = h('div', 'cm-anim');
    body.innerHTML =
      '<div class="cm-toggle"><div class="cm-toggle__body">' +
        '<div class="cm-toggle__t">当前设备</div>' +
        '<div class="cm-toggle__s">' + (d ? esc(d.name) + ' · ' + (d.online ? '在线' : '离线') + ' · ' + esc(d.host) : '未选择电脑') + '</div></div></div>' +
      '<div class="cm-toggle"><div class="cm-toggle__body">' +
        '<div class="cm-toggle__t">通道</div>' +
        '<div class="cm-toggle__s">' + esc(transportText().replace(/^ · /, '') || '尚未连接') + '</div></div></div>' +
      '<div class="cm-toggle"><div class="cm-toggle__body">' +
        '<div class="cm-toggle__t">模型与参数</div>' +
        '<div class="cm-toggle__s">跟随所选设备实时读取；切回本地后自动使用本机模型</div></div></div>' +
      '<div class="cm-hint" style="margin:6px 8px 4px">' + I.lock +
        '<span>云端模式下「群聊」与「协同工作台」不可用，需切回本地</span></div>';
    openSheet({ title: '云端状态', body: body });
  }

  function syncThenToast(msg) {
    // 真实同步由 Vue 的 ChatView / sessions store 驱动；这里只报状态，
    // 不再播「假骨架屏」假装历史已经同步完。
    toast(msg || '已切换');
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function baseName(p) { var a = String(p).split('/'); return a[a.length - 1] || p; }

  /* ==================================================== 首页：云端区块 */
  var homeBlock = null;
  var lastHomeSig = '';
  function homeHost() {
    // .empty-center 是横向 flex，真正承载内容的纵向容器是 .empty-sm
    var center = document.querySelector('.chat .empty-center');
    if (!center) return null;
    return center.querySelector('.empty-sm') || center;
  }
  function homeSig() {
    return [S.mode, S.deviceId, S.dir, S.appDir, S.devices.length, S.devices.map(function (x) { return x.id + (x.online ? '1' : '0'); }).join('.')].join('|');
  }
  function transportText() {
    var t = window.__coomiTransport;
    if (!t) return '';
    var names = { webrtc: 'WebRTC 直连', relay: '加密中转', lan: '局域网直连' };
    var name = names[t.phase] || t.phase;
    if (t.state === 'open') return ' · ' + name;
    if (t.reason) return ' · ' + t.reason;
    return ' · ' + name + '连接中';
  }

  /* ==================================================== 首页（已下线）
     原来这里会往 .empty-sm 里插 cm-home 块（设备卡 + 目录卡 + 连接提示）。
     这些与输入框下方的 dock chip 完全重复，而且它依赖的 CSS 用 !important
     把空态改成 flex-start + 不对称 padding，主标题因此被顶到偏上、不在
     视觉中心。整块下线，只保留一个空函数兼容旧调用点。 */
  function renderHome() {
    return;
  }

  /* ==================================================== 侧边栏增强 */
  var sideDev = null, sideSettings = null;
  var lastSideSig = '';
  function sideSig() {
    return [S.mode, S.deviceId, S.devices.length, S.devices.map(function (x) {
      return x.id + (x.online ? '1' : '0') + x.name;
    }).join('.'), !!document.querySelector('.drawer-root .panel .entry-row')].join('|');
  }
  function renderSidebar(force) {
    var panel = document.querySelector('.drawer-root .panel');
    if (!panel) return;
    var sideChanged = force || sideSig() !== lastSideSig;
    lastSideSig = sideSig();

    // 1) 顶部模式切换器已下线。
    //    切模式的入口在输入框下方的 dock chip（本机 ▾），
    //    侧栏这里再放一个胶囊只会和抽履顶部的设备行抢位置。
    //    注意：不能事后 remove —— MutationObserver 会把它重建回来。

    // 2) 云端设备区
    var entryRow = panel.querySelector('.entry-row');
    if (!isCloud()) {
      if (sideDev) { sideDev.remove(); sideDev = null; }
    } else {
      if (!sideDev || !panel.contains(sideDev)) {
        sideDev = h('button', 'cm-devrow cm-anim');
        if (entryRow) panel.insertBefore(sideDev, entryRow);
        else panel.appendChild(sideDev);
        sideDev.addEventListener('click', sheetDevices);
      }
      // 只保留一行：当前设备 + 在线数，点开就是完整设备列表（选择/删除/添加都在弹层里）
      var cur = device();
      var onlineN = S.devices.filter(function (x) { return x.online; }).length;
      // 一台设备都没有时不说「切换」——没东西可切；给出唯一动作：添加。
      var devSub = S.devices.length === 0
        ? '还没有设备 · 点此添加'
        : onlineN + ' 台可用 · 点此切换/添加';
      // 抽屉这一行不重复报「剩 20 小时」（正常态没必要占位），只在快到期/已过期时提醒。
      var warn = cur && cur.pairingTone && cur.pairingTone !== 'ok' ? cur.pairingText : '';
      sideDev.innerHTML =
        '<span class="cm-devrow__ico">' + I.laptop + '</span>' +
        '<span class="cm-devrow__body">' +
          '<span class="cm-devrow__t">' + (cur ? esc(cur.name) : '选择设备') + '</span>' +
          '<span class="cm-devrow__s">' + (cur ? (cur.online ? '在线 · ' : '离线 · ') : '') +
            devSub + '</span>' +
          (warn ? '<span class="cm-devrow__s cm-devrow__s--' + esc(cur.pairingTone) + '">' + esc(warn) + '</span>' : '') +
        '</span>' +
        '<span class="cm-chev">' + I.chevDown + '</span>';
    }

    // 3) 云端模式禁用「群聊 / 协同」
    if (entryRow) {
      Array.prototype.forEach.call(entryRow.children, function (c) {
        var t = (c.textContent || '');
        var blocked = /群聊|协同/.test(t);
        c.classList.toggle('cm-off', blocked && isCloud());
        if (blocked && isCloud()) {
          if (!c.__cmBound) {
            c.__cmBound = true;
            c.addEventListener('click', function (ev) {
              if (!isCloud()) return;
              ev.preventDefault(); ev.stopPropagation();
              toast('云端模式下不可用，切回本地即可使用');
            }, true);
          }
        }
      });
    }
    // 云端模式隐藏「选择工作目录」（侧栏不做目录选择）
    var cwdRow = panel.querySelector('.cwdrow');
    if (cwdRow) cwdRow.style.display = isCloud() ? 'none' : '';

    // 4) 云端设置入口：收进底栏图标位（不再占一整行，把高度让给会话列表）
    var foot = panel.querySelector('.dfoot');
    if (!isCloud()) {
      if (sideSettings) { sideSettings.remove(); sideSettings = null; }
    } else if (foot) {
      if (!sideSettings || !foot.contains(sideSettings)) {
        sideSettings = h('button', 'fsq cm-cloudbtn');
        sideSettings.setAttribute('aria-label', '云端设置');
        sideSettings.setAttribute('title', '云端设置');
        sideSettings.innerHTML = I.cloud;
        sideSettings.addEventListener('click', sheetCloudSettings);
        foot.insertBefore(sideSettings, foot.lastElementChild || null);
      }
    }

    // 5) 文档级类，供 CSS 联动
    document.documentElement.classList.toggle('cm-cloud', isCloud());
  }

  /* ============================================================ 总刷新 */
  var mountTimer = 0;
  function refreshAll() {
    try { if (B && B.devices) S.devices = B.devices(); if (B && B.getMode) S.mode = B.getMode(); } catch (e) {}
    switches.forEach(function (s) { s.set(S.mode, true); });
    renderSidebar();
  }
  function setMode(mode, opts) {
    if (S.mode === mode) { refreshAll(); return; }
    S.mode = mode; save();
    refreshAll();
    if (!opts || opts.silent !== true) {
      if (mode === 'cloud') {
        var d = device();
        toast(d ? '已切换到云端：' + d.name : '已切换到云端，请选择设备');
      } else {
        toast('已切回本地');
      }
    }
  }

  /* ============================================ 首页切换器挂载 / 守护 */
  var homeSwitchApi = null;
  /* 首页模式切换器已下线：入口在输入框下方的 dock chip。 */

  /* 空状态自适应：内容底部不得压住输入框，超出则上移锚点 */
  function fitEmpty() {
    var center = document.querySelector('.chat .empty-center');
    var sm = center && center.querySelector('.empty-sm');
    var comp = document.querySelector('.chat .composer');
    if (!center || !sm) return;
    center.style.removeProperty('--cm-top');
    if (!comp) return;
    var limit = comp.getBoundingClientRect().top - 14;
    var bottom = sm.getBoundingClientRect().bottom;
    if (bottom > limit) {
      var cur = parseFloat(getComputedStyle(center).paddingTop) || 0;
      var next = Math.max(24, cur - (bottom - limit));
      center.style.setProperty('--cm-top', next + 'px');
    }
  }

  window.addEventListener('coomi:transport-state', function () { renderSidebar(true); });

  function boot() {
    /* 首页的「本地 / 云端」切换器与 cm-home 卡片块已下线：
       这两块与输入框下方的 dock chip（本机 / 工作目录）功能重复，
       而它们靠 !important 覆盖了空态布局（align-items:flex-start +
       不对称 padding），导致首页主标题既偏上又不在视觉中心。
       这里只保留侧栏增强。 */
    renderSidebar();
  }

  var OWN = '.cm-home,.cm-drawer-head,.cm-devlist,.cm-sheet-root,.cm-toast,.cm-row,.cm-skel';
  var mo = new MutationObserver(function (muts) {
    // 忽略自己造成的 DOM 变化，否则会自我触发重建 → 入场动画反复重启
    var foreign = false;
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target;
      if (t && t.nodeType === 1 && !t.closest(OWN)) { foreign = true; break; }
    }
    if (!foreign) return;
    clearTimeout(mountTimer);
    mountTimer = setTimeout(boot, 60);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  // 后台探活（useConnectionContext 每 10~30 秒）改了在线状态就重绘一次，按钮文字与圆点跟着走。
  window.addEventListener('coomi:device-status', function () { if (B && B.devices) S.devices = B.devices(); refreshAll(); });

  /* 云端模式下：点附件按钮提示走 P2P，路径为电脑端（不拦截原行为） */
  document.addEventListener('click', function (e) {
    if (!isCloud()) return;
    var t = e.target;
    if (!t || !t.closest) return;
    var btn = t.closest('.composer button, .composer [role="button"]');
    if (!btn) return;
    if (btn.querySelector('svg') && /attach|plus|add/i.test(btn.className + btn.getAttribute('aria-label'))) {
      toast('文件将通过 P2P 直传到电脑：' + (S.dir || '/Users/coomi/Projects'));
    }
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 120);
  setTimeout(boot, 600);

  /* 调试口 */
  window.__coomiCloudApi = {
    state: function () { return { mode: S.mode, deviceId: S.deviceId, dir: S.dir, appDir: S.appDir, devices: S.devices }; },
    setMode: setMode,
    pickDevice: function (id) { S.deviceId = id; S.dir = ''; save(); if (B && B.selectDevice) B.selectDevice(id); refreshAll(); },
    settings: sheetCloudSettings,
    devices: sheetDevices,
    addDevice: sheetAddDevice,
    dirs: sheetDirs,
    pickFolder: pickFolder,
    /* 路由切走时由 App 调：弹层挂在 body 上，自己不感知路由，不关会盖住新页面。 */
    closeSheet: function () { closeSheet(true); },
    setFolderHook: function (fn) { window.__coomiPickFolderHook = fn; },
  };
})();
