'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const panel = $('panel');
  const api = window.superlay;           // absent when embedded as the settings preview
  const embedded = !api;

  let cfg = null;
  let reduceMotion = false;

  // ------------------------------------------------------------ smooth numbers
  // Each displayed number eases toward its latest target (frame-rate independent exponential smoothing).
  const tweens = new Map();
  function tween(id, target, { digits = 0, tau = 170, fmt } = {}) {
    let tw = tweens.get(id);
    if (!tw) { tw = { el: $(id), v: target, target, digits, tau, fmt, shown: null }; tweens.set(id, tw); }
    tw.target = target; tw.digits = digits; tw.tau = tau; tw.fmt = fmt;
    if (!Number.isFinite(tw.v)) tw.v = target;
  }
  function stepTweens(dt) {
    for (const tw of tweens.values()) {
      if (!Number.isFinite(tw.target)) { if (tw.shown !== '–') { tw.el.textContent = '–'; tw.shown = '–'; } continue; }
      const k = reduceMotion ? 1 : 1 - Math.exp(-dt / tw.tau);
      tw.v += (tw.target - tw.v) * k;
      if (Math.abs(tw.target - tw.v) < 0.5 * 10 ** -tw.digits) tw.v = tw.target;
      const s = tw.fmt ? tw.fmt(tw.v) : tw.v.toFixed(tw.digits);
      if (s !== tw.shown) { tw.el.textContent = s; tw.shown = s; }
    }
  }

  // ------------------------------------------------------------ frametime graph
  const canvas = $('graph');
  const ctx = canvas.getContext('2d');
  const samples = [];                    // [t(ms, PresentMon clock), frametime]
  let clockOffset = null;                // PresentMon time - performance.now()
  let targetOffset = null;
  let yMax = 20;
  let capLimit = 0;
  let colors = {};
  let colorAge = 1e9;

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    colors = { accent: g('--accent'), accent2: g('--accent2'), warn: g('--warn'), bad: g('--bad'), line: g('--line'), muted: g('--muted') };
  }

  function pushFrames(frames, now) {
    if (!frames || !frames.length) return;
    for (const f of frames) samples.push(f);
    const latest = now ?? frames[frames.length - 1][0];
    targetOffset = latest - performance.now();
    if (clockOffset === null || Math.abs(targetOffset - clockOffset) > 1500) clockOffset = targetOffset;
    const keep = latest - ((cfg?.stats?.graphSeconds || 5) * 1000 + 1500);
    let i = 0;
    while (i < samples.length && samples[i][0] < keep) i++;
    if (i) samples.splice(0, i);
  }

  function drawGraph(dt) {
    if (canvas.offsetParent === null) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (colorAge > 120) { readColors(); colorAge = 0; }
    colorAge += dt;
    if (clockOffset === null || samples.length < 2) return;

    // Drift the clock toward the latest data so scrolling stays continuous between updates.
    clockOffset += (targetOffset - clockOffset) * (1 - Math.exp(-dt / 600));
    const span = (cfg?.stats?.graphSeconds || 5) * 1000;
    const delay = (cfg?.overlay?.updateMs || 250) * 1.6;
    const tNow = performance.now() + clockOffset - delay;
    const t0 = tNow - span;

    let maxV = 0, sum = 0, n = 0;
    for (const [t, v] of samples) if (t >= t0 && t <= tNow) { if (v > maxV) maxV = v; sum += v; n++; }
    if (!n) return;
    const avg = sum / n;
    const capMs = capLimit > 0 && cfg?.limiter?.showTargetLine !== false ? 1000 / capLimit : 0;
    const want = Math.max(avg * 2.2, maxV * 1.15, capMs * 1.6, 4);
    yMax += (want - yMax) * (1 - Math.exp(-dt / 400));

    const X = (t) => ((t - t0) / span) * w;
    const Y = (v) => h - 2 - (Math.min(v, yMax) / yMax) * (h - 4);

    // average guide
    ctx.strokeStyle = colors.line;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(0, Y(avg)); ctx.lineTo(w, Y(avg)); ctx.stroke();
    ctx.setLineDash([]);

    // frame-rate cap target: with good pacing the line sits right on it
    if (capMs) {
      ctx.strokeStyle = colors.accent2;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(0, Y(capMs)); ctx.lineTo(w, Y(capMs)); ctx.stroke();
      ctx.setLineDash([]);
    }

    // area + line
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, colors.accent);
    grad.addColorStop(1, 'transparent');
    ctx.beginPath();
    let first = true, lastX = 0;
    for (const [t, v] of samples) {
      if (t < t0 - 200 || t > tNow) continue;
      const x = X(t), y = Y(v);
      if (first) { ctx.moveTo(x, h); ctx.lineTo(x, y); first = false; } else ctx.lineTo(x, y);
      lastX = x;
    }
    ctx.lineTo(lastX, h);
    ctx.closePath();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    const lg = ctx.createLinearGradient(0, 0, w, 0);
    lg.addColorStop(0, colors.accent2);
    lg.addColorStop(1, colors.accent);
    ctx.strokeStyle = lg;
    ctx.beginPath();
    first = true;
    for (const [t, v] of samples) {
      if (t < t0 - 200 || t > tNow) continue;
      const x = X(t), y = Y(v);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // stutter markers: frames over 2× the average
    for (const [t, v] of samples) {
      if (t < t0 || t > tNow || v < avg * 2 || v < 8) continue;
      ctx.fillStyle = v > avg * 3.5 ? colors.bad : colors.warn;
      ctx.beginPath(); ctx.arc(X(t), Y(v), 1.8, 0, Math.PI * 2); ctx.fill();
    }

    // fade the left edge so samples slide in/out instead of popping
    ctx.globalCompositeOperation = 'destination-out';
    const fade = ctx.createLinearGradient(0, 0, 18, 0);
    fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, 18, h);
    ctx.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------ config
  let coverFlip = false, lastCover = null, lastName = '';
  function applyConfig(c) {
    cfg = c;
    const O = c.overlay, M = c.metrics, T = c.theme;
    reduceMotion = !!T.reduceMotion;
    root.className = `layout-${O.layout} pos-${O.position}${O.coverBackdrop ? '' : ' no-backdrop'}${reduceMotion ? ' reduce-motion' : ''}${state.visible ? ' shown' : ''}`;
    const rs = document.documentElement.style;
    rs.setProperty('--theme-ms', `${T.transitionMs}ms`);
    rs.setProperty('--panel-alpha', String(O.opacity));
    rs.setProperty('--radius', `${O.radius}px`);
    root.style.zoom = String(O.scale);

    for (const [k, v] of Object.entries(c.palette || {})) {
      if (typeof v === 'string' && v.startsWith('#')) rs.setProperty(`--${k}`, v);
    }
    colorAge = 1e9;

    document.querySelectorAll('[data-m]').forEach((el) => {
      const key = el.dataset.m;
      const on = key === 'gameName' ? O.showGameName && O.layout === 'card' : M[key] !== false;
      el.classList.toggle('m-off', !on);
    });

    if (c.cover !== lastCover) {
      lastCover = c.cover;
      const [a, b] = coverFlip ? [$('coverA'), $('coverB')] : [$('coverB'), $('coverA')];
      coverFlip = !coverFlip;
      if (c.cover) { a.src = c.cover; a.onload = () => { a.classList.add('on'); b.classList.remove('on'); }; } else { a.classList.remove('on'); b.classList.remove('on'); }
    }
    const name = c.gameName || (embedded ? 'Preview' : '');
    if (name !== lastName) {
      lastName = name;
      const el = $('gameName');
      el.textContent = name;
      el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap');
    }
    if (c.demo || embedded) startDemo(); else stopDemo();
    setNowPlaying(lastMedia);
    queueMeasure();
  }

  // ------------------------------------------------------------ frame data
  const state = { visible: embedded };
  const fmtGB = (b) => (b / 1073741824);
  function setLevel(el, level) { el.classList.toggle('warn', level === 1); el.classList.toggle('bad', level === 2); }
  const SRC = { 'frame-type': 'measured', pcl: 'reflex timing', cadence: 'estimated', manual: 'manual', lossless: 'lossless scaling' };

  function applyFrame(f) {
    const fps = f.fps;
    const S = cfg?.framegen || {};
    if (fps) {
      tween('fps', fps.displayedFps, { tau: 220 });
      tween('ft', fps.frametimeMs, { digits: 1, tau: 220 });
      tween('low1', fps.low1Fps, { tau: 400 });
      tween('lat', fps.latencyMs ?? NaN, { digits: 1, tau: 300 });
      tween('pacing', fps.pacingMs ?? NaN, { digits: 2, tau: 500 });
      setLevel($('pacing').parentElement, fps.pacingMs > 4 ? 2 : fps.pacingMs > 1.5 ? 1 : 0);
      const lowStat = $('low1').parentElement;
      setLevel(lowStat, fps.low1Fps && fps.displayedFps && fps.low1Fps < fps.displayedFps * 0.5 ? 1 : 0);

      const fg = fps.fg || {};
      $('fgChip').hidden = !fg.active;
      $('fpsSub').hidden = !fg.active;
      if (fg.active) {
        $('fgMult').textContent = `${Number.isInteger(fg.multiplier) ? fg.multiplier : fg.multiplier.toFixed(1)}×`;
        tween('rendered', fps.renderedFps, { tau: 260 });
        $('fgSrc').textContent = S.showSource === false ? '' : (SRC[fg.source] || '');
      }
      const fgName = fg.active ? fg.name : (fg.available ? `${fg.available} · off` : null);
      $('fgNameChip').hidden = !fgName || cfg?.overlay?.layout !== 'card';
      if (fgName) $('fgNameChip').textContent = fgName;
      pushFrames(fps.frames, fps.now);
      $('live').classList.remove('off');
    } else {
      tween('fps', NaN); tween('ft', NaN); tween('low1', NaN); tween('lat', NaN); tween('pacing', NaN);
      $('fgChip').hidden = true; $('fpsSub').hidden = true; $('fgNameChip').hidden = true;
      $('live').classList.add('off');
    }

    const g = f.gpu || {};
    tween('gpu', g.load ?? NaN, { tau: 300 });
    $('gpuBar').style.width = `${g.load || 0}%`;
    tween('gpuTemp', g.temp ?? NaN, { tau: 600 });
    setLevel($('gpuTemp').parentElement, g.temp >= 90 ? 2 : g.temp >= 80 ? 1 : 0);
    tween('gpuClock', g.clock ?? NaN, { tau: 300 });
    if (g.vramTotal) {
      const used = fmtGB(g.vramUsed), total = fmtGB(g.vramTotal);
      tween('vram', used, { digits: 1, tau: 500 });
      $('vramUnit').textContent = cfg?.overlay?.layout === 'card' ? `/ ${Math.round(total)} GB` : 'GB';
      $('vramBar').style.width = `${(used / total) * 100}%`;
      setLevel($('vram').parentElement, used / total > 0.95 ? 2 : used / total > 0.88 ? 1 : 0);
    } else tween('vram', NaN);
    tween('cpu', f.cpu ?? NaN, { tau: 300 });
    $('cpuBar').style.width = `${f.cpu || 0}%`;
    if (f.ram) {
      tween('ram', fmtGB(f.ram.used), { digits: 1, tau: 500 });
      $('ramBar').style.width = `${(f.ram.used / f.ram.total) * 100}%`;
    }
    const now = new Date();
    $('clock').textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const lim = f.limiter;
    // Driver FG (AFMF) multiplies frames after RTSS's cap; the graph shows displayed frames.
    const driverFg = fps?.fg?.active && fps.fg.source === 'frame-type';
    capLimit = lim ? lim.limit * (driverFg ? fps.fg.multiplier : 1) : 0;
    $('capChip').hidden = !lim;
    if (lim) $('capChip').textContent = `CAP ${+lim.limit.toFixed(2)}${{ 'front-edge': ' · FES', 'back-edge': ' · BES' }[lim.mode] || ''}`;

    const up = f.upscaler;
    $('upChip').hidden = !up;
    if (up) {
      // With OptiScaler the game's upscaler is only the input; the real output is chosen in Opti's menu.
      $('upLabel').textContent = up.opti ? `${up.label} → Opti` : up.label;
      $('upModel').textContent = up.model ? `· ${up.model.split(' (')[0]}` : '';
      $('upChip').classList.toggle('installed', up.confidence !== 'active');
      $('upChip').title = up.confidence === 'active' ? 'Loaded by the game' : 'Shipped with the game; could not confirm it is active';
    }
    queueMeasure();
  }

  // ------------------------------------------------------------ music: toast + now-playing chip
  const ICONS = { next: '⏭', prev: '⏮', play: '▶', pause: '⏸', none: '♪' };
  let toastTimer = null, unmountTimer = null;
  function showToast(m) {
    const t = $('toast');
    const icon = m.toast === 'next' ? ICONS.next : m.toast === 'prev' ? ICONS.prev : m.playing ? ICONS.play : m.active ? ICONS.pause : ICONS.none;
    $('tIcon').textContent = icon;
    if (m.active && m.title) {
      $('tTitle').textContent = m.title;
      $('tSub').textContent = [m.artist, m.app].filter(Boolean).join(' · ');
    } else {
      $('tTitle').textContent = m.fallback ? 'Media key sent' : 'Nothing playing';
      $('tSub').textContent = m.fallback ? 'No player reported a track' : 'Start music in any player';
    }
    clearTimeout(toastTimer); clearTimeout(unmountTimer);
    t.classList.add('mounted');
    void t.offsetWidth;                       // commit display before animating in
    t.classList.add('show');
    queueMeasure();
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      unmountTimer = setTimeout(() => { t.classList.remove('mounted'); queueMeasure(); }, 320);
    }, 2600);
  }

  function setNowPlaying(m) {
    const chip = $('npChip');
    const on = !!(cfg?.media?.showNowPlaying && m?.active && m.title);
    chip.hidden = !on;
    if (on) {
      $('npText').textContent = m.artist ? `${m.title} — ${m.artist}` : m.title;
      chip.classList.toggle('paused', !m.playing);
      chip.title = m.app ? `Playing in ${m.app}` : '';
    }
    queueMeasure();
  }

  let lastMedia = null;
  function onMedia(m) {
    if (!m) return;
    lastMedia = m;
    setNowPlaying(m);
    if (m.toast) showToast(m);
  }

  function setVisible(v) {
    state.visible = v;
    root.classList.toggle('shown', v);
  }

  // ------------------------------------------------------------ window sizing
  // The window grows immediately and shrinks only once the layout has settled, so animations never clip.
  let measureQueued = false, shrinkTimer = null, reported = { w: 0, h: 0 };
  // Embedded preview: shrink to fit the stage instead of clipping.
  let fitQueued = false;
  function fitPreview() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      const scale = +(cfg?.overlay?.scale || 1);
      root.style.zoom = String(scale);
      const r = root.getBoundingClientRect();
      const fit = Math.min(1, (window.innerWidth - 8) / r.width, (window.innerHeight - 8) / r.height);
      if (fit < 1) root.style.zoom = String(scale * fit);
    });
  }
  function queueMeasure() {
    if (embedded) { fitPreview(); return; }
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => {
      measureQueued = false;
      const r = root.getBoundingClientRect();
      const w = Math.ceil(r.width), h = Math.ceil(r.height);
      if (w > reported.w || h > reported.h) {
        reported = { w: Math.max(w, reported.w), h: Math.max(h, reported.h) };
        api.reportSize(reported.w + 8, reported.h + 8);
      }
      if (w < reported.w - 4 || h < reported.h - 4) {
        clearTimeout(shrinkTimer);
        shrinkTimer = setTimeout(() => {
          const r2 = root.getBoundingClientRect();
          reported = { w: Math.ceil(r2.width), h: Math.ceil(r2.height) };
          api.reportSize(reported.w + 8, reported.h + 8);
        }, 900);
      }
    });
  }
  new ResizeObserver(queueMeasure).observe(panel);

  // ------------------------------------------------------------ demo data (settings preview)
  let demoTimer = null, demoT = 0;
  function resetGraph() { samples.length = 0; clockOffset = null; targetOffset = null; }
  function startDemo() {
    if (demoTimer) return;
    resetGraph();
    let base = 118;
    demoTimer = setInterval(() => {
      const dt = cfg?.overlay?.updateMs || 250;
      base += (Math.random() - 0.5) * 6; base = Math.max(110, Math.min(120, base)); // demo runs against a 120 fps cap
      const mult = cfg?.framegen?.inGameMultiplier === 'off' ? 1 : (+cfg?.framegen?.inGameMultiplier || 2);
      const disp = base * mult;
      const frames = [];
      const ft = 1000 / disp;
      for (let t = 0; t < dt; t += ft) {
        demoT += ft;
        let v = ft * (0.9 + Math.random() * 0.2);
        if (Math.random() < 0.004) v *= 3 + Math.random() * 2;
        frames.push([demoT, v]);
      }
      applyFrame({
        fps: {
          displayedFps: disp, renderedFps: base, frametimeMs: ft, low1Fps: disp * 0.78, latencyMs: 24 + Math.random() * 4, pacingMs: 0.4 + Math.random() * 0.2,
          fg: { active: mult > 1, multiplier: mult, source: 'frame-type', name: 'AFMF 2' }, frames, now: demoT,
        },
        gpu: { load: 94 + Math.random() * 5, temp: 64 + Math.random() * 2, clock: 2950 + Math.random() * 60, vramUsed: 9.4e9, vramTotal: 17.1e9 },
        cpu: 38 + Math.random() * 10,
        ram: { used: 18.2e9, total: 34.2e9 },
        upscaler: { label: 'FSR 4', model: 'ML upscaler (driver)', confidence: 'active' },
        limiter: { limit: 120, mode: 'front-edge' },
      });
    }, cfg?.overlay?.updateMs || 250);
  }
  function stopDemo() { if (!demoTimer) return; clearInterval(demoTimer); demoTimer = null; resetGraph(); }

  // ------------------------------------------------------------ wiring
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(100, now - last);
    last = now;
    stepTweens(dt);
    if (state.visible) drawGraph(dt);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  if (api) {
    api.onConfig(applyConfig);
    api.onFrame(applyFrame);
    api.onVisible(setVisible);
    api.onMedia(onMedia);
  } else {
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent || !e.data) return;
      if (e.data.type === 'config') { applyConfig(e.data.config); setVisible(true); }
    });
    setVisible(true);
    window.addEventListener('resize', fitPreview);
  }
})();
