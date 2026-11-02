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
    if (b.dataset.page === 'limiter') { limiterDirty = false; loadLimiter(); }
    if (b.dataset.page === 'components') loadComps(true);
    if (b.dataset.page === 'optiscaler') loadOpti(true);
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
    ['pacing', 'Pacing', 'Average frame-to-frame change; lower is smoother'],
    ['limiter', 'Frame cap', 'RTSS cap and limiter mode'],
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

  // ---------------------------------------------------------------- frame limiter (RTSS)
  const MODE_NAMES = { async: 'async', 'front-edge': 'front edge sync', 'back-edge': 'back edge sync' };
  const MODE_HELP = {
    async: 'RTSS\'s default: limits independently of the frame\'s timing.',
    'front-edge': 'Waits at the start of the frame, so each frame begins on a fixed beat. Usually the steadiest frame times.',
    'back-edge': 'Waits right before the frame is presented. An alternative if front edge sync misbehaves in a game.',
  };
  let limiterDirty = false;     // user has edited the cap/mode; don't overwrite with live values
  let limiterMode = 'front-edge';
  let limiterExe = null;
  let lastRtss = null;

  function setMode(m) {
    limiterMode = m;
    $$('#capMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
    placeThumb($('#capMode'));
    $('#modeHelp').textContent = MODE_HELP[m] || '';
  }
  { const t = document.createElement('span'); t.className = 'thumb'; $('#capMode').prepend(t); }
  $$('#capMode button').forEach((b) => b.addEventListener('click', () => { limiterDirty = true; setMode(b.dataset.v); }));
  $('#capVal').addEventListener('input', () => { limiterDirty = true; });
  $('#limGame').addEventListener('change', (e) => { limiterExe = e.target.value; limiterDirty = false; loadLimiter(); });
  $('#recUse').addEventListener('click', () => { if (lastRtss?.recommendation?.cap) { $('#capVal').value = lastRtss.recommendation.cap; limiterDirty = true; } });

  async function loadLimiter() {
    const r = await api.rtssStatus(limiterExe);
    lastRtss = r;
    $('#rtssPip').className = `pip ${r.installed && r.running ? 'ok' : r.installed ? 'warn' : 'bad'}`;
    $('#rtssText').textContent = !r.installed
      ? 'RTSS isn\'t installed. It\'s free; SuperLay uses it to cap frame rates inside the game.'
      : `Version ${r.version}${r.running ? ', running.' : ' — installed but not running. Start RTSS for caps to take effect.'}`
        + (r.elevated || r.brokerReady ? ' Caps apply instantly.' : ' The first cap you apply this session asks for administrator permission once; after that they apply instantly.');
    const btns = r.installed ? '' : '<button class="btn" data-goto="components">Install RTSS in Components</button>';
    if ($('#rtssBtns').dataset.h !== btns) { $('#rtssBtns').innerHTML = btns; $('#rtssBtns').dataset.h = btns; }
    $('#limiterBody').style.display = r.installed ? '' : 'none';
    if (!r.installed) return;

    // game list: current game first, then known games
    const games = [];
    if (diag?.target && r.isCurrentGame !== undefined) {
      const cur = diag.target.exe ? diag.target.exe.split('\\').pop() : null;
      if (cur) games.push({ exe: cur, name: `${diag.target.name || cur} (running)` });
    }
    for (const g of r.games) if (!games.some((x) => x.exe.toLowerCase() === g.exe.toLowerCase())) games.push(g);
    if (!limiterExe) limiterExe = r.exe || games[0]?.exe || null;
    const opts = games.map((g) => `<option value="${esc(g.exe)}" ${g.exe === limiterExe ? 'selected' : ''}>${esc(g.name)} — ${esc(g.exe)}</option>`).join('')
      || '<option value="">No games yet</option>';
    if ($('#limGame').dataset.h !== opts) { $('#limGame').innerHTML = opts; $('#limGame').dataset.h = opts; }

    const p = r.profile;
    $('#capNow').innerHTML = !p ? '' : p.limit > 0
      ? `Current cap: <b>${+p.limit.toFixed(2)} fps</b> · ${MODE_NAMES[p.mode] || p.mode}${p.source === 'global' ? ' <span class="muted">(from RTSS global profile)</span>' : ''}`
      : `No cap set${p.source === 'global' ? ' (uses RTSS global profile)' : ''}.`;

    const rec = r.recommendation || {};
    $('#recCap').textContent = rec.cap ? rec.cap : '–';
    $('#recWhy').innerHTML = (rec.reasons || []).map((x) => `<li>${esc(x)}</li>`).join('')
      + (r.isCurrentGame ? '' : '<li>Run the game for a live recommendation based on its performance.</li>');

    if (!limiterDirty) {
      $('#capVal').value = p && p.limit > 0 ? +p.limit.toFixed(2) : (rec.cap || '');
      setMode(p && p.limit > 0 && MODE_HELP[p.mode] ? p.mode : S.limiter.defaultMode);
    }
  }

  async function applyCap(limit) {
    if (!limiterExe) return;
    const btn = limit === 0 ? $('#capRemove') : $('#capApply');
    const msg = $('#capMsg');
    msg.className = 'note'; msg.textContent = lastRtss?.elevated || lastRtss?.brokerReady ? 'Applying…' : 'Approve the Windows permission prompt (once per session)…';
    btn.disabled = true;
    try {
      const res = await api.rtssApply({ exe: limiterExe, limit, mode: limiterMode });
      msg.className = `note ${res.ok ? 'ok' : 'err'}`;
      msg.textContent = res.ok ? (limit === 0 ? `Cap removed for ${limiterExe}.` : `Capped ${limiterExe} at ${limit} fps (${MODE_NAMES[limiterMode]}).`) : res.message;
      if (res.ok) { limiterDirty = false; await loadLimiter(); }
    } finally { btn.disabled = false; }
  }
  $('#capApply').addEventListener('click', () => {
    const v = +$('#capVal').value;
    if (!(v >= 0) || v > 1000) { $('#capMsg').className = 'note err'; $('#capMsg').textContent = 'Enter a cap between 0 and 1000 fps.'; return; }
    applyCap(Math.round(v * 100) / 100);
  });
  $('#capRemove').addEventListener('click', () => applyCap(0));
  setInterval(() => { if (!document.hidden && $('.page[data-page="limiter"]').classList.contains('active')) loadLimiter(); }, 2000);

  // ---------------------------------------------------------------- OptiScaler
  let opti = null;
  const optiMsg = {};          // key -> { ok, text }
  const tail = (p) => p.split('\\').slice(-3).join('\\');
  const VENDOR_NOTE = {
    amd: 'Radeon detected: DLSS spoofing and Fakenvapi are included, so DLSS-only games can use FSR 4.',
    intel: 'Intel GPU detected: DLSS spoofing and Fakenvapi are included.',
    nvidia: 'NVIDIA GPU detected: Fakenvapi is left out, as OptiScaler recommends.',
  };

  function optiTags(g) {
    const t = [];
    if (g.busy) t.push(['busy', g.busy === 'remove' ? 'Removing' : 'Installing']);
    else if (g.state === 'installed') t.push(['ok', `OptiScaler v${g.version} · ${g.proxy}`]);
    else if (g.state === 'damaged') t.push(['bad', 'Damaged']);
    else if (g.state === 'manual') t.push(['', `Installed manually as ${g.proxy || 'OptiScaler.dll'}`]);
    else t.push(['', 'Not installed']);
    if (g.state === 'installed' && opti.package.version && g.version !== opti.package.version) t.push(['warn', `Update · v${opti.package.version}`]);
    if (g.antiCheat?.length) t.push(['bad', `Anti-cheat: ${g.antiCheat.join(', ')}`]);
    if (g.running) t.push(['warn', 'Running']);
    return t.map(([c, s]) => `<span class="tagc ${c}">${esc(s)}</span>`).join('');
  }

  function optiActs(g) {
    if (g.busy) return '';
    const dis = g.running ? 'disabled title="Close the game first"' : '';
    const b = (act, label, cls = '') => `<button class="btn ${cls}" data-ok="${g.key}" data-act="${act}" ${dis}>${label}</button>`;
    const out = [];
    if (g.state === 'none') {
      if (g.antiCheat?.length) out.push(b('install-anyway', 'Install anyway…', 'ghost danger'));
      else {
        out.push(`<select data-proxy="${g.key}" title="Filename OptiScaler loads as">${['auto', ...g.freeProxies].map((p) => `<option value="${p}">${p === 'auto' ? 'dxgi.dll (auto)' : p}</option>`).join('')}</select>`);
        out.push(b('install', 'Install'));
      }
    } else if (g.state === 'installed' || g.state === 'damaged') {
      if (g.state === 'damaged') out.push(b('update', 'Repair'));
      else if (opti.package.version && g.version !== opti.package.version) out.push(b('update', 'Update'));
      out.push(b('remove', 'Remove', 'ghost'));
    }
    out.push(`<button class="btn ghost" data-ok="${g.key}" data-act="folder">Open folder</button>`);
    return out.join('');
  }

  function renderOpti() {
    if (!opti) return;
    const p = opti.package;
    const pkgHtml = `
      <small>Package</small>
      <div class="v">${p.version ? `v${esc(p.version)}` : 'Not downloaded'}</div>
      <small>${p.busy ? 'Downloading…' : p.latest ? (p.updateAvailable ? `v${esc(p.latest)} available` : p.version ? 'Latest release' : `Latest: v${esc(p.latest)}`) : 'Latest version unknown'}</small>
      ${p.busy ? '' : (!p.version || p.updateAvailable) ? `<button class="btn" data-ok="" data-act="download">${p.version ? 'Download update' : 'Download (55 MB)'}</button>` : ''}
      <small>${esc(VENDOR_NOTE[opti.vendor] || '')}</small>`;
    if ($('#optiPkg').dataset.h !== pkgHtml) { $('#optiPkg').innerHTML = pkgHtml; $('#optiPkg').dataset.h = pkgHtml; }
    $('#optiRtss').hidden = !opti.rtssInstalled;

    const html = opti.games.length ? opti.games.map((g, i) => {
      const m = optiMsg[g.key];
      const note = g.state === 'damaged' ? `${g.missing} file${g.missing === 1 ? '' : 's'} missing. A game update or Steam's file check probably removed them.`
        : g.state === 'manual' ? 'Not managed by SuperLay; remove it the way it was installed.'
          : g.antiCheat?.length && g.state === 'none' ? 'Blocked: this game ships anti-cheat. Only continue if you play it offline.' : '';
      return `
      <div class="og" style="animation-delay:${i * 40}ms">
        ${g.thumb ? `<img src="${g.thumb}" alt="">` : '<div class="noimg"></div>'}
        <div>
          <h4>${esc(g.name)} ${optiTags(g)}</h4>
          <div class="meta" title="${esc(g.dir || '')}">${esc(g.dir ? `…\\${tail(g.dir)}` : '')}${g.takenProxies?.length ? ` · already using: ${esc(g.takenProxies.map((x) => x.name).join(', '))}` : ''}</div>
          ${note ? `<div class="meta">${esc(note)}</div>` : ''}
          ${m ? `<div class="${m.ok ? 'ok-msg' : 'err'}">${esc(m.text)}</div>` : ''}
        </div>
        <div class="acts">${optiActs(g)}</div>
      </div>`;
    }).join('') : '<p class="muted">No games yet. Launch a game once and it appears here.</p>';
    if ($('#optiGames').dataset.h !== html) { $('#optiGames').innerHTML = html; $('#optiGames').dataset.h = html; }
  }

  async function loadOpti(checkUpdates = false) {
    try { opti = await api.optiStatus({ checkUpdates }); renderOpti(); } catch { /* main busy */ }
  }

  $('.page[data-page="optiscaler"]').addEventListener('click', async (e) => {
    const u = e.target.closest('[data-url]');
    if (u) { api.openUrl(u.dataset.url); return; }
    const b = e.target.closest('button[data-act]');
    if (!b || b.dataset.ok === undefined) return;
    const key = b.dataset.ok, act = b.dataset.act;
    const g = opti?.games.find((x) => x.key === key);
    let action = act, opts = {};
    if (act === 'install') opts.proxy = $(`select[data-proxy="${key}"]`)?.value || 'auto';
    if (act === 'install-anyway') {
      const ok = confirm(`${g.name} ships anti-cheat (${g.antiCheat.join(', ')}).\n\nUsing OptiScaler in an online game can get your account banned. Only continue if you play this game offline.\n\nInstall OptiScaler anyway?`);
      if (!ok) return;
      action = 'install'; opts = { allowAntiCheat: true };
    }
    if (act === 'remove' && !confirm(`Remove OptiScaler from ${g.name}? Game files it replaced will be restored.`)) return;
    b.disabled = true;
    if (g) { g.busy = action; delete optiMsg[key]; renderOpti(); }
    const res = await api.optiAct(key || null, action, opts);
    if (key && act !== 'folder') {
      optiMsg[key] = res.ok
        ? { ok: true, text: action === 'remove' ? `Removed${res.kept?.length ? `; kept ${res.kept.join(', ')} because the game has changed ${res.kept.length > 1 ? 'them' : 'it'} since` : ''}.` : `Installed v${res.version} as ${res.proxy}${res.replaced?.length ? `; backed up ${res.replaced.length} game file${res.replaced.length > 1 ? 's' : ''}` : ''}. In game, press Insert to choose the upscaler.` }
        : { ok: false, text: res.message };
    } else if (!res.ok) alert(res.message);
    loadOpti(false);
  });
  api.on('opti:changed', () => loadOpti(false));
  setInterval(() => { if (!document.hidden && $('.page[data-page="optiscaler"]').classList.contains('active')) loadOpti(false); }, 4000);

  // ---------------------------------------------------------------- general
  const bl = $('#blocklist');
  bl.addEventListener('input', debounce(() => set('blocklist', bl.value.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean)), 400));
  $('#openData').addEventListener('click', () => api.openData());
  $('#resetAll').addEventListener('click', async () => { if (confirm('Reset every SuperLay setting to its default?')) { S = await api.resetSettings(); refreshAll(); } });

  // ---------------------------------------------------------------- diagnostics + live status
  $('#pmBrowse').addEventListener('click', () => api.browsePresentMon());
  $('#pmRestart').addEventListener('click', () => api.restartPresentMon());
  $('#relaunch').addEventListener('click', () => api.relaunchAdmin());
  $('#pmBtns').addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'install') runComponent('presentmon', 'install');
    if (a === 'admin') api.relaunchAdmin();
    if (a === 'restart') api.restartPresentMon();
  });

  // any [data-goto] button jumps to that page
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) $(`#nav [data-page="${g.dataset.goto}"]`).click();
  });

  // ---------------------------------------------------------------- components
  const COMP_GLYPH = { presentmon: 'PM', rtss: 'RT', optiscaler: 'OS' };
  const ACTION_LABEL = { install: 'Install', update: 'Update', start: 'Start RTSS', page: 'Open download page' };
  let comps = [];
  let compChecking = false;

  function compTags(c) {
    const t = [];
    if (c.busy) t.push(['busy', c.busy === 'updating' ? 'Updating' : c.busy === 'installing' ? 'Installing' : 'Working']);
    else if (!c.installed) t.push([c.required ? 'bad' : '', c.required ? 'Required · not installed' : 'Not installed']);
    else {
      t.push(['ok', `${c.id === 'optiscaler' ? 'Downloaded' : 'Installed'}${c.version ? ` · v${c.version}` : ''}`]);
      if (c.id === 'optiscaler') t.push([c.inUse ? 'ok' : '', c.inUse ? `In ${c.inUse} game${c.inUse > 1 ? 's' : ''}` : 'Not in any game yet']);
      if (c.id === 'presentmon') t.push(c.running ? ['ok', 'Capturing'] : c.state === 'denied' ? ['bad', 'Needs permission'] : ['warn', c.state]);
      if (c.id === 'rtss') t.push(c.running ? ['ok', 'Running'] : ['warn', 'Not running']);
      if (c.updateAvailable) t.push(['warn', `Update · v${c.latest}`]);
      else if (c.latest) t.push(['', 'Up to date']);
    }
    return t.map(([cls, txt]) => `<span class="tagc ${cls}">${esc(txt)}</span>`).join('');
  }

  function compActions(c) {
    const a = [];
    if (!c.installed) a.push(c.canInstall ? ['install', ''] : ['page', '']);
    if (c.installed && c.updateAvailable && c.canInstall) a.push(['update', '']);
    if (c.id === 'rtss' && c.installed && !c.running) a.push(['start', c.updateAvailable ? 'ghost' : '']);
    if (c.id === 'rtss' && !c.installed && c.canInstall) a.push(['page', 'ghost']);
    const btns = a.map(([act, cls]) => `<button class="btn ${cls}" data-comp="${c.id}" data-act="${act}" ${c.busy ? 'disabled' : ''}>${ACTION_LABEL[act]}</button>`).join('');
    return btns + (c.manage ? '<button class="btn ghost" data-goto="optiscaler">Manage per game</button>' : '');
  }

  function renderComps() {
    const html = comps.map((c, i) => `
      <div class="comp ${c.installed ? '' : 'missing'}" style="animation-delay:${i * 50}ms">
        <div class="glyph">${COMP_GLYPH[c.id] || '•'}</div>
        <div>
          <h3>${esc(c.name)} ${compTags(c)}</h3>
          <div class="by">${esc(c.by)}${c.required ? ' · required' : ' · optional'}</div>
          <p class="role">${esc(c.role)}</p>
          <p class="src" ${c.path ? `title="${esc(c.path)}"` : ''}>${esc(c.source)}</p>
          ${c.error ? `<p class="err">${esc(c.error)}</p>` : ''}
          ${c.id === 'presentmon' && c.state === 'denied' ? '<p class="err">Capture needs administrator rights or the Performance Log Users group. Diagnostics → Relaunch as administrator.</p>' : ''}
        </div>
        <div class="acts">${compActions(c)}</div>
      </div>`).join('');
    // keep running animations: only touch the DOM when something changed
    if ($('#comps').dataset.h !== html) { $('#comps').innerHTML = html; $('#comps').dataset.h = html; }
    const missingRequired = comps.some((c) => c.required && !c.installed);
    const attention = missingRequired || comps.some((c) => c.updateAvailable);
    $('#compBadge').hidden = !attention;
    $('#compBadge').classList.toggle('bad', missingRequired);
  }

  async function loadComps(checkUpdates = false) {
    if (checkUpdates) { compChecking = true; $('#compCheck').disabled = true; $('#compCheck').textContent = 'Checking…'; }
    try { comps = await api.componentsStatus({ checkUpdates }); renderComps(); } finally {
      if (checkUpdates) { compChecking = false; $('#compCheck').disabled = false; $('#compCheck').textContent = 'Check for updates'; }
    }
  }

  async function runComponent(id, act) {
    const c = comps.find((x) => x.id === id);
    if (c) { c.busy = act === 'update' ? 'updating' : act === 'install' ? 'installing' : 'working'; c.error = null; renderComps(); }
    const res = await api.componentAct(id, act);
    await loadComps(false);
    if (!res.ok && c) { const cur = comps.find((x) => x.id === id); if (cur) { cur.error = res.message; renderComps(); } }
    refreshDiag();
  }

  $('#comps').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-comp]');
    if (b) runComponent(b.dataset.comp, b.dataset.act);
  });
  $('#compCheck').addEventListener('click', () => loadComps(true));
  api.on('components:changed', () => loadComps(false));
  setInterval(() => { if (!document.hidden && !compChecking && $('.page[data-page="components"]').classList.contains('active')) loadComps(false); }, 3000);

  const fmt = {
    n: (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–'),
    gb: (b) => (b ? `${(b / 1073741824).toFixed(1)} GB` : '–'),
  };
  const SRC = { 'frame-type': 'measured (frame type)', pcl: 'Reflex/PCL timing', cadence: 'estimated (GPU cadence)', manual: 'manual multiplier', lossless: 'Lossless Scaling', none: '—' };
  const PM_TEXT = {
    running: ['ok', 'Capturing displayed frames with PresentMon.'],
    starting: ['warn', 'Starting PresentMon…'],
    missing: ['bad', 'PresentMon isn\'t installed. SuperLay uses Intel\'s open-source PresentMon to see every displayed frame, including generated ones. It\'s a one-click install.'],
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
    const btns = pmS.state === 'missing' ? [['install', 'Install PresentMon', '']]
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
  loadComps(false);
  setInterval(() => { if (!document.hidden) refreshDiag(); }, 1000);
  window.addEventListener('resize', () => $$('.seg').forEach(placeThumb));
})();
