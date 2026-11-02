'use strict';
// RivaTuner Statistics Server integration: reads and sets per-game frame-rate caps.
// RTSS does the in-game hooking (and is tolerated by most anti-cheats); SuperLay only edits its profiles.
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const BROKER_SCRIPT = path.join(__dirname, 'rtss-broker.ps1').replace('app.asar', 'app.asar.unpacked');

// RTSS's SyncLimiter values, in the order of its "Framerate limiter" setting.
const MODES = { 0: 'async', 1: 'front-edge', 2: 'back-edge' };
const MODE_IDS = { async: 0, 'front-edge': 1, 'back-edge': 2 };

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

async function locate() {
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Unwinder\\RTSS', 'HKLM\\SOFTWARE\\Unwinder\\RTSS']) {
    const r = await run('reg', ['query', key]);
    if (r.err) continue;
    const val = (name) => (r.stdout.match(new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(.+)$`, 'mi')) || [])[1]?.trim();
    const dir = val('InstallDir');
    if (dir && fs.existsSync(path.join(dir, 'RTSSHooks64.dll'))) return { dir, version: val('ProductVersion') || '' };
  }
  return null;
}

async function isRunning() {
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq RTSS.exe', '/NH']);
  return /RTSS\.exe/i.test(r.stdout);
}

function parseFramerate(text) {
  const sec = text.match(/^\[Framerate\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  if (!sec) return null;
  const get = (k) => { const m = sec[1].match(new RegExp(`^${k}=(-?\\d+)\\s*$`, 'm')); return m ? +m[1] : null; };
  const limit = get('Limit') ?? 0;
  const den = Math.max(1, get('LimitDenominator') ?? 1);
  const mode = get('SyncLimiter') ?? 0;
  return { limit: limit / den, raw: limit, denominator: den, mode: MODES[mode] || `mode ${mode}`, modeId: mode };
}

/** Effective cap for an exe: its own profile if it has one, else the global profile. */
function readProfile(dir, exeName) {
  const own = path.join(dir, 'Profiles', `${exeName}.cfg`);
  for (const [file, source] of [[own, 'game'], [path.join(dir, 'Profiles', 'Global'), 'global']]) {
    try {
      const fr = parseFramerate(fs.readFileSync(file, 'utf8'));
      if (fr) return { ...fr, source, file };
    } catch { /* missing */ }
  }
  return { limit: 0, raw: 0, denominator: 1, mode: 'async', modeId: 0, source: 'none' };
}

// ---------------------------------------------------------------- elevated broker
// One elevated helper per SuperLay session (one UAC prompt), reached over a named pipe locked to this
// user and a random token. It exits when SuperLay does. See rtss-broker.ps1.
const broker = { pipe: null, token: null, starting: null };

function pipeRequest(line, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let buf = '', done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(v); } };
    const sock = net.connect(`\\\\.\\pipe\\${broker.pipe}`);
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('connect', () => { if (line === null) finish('connected'); else sock.write(`${line}\n`); });
    sock.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) finish(buf.slice(0, nl).trim()); });
    sock.on('error', () => finish(null));
  });
}

async function startBroker(dir, elevated) {
  broker.pipe = `SuperLay-RTSS-${crypto.randomBytes(8).toString('hex')}`;
  broker.token = crypto.randomBytes(24).toString('hex');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  // -EncodedCommand sidesteps Start-Process's unquoted -ArgumentList joining (paths with spaces).
  const inner = `& ${q(BROKER_SCRIPT)} -Dll ${q(path.join(dir, 'RTSSHooks64.dll'))} -Pipe ${q(broker.pipe)} -Token ${q(broker.token)} -ParentPid ${process.pid}`;
  const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(inner, 'utf16le').toString('base64')];

  if (elevated) {
    spawn('powershell.exe', psArgs, { windowsHide: true, stdio: 'ignore' });
  } else {
    const outer = `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ${psArgs.map(q).join(',')}`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], 120000);
    if (r.err) {
      broker.pipe = null;
      return { ok: false, message: /cancel/i.test(r.stderr) ? 'Administrator permission was declined.' : (r.stderr.trim().split(/\r?\n/)[0] || 'Could not start the RTSS helper.') };
    }
  }
  for (let i = 0; i < 60; i++) {           // the broker needs a moment to compile and open its pipe
    if (await pipeRequest(null, 500)) return { ok: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  broker.pipe = null;
  return { ok: false, message: 'The RTSS helper did not start.' };
}

async function ensureBroker(dir, elevated) {
  if (broker.pipe && await pipeRequest(null, 1000)) return { ok: true };
  if (!broker.starting) broker.starting = startBroker(dir, elevated).finally(() => { broker.starting = null; });
  return broker.starting;
}

/** True once the elevated helper is running, i.e. caps apply without another prompt. */
function brokerReady() { return !!broker.pipe; }

/**
 * Writes a cap through RTSS's API via the broker. The first call per session asks for admin
 * (unless SuperLay is already elevated); later calls are silent.
 * limit 0 removes the cap. Fractional limits (e.g. 59.94) use RTSS's denominator.
 */
async function applyCap(dir, exeName, { limit, mode }, elevated) {
  const den = Number.isInteger(limit) ? 1 : 100;
  const line = () => `${broker.token}|${exeName}|${Math.round(limit * den)}|${den}|${MODE_IDS[mode] ?? -1}`;
  let reply = null;
  for (let attempt = 0; attempt < 2 && !reply; attempt++) {
    const b = await ensureBroker(dir, elevated);
    if (!b.ok) return b;
    reply = await pipeRequest(line());
    if (!reply) broker.pipe = null;        // broker died (killed, sign-out...): start a new one once
  }
  if (!reply) return { ok: false, message: 'Lost contact with the RTSS helper.' };
  if (reply !== 'ok') return { ok: false, message: reply.replace(/^err\s*/, '') };
  // Trust the file, not RTSS's return codes.
  const now = readProfile(dir, exeName);
  const modeOk = MODE_IDS[mode] === undefined || now.modeId === MODE_IDS[mode];
  if (now.source !== 'game' || Math.abs(now.limit - limit) > 0.005 || !modeOk) {
    return { ok: false, message: 'RTSS did not save the change. Make sure RTSS is running and try again.' };
  }
  return { ok: true, message: 'Applied.' };
}

/**
 * Suggests a cap the game can hold steadily.
 *  - VRR: stay a few fps under the refresh rate so frames never fall out of the VRR window.
 *  - Driver frame generation (AFMF) doubles frames after RTSS, so cap the base rate.
 *  - Never above what the system sustains (10th percentile of recent rendered FPS), so the cap stays flat.
 */
function recommendCap({ refresh, vrr = true, sustainedFps = 0, fg = null }) {
  const reasons = [];
  if (!refresh) return { cap: 0, reasons: ['Refresh rate unknown.'] };
  // refresh − 3 is the usual VRR margin; very high refresh rates get a little more (240 → 237, 480 → 474).
  let ceiling = vrr ? refresh - Math.max(3, Math.floor(refresh * 0.0125)) : refresh;
  reasons.push(vrr ? `${refresh} Hz VRR display → stay under ${ceiling} fps` : `${refresh} Hz fixed refresh → cap at refresh`);

  const mult = fg?.active ? Math.max(1, Math.round(fg.multiplier)) : 1;
  const driverFg = fg?.active && fg.source === 'frame-type';
  if (driverFg && mult > 1) {
    ceiling = Math.floor(ceiling / mult);
    reasons.push(`${fg.name || 'Driver frame gen'} ${mult}× runs after RTSS → cap base frames at ${ceiling}`);
  } else if (fg?.active) {
    reasons.push(`${fg.name || 'In-game frame gen'} active → RTSS limits the final output`);
  }

  // sustainedFps is in the same units as the cap: base frames for driver FG, output frames otherwise.
  let cap = ceiling;
  if (sustainedFps > 0 && sustainedFps < ceiling * 0.97) {
    cap = Math.max(30, Math.floor(sustainedFps));
    reasons.push(`Sustains ~${Math.round(sustainedFps)} fps → cap there for flat frame times`);
  }
  return { cap, reasons };
}

module.exports = { locate, isRunning, readProfile, applyCap, brokerReady, recommendCap, parseFramerate, MODES };
