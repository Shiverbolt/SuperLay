'use strict';
// Works out which upscaler and frame generator a game is using.
//
// Evidence, best first:
//   1. Loaded module list (exact, but anti-cheat protected games refuse it).
//   2. "Mapped" probe of the DLLs in the install folder: an image-mapped DLL can't be opened for
//      writing, so we learn which ones are loaded without touching the game process.
//   3. Installed-only: the DLL ships with the game but we can't tell whether it's active.
const fs = require('fs');
const path = require('path');

const LIBS = [
  { re: /^amdxcffx64\.dll$/i, kind: 'upscaler', family: 'FSR', driver: true },
  { re: /^nvngx_dlss\.dll$/i, kind: 'upscaler', family: 'DLSS', vendor: 'nvidia' },
  { re: /^nvngx_dlssd\.dll$/i, kind: 'denoiser', family: 'DLSS RR', vendor: 'nvidia' },
  { re: /^nvngx_dlssg\.dll$/i, kind: 'fg', family: 'DLSS FG', vendor: 'nvidia' },
  { re: /^amd_fidelityfx_upscaler_(dx12|vk)\.dll$/i, kind: 'upscaler', family: 'FSR' },
  { re: /^amd_fidelityfx_framegeneration_(dx12|vk)\.dll$/i, kind: 'fg', family: 'FSR FG' },
  { re: /^amd_fidelityfx_(dx12|vk)\.dll$/i, kind: 'upscaler', family: 'FSR', bundlesFg: true },
  { re: /^ffx_fsr3upscaler_x64\.dll$|^ffx_fsr3_x64\.dll$/i, kind: 'upscaler', family: 'FSR', fixed: 'FSR 3' },
  { re: /^ffx_frameinterpolation_x64\.dll$/i, kind: 'fg', family: 'FSR FG', fixed: 'FSR 3 FG' },
  { re: /^ffx_fsr2_api_(x64|dx12_x64|vk_x64)\.dll$/i, kind: 'upscaler', family: 'FSR', fixed: 'FSR 2' },
  { re: /^libxess\.dll$/i, kind: 'upscaler', family: 'XeSS' },
  { re: /^libxess_fg\.dll$/i, kind: 'fg', family: 'XeSS FG' },
  { re: /^optiscaler\.(dll|asi)$/i, kind: 'mod', family: 'OptiScaler' },
];
const MODULE_PATTERN = '^(amdxcffx64|nvngx_dlss[dg]?|amd_fidelityfx_[a-z_0-9]+|ffx_[a-z0-9_]+|libxess(_fg)?|optiscaler|dxgi|winmm|version|nvngx)\\.(dll|asi)$';
const PRIORITY = ['FSR', 'DLSS', 'XeSS'];

function libFor(name) { return LIBS.find((l) => l.re.test(name)); }

function major(v) { return +String(v || '').split(/[.,]/)[0] || 0; }
function shortVer(v) { return String(v || '').split(/[.,]/).slice(0, 3).join('.'); }

function describe(lib, file) {
  const v = file.version;
  const m = major(v);
  switch (lib.family) {
    case 'DLSS': {
      // DLSS 310.x ships the transformer model (DLSS 4); earlier DLLs are CNN only.
      const dlss4 = m >= 310;
      const override = /\\NGX\\models\\/i.test(file.path || '');
      return {
        label: dlss4 ? 'DLSS 4' : `DLSS ${shortVer(v) || ''}`.trim(),
        model: dlss4 ? 'Transformer-capable (preset set by game/driver)' : 'CNN',
        version: v,
        note: override ? 'NVIDIA app override' : '',
      };
    }
    case 'DLSS FG':
      return { label: m >= 310 ? 'DLSS 4 FG' : 'DLSS 3 FG', model: m >= 310 ? 'Multi Frame Gen capable (RTX 50)' : '2×', version: v };
    case 'DLSS RR':
      return { label: 'DLSS RR', model: m >= 310 ? 'Transformer' : 'CNN', version: v };
    case 'FSR': {
      if (lib.driver) return { label: 'FSR 4', model: 'ML upscaler (driver)', version: v };
      if (lib.fixed) return { label: lib.fixed, model: 'Analytical', version: v };
      if (/upscaler/i.test(file.name) && m >= 4) return { label: 'FSR 4', model: 'ML upscaler', version: v };
      return { label: 'FSR 3.1', model: 'Analytical', version: v };
    }
    case 'FSR FG': return { label: lib.fixed || (m >= 4 ? 'FSR 4 FG' : 'FSR 3 FG'), version: v };
    case 'XeSS': return { label: m ? `XeSS ${m}` : 'XeSS', model: m >= 2 ? 'XeSS-SR 2' : 'XeSS-SR', version: v };
    case 'XeSS FG': return { label: 'XeSS FG', version: v };
    default: return { label: lib.family, version: v };
  }
}

/** Top folder of a game install, so we can scan it for upscaler DLLs. */
function gameRoot(exe) {
  const steam = exe.match(/^(.*?\\steamapps\\common\\[^\\]+)/i);
  if (steam) return steam[1];
  const store = exe.match(/^(.*?\\(?:Epic Games|GOG Games|GOG Galaxy\\Games|XboxGames|Ubisoft Game Launcher\\games|EA Games|Riot Games)\\[^\\]+)/i);
  if (store) return store[1];
  let dir = path.dirname(exe);
  if (/\\Binaries\\Win(64|32)$/i.test(dir)) dir = path.resolve(dir, '..', '..', '..');
  else if (/\\(bin|bin64|x64|win64|binaries)$/i.test(dir)) dir = path.dirname(dir);
  return dir;
}

async function scanDlls(root, limit = 25000) {
  const out = [];
  let seen = 0;
  async function walk(dir, depth) {
    if (depth > 7 || seen > limit) return;
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      seen++;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/^(\.|__|Content|Paks|Movies|Saved|Cache|ShaderCache|Logs)/i.test(e.name)) await walk(p, depth + 1);
      } else if ((libFor(e.name)) || /^optiscaler\.ini$/i.test(e.name)) {
        out.push(p);
      }
    }
  }
  await walk(root, 0);
  return out;
}

class Detector {
  constructor(helper) {
    this.helper = helper;
    this.scanCache = new Map();   // exe -> { files: [{path, name, version}] }
  }

  async installed(exe) {
    let c = this.scanCache.get(exe);
    if (c) return c;
    const root = gameRoot(exe);
    const paths = (await scanDlls(root)).filter((p) => !/\.ini$/i.test(p));
    const ver = await this.helper.versions(paths);
    const vmap = new Map((ver?.files || []).map((f) => [f.path, f.version]));
    c = {
      root,
      optiscalerIni: false,
      files: paths.map((p) => ({ path: p, name: path.basename(p), version: vmap.get(p) || '' })),
    };
    try { c.optiscalerIni = (await scanDlls(root, 4000)).some((p) => /optiscaler\.ini$/i.test(p)); } catch { /* ignore */ }
    this.scanCache.set(exe, c);
    return c;
  }

  /** @returns {Promise<object>} detection summary for the overlay and the diagnostics page. */
  async detect(pid, exe, gpuName = '') {
    const vendor = /nvidia|geforce|rtx|gtx/i.test(gpuName) ? 'nvidia' : /amd|radeon/i.test(gpuName) ? 'amd' : /intel|arc/i.test(gpuName) ? 'intel' : '';
    const result = { method: 'none', items: [], upscaler: null, fg: null, optiscaler: false, notes: [] };

    let loaded = null;
    const mods = await this.helper.modules(pid, MODULE_PATTERN);
    if (mods && mods.ok) {
      result.method = 'modules';
      loaded = mods.modules.map((m) => ({ ...m, state: 'loaded' }));
      if (loaded.some((m) => /^(dxgi|winmm|version|nvngx)\.dll$/i.test(m.name) && exe && path.dirname(m.path).toLowerCase() === path.dirname(exe).toLowerCase())) {
        // Proxy DLL next to the exe: almost always an upscaler mod (OptiScaler, DLSS Enabler, ...).
        result.optiscaler = true;
      }
    }

    let files = loaded || [];
    if (!loaded && exe) {
      const inst = await this.installed(exe);
      result.optiscaler = inst.optiscalerIni;
      const probe = await this.helper.mapped(inst.files.map((f) => f.path));
      const states = new Map((probe?.files || []).map((f) => [f.path, f.state]));
      files = inst.files.map((f) => ({ ...f, state: states.get(f.path) || 'unknown' }));
      result.method = files.some((f) => f.state !== 'unknown') ? 'mapped' : 'installed';
    }

    for (const f of files) {
      const lib = libFor(f.name);
      if (!lib) continue;
      if (lib.family === 'OptiScaler') { result.optiscaler = true; continue; }
      // DLSS can't execute on non-NVIDIA GPUs unless a mod spoofs it.
      if (lib.vendor === 'nvidia' && vendor && vendor !== 'nvidia' && !result.optiscaler) continue;
      result.items.push({ ...describe(lib, f), kind: lib.kind, family: lib.family, state: f.state, file: f.name, path: f.path, bundlesFg: !!lib.bundlesFg });
    }

    const pick = (kind) => {
      const list = result.items.filter((i) => i.kind === kind);
      const active = list.filter((i) => i.state === 'loaded');
      const pool = active.length ? active : list.filter((i) => i.state !== 'idle');
      pool.sort((a, b) => (b.label === 'FSR 4') - (a.label === 'FSR 4') || PRIORITY.indexOf(a.family) - PRIORITY.indexOf(b.family));
      if (!pool.length) return null;
      const best = { ...pool[0], confidence: active.length ? 'active' : 'installed' };
      if (active.length > 1) best.alsoLoaded = active.slice(1).map((i) => i.label);
      if (!active.length && pool.length > 1) best.alternatives = pool.slice(1).map((i) => i.label);
      return best;
    };

    result.upscaler = pick('upscaler');
    let fg = pick('fg');
    if (!fg && result.upscaler && result.upscaler.bundlesFg && result.upscaler.state === 'loaded') {
      // FSR 3.1 ships upscaler and frame generation in one DLL.
      fg = { label: 'FSR 3 FG', family: 'FSR FG', confidence: 'possible', state: 'loaded' };
    }
    result.fg = fg;

    if (vendor === 'amd' && /RX\s*9\d{3}/i.test(gpuName) && result.upscaler && result.upscaler.label === 'FSR 3.1') {
      result.notes.push('RDNA 4: FSR 3.1 can be upgraded to FSR 4 in AMD Software → Gaming → this game.');
    }
    if (result.optiscaler) result.notes.push('Upscaler mod detected (OptiScaler or similar): the real upscaler may differ from the one the game asks for.');
    if (result.method === 'mapped') result.notes.push('Game blocks module inspection; active libraries detected from mapped DLL files.');
    return result;
  }
}

module.exports = { Detector, gameRoot, describe, libFor };
