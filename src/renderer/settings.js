'use strict';
(async () => {
  const api = window.superlay;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let { settings: S, presets, version } = await api.getSettings();
  let diag = null;
  let games = [];
  $('#version').textContent = `v${version}`;

  const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const patchFor = (p, v) => p.split('.').reduceRight((acc, k) => ({ [k]: acc }), v);
  const set = (p, v) => api.setSettings(patchFor(p, v)).then((s) => { S = s; refreshAll(); });

  // ---------------------------------------------------------------- nav
  $$('#nav button').forEach((b) => b.addEventListener('click', () => {
    $$('#nav button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === b.dataset.page));
    if (b.dataset.page === 'games') loadGames();
    $$('.seg, .layout-pick, .pos-pick').forEach(placeThumb);
  }));

  // ---------------------------------------------------------------- generic bindings
  const FMT = {
    x: (v) => `${(+v).toFixed(2)}×`, pct: (v) => `${Math.round(v * 100)}%`, px: (v) => `${v}px`,
    ms: (v) => `${v} ms`, s: (v) => `${v} s`,
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  $$('[data-bind]').forEach((el) => {
    const p = el.dataset.bind;
    const out = el.parentElement.querySelector('output');
    const commit = debounce((v) => set(p, v), el.type === 'range' || el.type === 'text' ? 120 : 0);
    el.addEventListener('input', () => {
      let v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
      if (out) out.textContent = FMT[out.dataset.fmt]?.(v) ?? v;
      if (el.type !== 'text') S = { ...S, ...mergeLocal(S, p, v) };
      if (el.type === 'range' || el.type === 'color') pushPreview();
      commit(v);
    });
  });
  function mergeLocal(obj, p, v) {
    const [a, b] = p.split('.');
    return b ? { [a]: { ...obj[a], [b]: v } } : { [a]: v };
  }

  function syncBindings() {
    $$('[data-bind]').forEach((el) => {
      const v = get(S, el.dataset.bind);
      if (document.activeElement === el && el.type === 'text') return;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = FMT[out.dataset.fmt]?.(v) ?? v;
    });
    $$('[data-seg]').forEach((g) => {
      const v = String(get(S, g.dataset.seg));
      $$('button', g).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      placeThumb(g);
    });
    $('#customHex').textContent = S.theme.customAccent;
    $('#presetField').style.display = S.theme.mode === 'custom' ? 'none' : '';
    $('#customField').style.display = S.theme.mode === 'custom' ? '' : 'none';
  }

  // segmented controls with a sliding thumb
  $$('[data-seg]').forEach((g) => {
    if (g.classList.contains('seg')) { const t = document.createElement('span'); t.className = 'thumb'; g.prepend(t); }
    $$('button', g).forEach((b) => b.addEventListener('click', () => set(g.dataset.seg, b.dataset.v)));
  });
  function placeThumb(g) {
    const t = $('.thumb', g); const on = $('button.on', g);
    if (!t || !on || !on.offsetWidth) return;
    t.style.left = `${on.offsetLeft}px`; t.style.width = `${on.offsetWidth}px`;
  }

  // ---------------------------------------------------------------- metrics
  const METRICS = [
    ['fps', 'Displayed FPS', 'Frames that reached the screen'],
    ['renderedFps', 'Rendered FPS', 'Shown when frame generation is active'],
    ['framegen', 'Frame-gen badge', 'Multiplier and generator name'],
    ['frametime', 'Frame time', 'Average displayed frame time'],
    ['graph', 'Frame-time graph', 'With stutter markers'],
    ['low1', '1% low', ''],
    ['latency', 'PC latency', 'Needs Reflex/PCL markers from the game'],
    ['upscaler', 'Upscaler', 'DLSS / FSR / XeSS and version'],
    ['gpuLoad', 'GPU load', ''],
    ['gpuTemp', 'GPU temperature', ''],
    ['gpuClock', 'GPU clock', ''],
    ['vram', 'VRAM', ''],
    ['cpuLoad', 'CPU load', ''],
    ['ram', 'RAM', ''],
    ['time', 'Clock', 'Current time'],
  ];
  $('#metricToggles').innerHTML = METRICS.map(([k, n, d]) => `
    <label class="toggle-row"><span>${n}${d ? `<small>${d}</small>` : ''}</span><input type="checkbox" data-metric="${k}"><i class="sw"></i></label>`).join('');
  $$('[data-metric]').forEach((el) => el.addEventListener('change', () => set(`metrics.${el.dataset.metric}`, el.checked)));
  function syncMetrics() { $$('[data-metric]').forEach((el) => { el.checked = S.metrics[el.dataset.metric] !== false; }); }

  // ---------------------------------------------------------------- presets
  $('#presets').innerHTML = Object.entries(presets).map(([k, p]) => `
    <button class="preset" data-preset="${k}">
      <div class="sw3"><i style="background:${p.bg}"></i><i style="background:${p.surface}"></i><i style="background:${p.accent2}"></i><i style="background:${p.accent}"></i></div>
      <span>${esc(p.name)}</span></button>`).join('');
  $$('[data-preset]').forEach((b) => b.addEventListener('click', () => api.setSettings({ theme: { preset: b.dataset.preset, mode: 'preset' } }).then((s) => { S = s; refreshAll(); })));
  function syncPresets() { $$('[data-preset]').forEach((b) => b.classList.toggle('on', b.dataset.preset === S.theme.preset)); }

  // ---------------------------------------------------------------- theme tokens for this window + preview
  let palette = null;
  async function refreshPalette() {
    palette = await api.previewTheme({ mode: S.theme.mode, preset: S.theme.preset, customAccent: S.theme.customAccent });
    const rs = document.documentElement.style;
    rs.setProperty('--accent', palette.accent);
    rs.setProperty('--accent2', palette.accent2);
    rs.setProperty('--tint', palette.bg);
    pushPreview();
  }

  const preview = $('#preview');
  function currentGame() { return diag?.target?.key ? games.find((g) => g.key === diag.target.key) : null; }
  function pushPreview() {
    if (!palette || !preview.contentWindow) return;
    const g = currentGame();
    preview.contentWindow.postMessage({
      type: 'config',
      config: {
        overlay: S.overlay, metrics: S.metrics, stats: S.stats, theme: S.theme, framegen: S.framegen,
        palette, cover: g?.thumb || null, gameName: g?.name || diag?.target?.name || 'Preview', demo: true,
      },
    }, '*');
    const bg = $('#stageBg');
    if (g?.thumb) { bg.style.backgroundImage = `url("${g.thumb}")`; bg.classList.remove('empty'); } else { bg.style.backgroundImage = ''; bg.classList.add('empty'); }
  }
  preview.addEventListener('load', pushPreview);

  $('#demoToggle').addEventListener('change', (e) => api.setDemo(e.target.checked));

  // ---------------------------------------------------------------- games
  async function loadGames() {
    games = await api.listGames();
    const opts = (sel) => [`<option value="">Cover art</option>`]
      .concat(Object.entries(presets).map(([k, p]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${esc(p.name)}</option>`)).join('');
    $('#games').innerHTML = games.length ? games.map((g, i) => `
      <div class="game ${g.disabled ? 'disabled' : ''}" data-key="${g.key}" style="animation-delay:${i * 40}ms">
        ${g.thumb ? `<img src="${g.thumb}" alt="">` : '<div class="noimg"></div>'}
        <div class="gm">
          <h4 title="${esc(g.exe)}">${esc(g.name)}</h4>
          <div class="src">${esc({ steam: 'Steam library', 'steam-search': 'Steam store match', icon: 'App icon (no art found)' }[g.source] || g.source || '')}${g.appId ? ` · ${g.appId}` : ''}</div>
          <div class="pal">${(g.theme?.palette || [g.theme?.accent, g.theme?.accent2, g.theme?.bg]).filter(Boolean).map((c) => `<i style="background:${c}"></i>`).join('')}</div>
          <div class="acts">
            <select data-act="theme">${opts(g.themeOverride)}</select>
            <button class="btn ghost" data-act="refetch">Refetch art</button>
            <label><input type="checkbox" data-act="disable" ${g.disabled ? 'checked' : ''}> Overlay off</label>
            <button class="btn ghost danger" data-act="forget">Forget</button>
          </div>
        </div>
      </div>`).join('') : '<p class="muted">No games yet. They appear here after their first launch.</p>';
  }
  $('#games').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const key = b.closest('.game').dataset.key;
    if (b.dataset.act === 'refetch') { b.disabled = true; b.textContent = 'Fetching…'; await api.refetchGame(key); }
    if (b.dataset.act === 'forget') await api.forgetGame(key);
    loadGames(); refreshPalette();
  });
  $('#games').addEventListener('change', async (e) => {
    const el = e.target; const key = el.closest('.game')?.dataset.key; if (!key) return;
    if (el.dataset.act === 'theme') await api.updateGame(key, { themeOverride: el.value || null });
    if (el.dataset.act === 'disable') await api.updateGame(key, { disabled: el.checked });
    loadGames(); refreshPalette();
  });
  api.on('games:changed', () => { loadGames().then(pushPreview); refreshPalette(); });

  // ---------------------------------------------------------------- hotkeys
  const pretty = (a) => (a || 'Not set').replace(/\+/g, ' + ');
  function syncHotkeys() { $$('[data-hk]').forEach((b) => { if (!b.classList.contains('rec')) b.textContent = pretty(S.hotkeys[b.dataset.hk]); }); }
  let recording = null;
  $$('[data-hk]').forEach((b) => b.addEventListener('click', () => {
    if (recording) return;
    recording = b; b.classList.add('rec'); b.textContent = 'Press keys…';
    api.pauseHotkeys(true);
  }));
  const KEYMAP = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', '+': 'Plus' };
  window.addEventListener('keydown', async (e) => {
    if (!recording) return;
    e.preventDefault();
    const b = recording;
    const stop = async (val) => {
      recording = null; b.classList.remove('rec');
      if (val !== undefined) { S = await api.setSettings({ hotkeys: { [b.dataset.hk]: val } }); }
      const fails = await api.pauseHotkeys(false);
      $('#hkWarn').textContent = fails.length ? `Couldn't register: ${fails.join(', ')}. Another app may already use that shortcut.` : '';
      syncHotkeys();
    };
    if (e.key === 'Escape') return stop();
    if (e.key === 'Backspace') return stop('');
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    const key = KEYMAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    if (!mods.length && !/^F\d+$/.test(key)) { b.textContent = 'Add Ctrl, Alt or Shift…'; return; }
    stop([...mods, key].join('+'));
  });

  // ---------------------------------------------------------------- general
  const bl = $('#blocklist');
  bl.addEventListener('input', debounce(() => set('blocklist', bl.value.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean)), 400));
  $('#openData').addEventListener('click', () => api.openData());
  $('#resetAll').addEventListener('click', async () => { if (confirm('Reset every SuperLay setting to its default?')) { S = await api.resetSettings(); refreshAll(); } });

  // ---------------------------------------------------------------- diagnostics + live status
  const busy = async (btn, fn) => { btn.disabled = true; const t = btn.textContent; btn.textContent = 'Working…'; try { return await fn(); } finally { btn.disabled = false; btn.textContent = t; } };
  $('#pmDownload').addEventListener('click', (e) => busy(e.target, async () => {
    const r = await api.downloadPresentMon();
    if (!r.ok) alert(`Download failed: ${r.error}`);
  }));
  $('#pmBrowse').addEventListener('click', () => api.browsePresentMon());
  $('#pmRestart').addEventListener('click', () => api.restartPresentMon());
  $('#relaunch').addEventListener('click', () => api.relaunchAdmin());
  $('#pmBtns').addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'download') busy(e.target, async () => { const r = await api.downloadPresentMon(); if (!r.ok) alert(`Download failed: ${r.error}`); });
    if (a === 'browse') api.browsePresentMon();
    if (a === 'admin') api.relaunchAdmin();
    if (a === 'restart') api.restartPresentMon();
  });

  const fmt = {
    n: (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–'),
    gb: (b) => (b ? `${(b / 1073741824).toFixed(1)} GB` : '–'),
  };
  const SRC = { 'frame-type': 'measured (frame type)', pcl: 'Reflex/PCL timing', cadence: 'estimated (GPU cadence)', manual: 'manual multiplier', lossless: 'Lossless Scaling', none: '—' };
  const PM_TEXT = {
    running: ['ok', 'Capturing displayed frames with PresentMon.'],
    starting: ['warn', 'Starting PresentMon…'],
    missing: ['bad', 'PresentMon isn\'t installed. SuperLay uses Intel\'s open-source PresentMon to see every displayed frame, including generated ones.'],
    denied: ['bad', 'PresentMon needs administrator rights, or membership in Performance Log Users (sign out and back in after joining).'],
    error: ['bad', ''],
    stopped: ['warn', 'Capture stopped.'],
  };

  let lastTargetKey = null;
  async function refreshDiag() {
    try { diag = await api.diagnostics(); } catch { return; }
    const pmS = diag.presentmon || {};
    const [cls, txt] = PM_TEXT[pmS.state] || ['warn', ''];
    $('#pmPip').className = `pip ${cls}`;
    $('#pmText').textContent = (pmS.state === 'error' ? pmS.message : txt) + (pmS.state === 'running' && !pmS.frameTypeTracking ? ' Older build: per-frame type tracking unavailable, update for exact AFMF/XeSS FG detection.' : '');
    const btns = pmS.state === 'missing' ? [['download', 'Download PresentMon', ''], ['browse', 'Locate…', 'ghost']]
      : pmS.state === 'denied' ? [['admin', 'Relaunch as admin', '']]
        : pmS.state === 'error' ? [['restart', 'Retry', 'ghost']] : [];
    const html = btns.map(([a, l, c]) => `<button class="btn ${c}" data-a="${a}">${l}</button>`).join('');
    if ($('#pmBtns').dataset.h !== html) { $('#pmBtns').innerHTML = html; $('#pmBtns').dataset.h = html; }

    const g = diag.gpu;
    $('#senPip').className = `pip ${diag.helper?.state === 'running' ? 'ok' : diag.helper?.state === 'error' ? 'bad' : 'warn'}`;
    $('#senText').textContent = g ? `${g.name || 'GPU'} · ${fmt.n(g.load)}% · ${g.temp ? `${fmt.n(g.temp)} °C` : 'temp n/a'} · CPU ${fmt.n(diag.cpu)}%` : (diag.helper?.message || 'Starting…');

    const t = diag.target;
    $('#nowPlaying').innerHTML = t ? `<span class="dot"></span>${esc(t.name || t.app)}${t.stats ? ` · ${Math.round(t.stats.displayedFps)} fps` : ''}` : '';
    if ((t?.key || null) !== lastTargetKey) {
      lastTargetKey = t?.key || null;
      await loadGames();
      refreshPalette();
    }
    renderGameNow(t);

    $('#dPm').textContent = `${pmS.state || '–'}${pmS.message ? ` — ${pmS.message}` : ''}`;
    $('#dPmPath').textContent = pmS.exe || S.presentmon.path || 'not found';
    $('#dAdmin').textContent = diag.admin ? 'Yes' : 'No';
    $('#dPlu').textContent = diag.perfLogUser ? 'Yes' : 'No';
    const st = t?.stats;
    const live = [
      ['Target', t ? `${t.app || ''} (${t.pid})` : '—'],
      ['Displayed FPS', st ? fmt.n(st.displayedFps, 1) : '–'],
      ['Rendered FPS', st ? fmt.n(st.renderedFps, 1) : '–'],
      ['Present FPS', st ? fmt.n(st.presentFps, 1) : '–'],
      ['FG source', st ? SRC[st.fg.source] : '–'],
      ['1% / 0.1% low', st ? `${fmt.n(st.low1Fps)} / ${fmt.n(st.low01Fps)}` : '–'],
      ['Present mode', st?.presentMode || '–'],
      ['Runtime', st?.runtime || '–'],
      ['Frame-type column', st ? (st.frameTypeColumn ? 'present' : 'absent') : '–'],
      ['Display tracking', st ? (st.displayTracked ? 'yes' : 'no') : '–'],
      ['Detection method', t?.detection?.method || '–'],
      ['VRAM', g ? `${fmt.gb(g.vramUsed)} / ${fmt.gb(g.vramTotal)}` : '–'],
    ];
    $('#dLive').innerHTML = live.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
    $('#dProcs').innerHTML = (diag.processes || []).map((p) => `<div class="${t && p.pid === t.pid ? 'target' : ''}"><span>${esc(p.app)} (${p.pid})</span><span>${p.rate.toFixed(0)} presents/s</span></div>`).join('') || '<div>No processes presenting.</div>';
    if (diag.hotkeyFailures?.length) $('#hkWarn').textContent = `Couldn't register: ${diag.hotkeyFailures.join(', ')}.`;
  }

  function renderGameNow(t) {
    const box = $('#gameNow');
    if (!t) { box.innerHTML = '<p class="muted">No game detected. Start a game in borderless or windowed mode and it shows up here.</p>'; return; }
    const g = currentGame();
    const d = t.detection || {};
    const st = t.stats;
    const up = d.upscaler;
    const fgd = d.fg;
    const facts = [
      ['Displayed', st ? `${fmt.n(st.displayedFps)} fps` : '–'],
      ['Rendered', st ? `${fmt.n(st.renderedFps)} fps` : '–'],
      ['Frame gen', st?.fg?.active ? `${st.fg.name || 'Active'} ${st.fg.multiplier}× · ${SRC[st.fg.source]}` : fgd ? `${fgd.label} available, not active` : 'None detected'],
      ['Upscaler', up ? `${up.label}${up.version ? ` (${up.version})` : ''} · ${up.confidence}` : 'None detected'],
      ['Model', up?.model || '–'],
      ['Present mode', st?.presentMode || '–'],
    ];
    const html = `
      ${g?.thumb ? `<img class="cover" src="${g.thumb}" alt="">` : ''}
      <div class="meta">
        <h3>${esc(t.name || t.app)}</h3>
        <div class="muted" style="font-size:12px">${esc(t.exe || '')}</div>
        ${g?.theme?.palette ? `<div class="pal">${g.theme.palette.map((c) => `<i style="background:${c}"></i>`).join('')}</div>` : ''}
        <div class="facts">${facts.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
        ${(d.notes || []).map((n) => `<p class="note" style="margin:10px 0 0">${esc(n)}</p>`).join('')}
        ${up?.alternatives?.length ? `<p class="note" style="margin:6px 0 0">Also shipped: ${esc(up.alternatives.join(', '))}</p>` : ''}
      </div>`;
    if (box.dataset.h !== html) { box.innerHTML = html; box.dataset.h = html; }
  }

  // ---------------------------------------------------------------- wiring
  function refreshAll() {
    syncBindings(); syncMetrics(); syncPresets(); syncHotkeys();
    if (document.activeElement !== bl) bl.value = (S.blocklist || []).join('\n');
    refreshPalette();
  }
  api.on('settings:changed', (s) => { S = s; refreshAll(); });
  refreshAll();
  await loadGames();
  refreshDiag();
  setInterval(() => { if (!document.hidden) refreshDiag(); }, 1000);
  window.addEventListener('resize', () => $$('.seg').forEach(placeThumb));
})();
