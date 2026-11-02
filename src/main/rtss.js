'use strict';
// RivaTuner Statistics Server integration: reads and sets per-game frame-rate caps.
// RTSS does the in-game hooking (and is tolerated by most anti-cheats); SuperLay only edits its profiles.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const APPLY_SCRIPT = path.join(__dirname, 'rtss-apply.ps1').replace('app.asar', 'app.asar.unpacked');

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

/**
 * Writes a cap through RTSS's API. Needs admin; when SuperLay isn't elevated this triggers one UAC prompt.
 * limit 0 removes the cap. Fractional limits (e.g. 59.94) use RTSS's denominator.
 */
async function applyCap(dir, exeName, { limit, mode }, elevated) {
  const den = Number.isInteger(limit) ? 1 : 100;
  const resultFile = path.join(os.tmpdir(), `superlay-rtss-${process.pid}-${Date.now()}.json`);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const inner = `& ${q(APPLY_SCRIPT)} -Dll ${q(path.join(dir, 'RTSSHooks64.dll'))} -ProfileName ${q(exeName)} `
    + `-Limit ${Math.round(limit * den)} -Denominator ${den} -Mode ${MODE_IDS[mode] ?? -1} -Result ${q(resultFile)}`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];

  let r;
  if (elevated) {
    r = await run('powershell.exe', psArgs, 30000);
  } else {
    const outer = `$p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList ${psArgs.map(q).join(',')}; exit $p.ExitCode`;
    r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], 120000);
  }
  let res = null;
  try { res = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^﻿/, '')); fs.unlinkSync(resultFile); } catch { /* no result */ }
  if (!res) {
    if (/cancel/i.test(r.stderr)) return { ok: false, message: 'Administrator permission was declined.' };
    return { ok: false, message: (r.stderr || r.err?.message || 'RTSS update failed.').trim().split(/\r?\n/)[0] };
  }
  if (!res.ok) return res;
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

module.exports = { locate, isRunning, readProfile, applyCap, recommendCap, parseFramerate, MODES };
