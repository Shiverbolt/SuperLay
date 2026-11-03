'use strict';
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const SESSION = 'SuperLay';
// Flags that only newer PresentMon builds understand. If the process rejects them we restart without.
const OPTIONAL_FLAGS = ['--no_console_stats', '--track_frame_type', '--track_pc_latency'];
const KEEP_MS = 15000;

// FrameType values that are real, app-rendered frames. Everything else that is displayed
// (AMD_AFMF, Intel_XEFG, future driver/app generators) counts as generated.
const APP_TYPES = new Set(['', 'na', 'notset', 'unspecified', 'application']);

function num(v) {
  if (v === undefined || v === '' || v === 'NA') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

class PresentMon extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.cols = null;
    this.chains = new Map();     // `${pid}:${swapchain}` -> { pid, app, rows: [] }
    this.now = 0;                // newest CPUStartTime seen (ms), the clock every window is measured against
    this.status = { state: 'stopped', message: '', exe: '' };
    this.useOptional = true;
    this.cadence = new Map();    // pid -> { votes: [], multiplier }
    this.graphCursor = new Map();
    this.fgHold = new Map();     // pid -> last FG-on decision, for hysteresis
  }

  static locate(configured, roots) {
    if (configured && fs.existsSync(configured)) return configured;
    for (const root of roots) {
      try {
        const hit = fs.readdirSync(root).filter((f) => /^presentmon.*\.exe$/i.test(f)).sort().pop();
        if (hit) return path.join(root, hit);
      } catch { /* missing dir */ }
    }
    return null;
  }

  start(exe, extraArgs = '') {
    this.stop(false);
    if (!exe) return this.setStatus('missing', 'PresentMon not found. Download it from Settings → Diagnostics.');
    this.exe = exe;
    this.extraArgs = extraArgs;
    const args = ['--output_stdout', '--stop_existing_session', '--session_name', SESSION];
    if (this.useOptional) args.push(...OPTIONAL_FLAGS);
    if (extraArgs.trim()) args.push(...extraArgs.trim().split(/\s+/));

    this.cols = null;
    this.startedAt = Date.now();
    let stderr = '';
    const proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.setStatus('starting', '', exe);

    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    proc.on('error', (e) => this.setStatus('error', e.message));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      const quick = Date.now() - this.startedAt < 5000;
      const msg = (stderr || '').trim().split(/\r?\n/).slice(-3).join(' ');
      if (quick && this.useOptional && !this.cols) {
        // Older build rejected an optional flag: retry plain.
        this.useOptional = false;
        return this.start(this.exe, this.extraArgs);
      }
      if (/access|denied|privilege|elevat|administrator/i.test(msg) || code === 5) {
        return this.setStatus('denied', 'PresentMon needs administrator rights or membership in "Performance Log Users" (sign out and back in after adding).');
      }
      this.setStatus('error', `PresentMon exited (${code}). ${msg}`);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.start(this.exe, this.extraArgs), 4000);
    });
  }

  stop(endSession = true) {
    clearTimeout(this.retry);
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill(); } catch { /* already gone */ }
    }
    // Killing PresentMon leaves its ETW session alive; close it explicitly.
    if (endSession) {
      try { spawnSync('logman', ['stop', SESSION, '-ets'], { windowsHide: true, timeout: 3000 }); } catch { /* not running */ }
    }
    this.setStatus('stopped', '');
  }

  setStatus(state, message, exe) {
    this.status = { state, message, exe: exe || this.status.exe, frameTypeTracking: this.useOptional };
    this.emit('status', this.status);
  }

  onLine(line) {
    if (!this.cols) {
      if (!/application/i.test(line) || !/processid/i.test(line)) return; // banner text before the header
      const names = line.split(',').map((s) => s.trim().toLowerCase());
      const idx = (...cands) => { for (const c of cands) { const i = names.indexOf(c.toLowerCase()); if (i >= 0) return i; } return -1; };
      this.cols = {
        app: idx('Application'),
        pid: idx('ProcessID'),
        chain: idx('SwapChainAddress'),
        runtime: idx('PresentRuntime', 'Runtime'),
        mode: idx('PresentMode'),
        type: idx('FrameType'),
        // 2.6+ uses TimeInMs / CPUStartTimeInMs, 2.0–2.5 CPUStartTime, 1.x TimeInSeconds.
        time: idx('TimeInMs', 'CPUStartTimeInMs', 'CPUStartTime', 'TimeInSeconds'),
        timeIsSeconds: idx('TimeInMs', 'CPUStartTimeInMs', 'CPUStartTime') < 0,
        between: idx('MsBetweenPresents', 'msBetweenPresents'),
        display: idx('MsBetweenDisplayChange', 'msBetweenDisplayChange'),
        sim: idx('MsBetweenSimulationStart'),
        gpuBusy: idx('MsGPUBusy', 'msGPUActive'),
        pcl: idx('MsPCLatency'),
        input: idx('MsAllInputToPhotonLatency', 'MsClickToPhotonLatency'),
        dropped: idx('Dropped'),
      };
      if (this.cols.time < 0 || this.cols.pid < 0) {
        this.setStatus('error', `Unrecognised PresentMon CSV format: ${line.slice(0, 160)}`);
        this.cols = null;
        return;
      }
      this.setStatus('running', '');
      return;
    }
    const c = this.cols;
    const f = line.split(',');
    const pid = +f[c.pid];
    if (!pid) return;
    let t = num(f[c.time]);
    if (t === null) return;
    if (c.timeIsSeconds) t *= 1000;
    if (t > this.now) this.now = t;

    const key = `${pid}:${c.chain >= 0 ? f[c.chain] : ''}`;
    let ch = this.chains.get(key);
    if (!ch) {
      ch = { pid, app: f[c.app], rows: [], runtime: '', mode: '' };
      this.chains.set(key, ch);
    }
    ch.runtime = c.runtime >= 0 ? f[c.runtime] : '';
    ch.mode = c.mode >= 0 ? f[c.mode] : '';
    const type = c.type >= 0 ? (f[c.type] || '').trim() : '';
    let display = c.display >= 0 ? num(f[c.display]) : null;
    if (c.dropped >= 0 && f[c.dropped] === '1') display = null;
    ch.rows.push({
      t,
      between: num(f[c.between]),
      display,
      type,
      sim: c.sim >= 0 ? num(f[c.sim]) : null,
      gpu: c.gpuBusy >= 0 ? num(f[c.gpuBusy]) : null,
      lat: (c.pcl >= 0 ? num(f[c.pcl]) : null) ?? (c.input >= 0 ? num(f[c.input]) : null),
    });
    if (ch.rows.length > 4000 && ch.rows[0].t < this.now - KEEP_MS) this.trim(ch);
  }

  trim(ch) {
    const cut = this.now - KEEP_MS;
    let i = 0;
    while (i < ch.rows.length && ch.rows[i].t < cut) i++;
    if (i) ch.rows.splice(0, i);
  }

  housekeeping() {
    for (const [k, ch] of this.chains) {
      this.trim(ch);
      if (!ch.rows.length) this.chains.delete(k);
    }
  }

  /** Processes that presented in the last `ms` milliseconds, with their present rate. */
  activeProcesses(ms = 1500) {
    const out = new Map();
    for (const ch of this.chains.values()) {
      let n = 0;
      for (let i = ch.rows.length - 1; i >= 0 && ch.rows[i].t > this.now - ms; i--) n++;
      if (!n) continue;
      const prev = out.get(ch.pid);
      const rate = (n * 1000) / ms;
      if (!prev || rate > prev.rate) out.set(ch.pid, { pid: ch.pid, app: ch.app, rate });
    }
    return out;
  }

  mainChain(pid) {
    let best = null; let bestN = -1;
    for (const ch of this.chains.values()) {
      if (ch.pid !== pid) continue;
      let n = 0;
      for (let i = ch.rows.length - 1; i >= 0 && ch.rows[i].t > this.now - 2000; i--) n++;
      if (n > bestN) { best = ch; bestN = n; }
    }
    return best;
  }

  /**
   * Frame statistics for one process.
   * fgHint: { library: 'DLSS FG'|..., loaded: bool } from module detection.
   * multiplierSetting: 'auto' | 'off' | '2' | '3' | '4'
   */
  stats(pid, { fpsWindowMs = 1000, lowWindowSec = 10, fgHint = null, multiplierSetting = 'auto', frametimeSource = 'present' } = {}) {
    const ch = this.mainChain(pid);
    if (!ch || !ch.rows.length) return null;
    const rows = ch.rows;
    const now = this.now;
    const from = now - fpsWindowMs;

    let dispN = 0, dispMs = 0, genN = 0, repeatN = 0, presN = 0, presMs = 0;
    let latSum = 0, latN = 0;
    const gpu = [];
    const genTypes = new Set();
    let anyDisplay = false, anyType = false;

    // Reflex/PCL simulation intervals can be sparse (OptiScaler's Fakenvapi: ~3 per second), so look back 3 s
    // and use the median: one 1 s window often held too few samples and FG blinked off.
    const sims = [];
    for (let i = rows.length - 1; i >= 0 && rows[i].t > now - Math.max(3000, fpsWindowMs); i--) {
      const s = rows[i].sim;
      if (s !== null && s > 0) sims.push(s);
    }

    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.t <= from) break;
      const typeKey = r.type.toLowerCase();
      if (r.type && typeKey !== 'na') anyType = true;
      const generated = !APP_TYPES.has(typeKey) && typeKey !== 'repeated';
      if (r.display !== null && r.display > 0) {
        anyDisplay = true;
        dispMs += r.display;
        if (typeKey === 'repeated') repeatN++;
        else {
          dispN++;
          if (generated) { genN++; genTypes.add(r.type); }
        }
      }
      if (!generated && r.between !== null && r.between > 0) { presN++; presMs += r.between; }
      if (r.lat !== null && r.lat > 0) { latSum += r.lat; latN++; }
      // 0 ms GPU busy is meaningful: untagged generated frames often show exactly that.
      if (r.gpu !== null && r.gpu >= 0 && !generated) gpu.push(r.gpu);
    }

    const presentFps = presMs > 0 ? (presN * 1000) / presMs : 0;
    const displayedFps = anyDisplay && dispMs > 0 ? (dispN * 1000) / dispMs : presentFps;

    // ---- rendered (real) frame rate, strongest evidence first ----
    let renderedFps = displayedFps, source = 'none', multiplier = 1, fgName = null;
    if (genN > 0) {
      renderedFps = displayedFps * (1 - genN / dispN);
      multiplier = dispN / Math.max(1, dispN - genN);
      source = 'frame-type';
      fgName = [...genTypes].map(prettyType).join(' + ');
    } else if (fgHint && fgHint.loaded) {
      fgName = fgHint.library;
      const simFps = sims.length >= 3 ? 1000 / percentile(sims.slice().sort((a, b) => a - b), 0.5) : 0;
      const manual = +multiplierSetting;
      if (multiplierSetting === 'off') {
        source = 'none';
      } else if (manual >= 2) {
        multiplier = manual; renderedFps = displayedFps / manual; source = 'manual';
      } else if (simFps > 0 && displayedFps / simFps > 1.4) {
        renderedFps = simFps; multiplier = displayedFps / simFps; source = 'pcl';
      } else {
        const m = this.cadenceMultiplier(pid, gpu);
        if (m > 1) { multiplier = m; renderedFps = displayedFps / m; source = 'cadence'; }
      }
    }
    // Hysteresis: FG turns on at once, but only turns off after 1.5 s without evidence, so a sparse signal
    // can't make the badge blink. An explicit "off" setting applies immediately.
    const hold = this.fgHold.get(pid);
    if (multiplier > 1.25) {
      this.fgHold.set(pid, { at: now, multiplier, source, name: fgName });
    } else if (hold && now - hold.at < 1500 && multiplierSetting !== 'off' && displayedFps > 0) {
      ({ multiplier, source } = hold);
      fgName = fgName || hold.name;
      renderedFps = displayedFps / multiplier;
    }
    const fgActive = multiplier > 1.25;
    if (!fgActive) { renderedFps = displayedFps; multiplier = 1; if (source !== 'none') source = 'none'; }
    // 1.98 / 2.02 are 2×: snap near-integers so the badge doesn't alternate between "2×" and "2.0×".
    if (Math.abs(multiplier - Math.round(multiplier)) < 0.08) multiplier = Math.round(multiplier);

    // ---- frame times for the graph, 1% low and pacing ----
    // 'present' (default) is present-to-present, what RTSS shows and what a frame cap flattens. Display-change
    // times snap to refresh steps under v-sync/composition and jitter even when delivery is smooth.
    // Driver frame gen (AFMF) never passes through the game's presents, so it always uses display times.
    const ftSource = frametimeSource === 'present' && genN === 0 ? 'present' : (anyDisplay ? 'display' : 'present');
    const ftOf = (r) => (ftSource === 'present' ? r.between : r.display);
    const lowFrom = now - lowWindowSec * 1000;
    const times = [];
    for (let i = rows.length - 1; i >= 0 && rows[i].t > lowFrom; i--) {
      const r = rows[i];
      const v = ftOf(r);
      if (v !== null && v > 0 && r.type.toLowerCase() !== 'repeated') times.push(v);
    }
    // Pacing: mean frame-to-frame change in frame time. Steady pacing → near 0 even at low FPS.
    let jitter = 0;
    for (let i = 1; i < times.length; i++) jitter += Math.abs(times[i] - times[i - 1]);
    const pacingMs = times.length > 1 ? jitter / (times.length - 1) : null;
    times.sort((a, b) => a - b);
    const p99 = percentile(times, 0.99);
    const p999 = percentile(times, 0.999);

    const cursorKey = pid;
    const since = this.graphCursor.get(cursorKey) ?? now - 2000;
    const frames = [];
    for (let i = rows.length - 1; i >= 0 && rows[i].t > since; i--) {
      const r = rows[i];
      const v = ftOf(r);
      if (v !== null && v > 0) frames.push([r.t, +v.toFixed(2)]);
    }
    frames.reverse();
    this.graphCursor.set(cursorKey, now);

    return {
      pid,
      app: ch.app,
      runtime: ch.runtime,
      presentMode: ch.mode,
      now,
      displayedFps,
      presentFps,
      renderedFps,
      frametimeMs: displayedFps > 0 ? 1000 / displayedFps : 0,
      low1Fps: p99 ? 1000 / p99 : 0,
      low01Fps: p999 ? 1000 / p999 : 0,
      latencyMs: latN ? latSum / latN : null,
      pacingMs,
      fg: { active: fgActive, multiplier: +multiplier.toFixed(2), source, name: fgName },
      frametimeSource: ftSource,
      frameTypeColumn: anyType,
      displayTracked: anyDisplay,
      frames,
    };
  }

  /**
   * Generated frames are cheap on the GPU (an interpolation pass) while real frames carry the
   * whole render. If per-present GPU busy time splits cleanly into a heavy and a light group,
   * presents/heavy is the multiplier. Requires agreement across several windows before trusting it.
   */
  cadenceMultiplier(pid, gpu) {
    let st = this.cadence.get(pid);
    if (!st) { st = { votes: [], value: 1 }; this.cadence.set(pid, st); }
    let vote = 1;
    if (gpu.length >= 24) {
      const s = gpu.slice().sort((a, b) => a - b);
      let best = null;
      for (let i = Math.floor(s.length * 0.25); i <= Math.floor(s.length * 0.8); i++) {
        const lo = s.slice(0, i), hi = s.slice(i);
        const mlo = lo.reduce((a, b) => a + b, 0) / lo.length;
        const mhi = hi.reduce((a, b) => a + b, 0) / hi.length;
        const gap = s[i] / Math.max(0.05, s[i - 1]);
        if (!best || gap > best.gap) best = { gap, ratio: mhi / Math.max(0.05, mlo), heavy: hi.length };
      }
      if (best && best.gap > 1.8 && best.ratio > 2.5) {
        const m = Math.round(gpu.length / best.heavy);
        if (m >= 2 && m <= 4) vote = m;
      }
    }
    st.votes.push(vote);
    if (st.votes.length > 6) st.votes.shift();
    const agree = st.votes.filter((v) => v === vote).length;
    if (agree >= 5) st.value = vote;
    else if (st.votes.filter((v) => v === 1).length >= 4) st.value = 1;
    return st.value;
  }

  resetGraph(pid) { this.graphCursor.delete(pid); this.fgHold.delete(pid); }
}

function prettyType(t) {
  const k = t.toLowerCase();
  if (k.includes('afmf')) return 'AFMF';
  if (k.includes('xefg') || k.includes('xess')) return 'XeSS FG';
  if (k.includes('dlss')) return 'DLSS FG';
  if (k.includes('fsr')) return 'FSR FG';
  return t.replace(/_/g, ' ');
}

module.exports = { PresentMon, percentile };
