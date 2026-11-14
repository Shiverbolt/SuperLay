'use strict';
// Translates SuperLay's OptiScaler options into OptiScaler.ini keys, and edits the ini in place (comments,
// order and every key SuperLay doesn't manage stay as they are). OptiScaler reads the ini when the game starts,
// so changes apply on the next launch.
const fs = require('fs');
const path = require('path');

// Per-game options. 'default' always means "leave OptiScaler's own default" (writes auto).
const GAME_DEFAULTS = {
  upscaler: 'default',   // default | fsr4 | fsr31 | xess | dlss | fsr22
  fsr4Model: 'default',  // default | 0..5 (FSR 4 internal preset)
  dlssPreset: 'default', // default | K | L | M  (NVIDIA only)
  renderScale: 0,        // 0 = game's choice, else forced ratio 1.0..3.0 (1.5 = Quality, 2.0 = Performance)
  sharpen: -1,           // -1 = game's, else 0..1.3 (RCAS)
  fg: 'default',         // default | off | dlssg | fsrfg | optifg
  fgEngine: 'fsrfg',     // fsrfg | xefg
  xefgMultiplier: 2,     // 2..4 (XeSS FG only)
  spoof: 'default',      // default | on | off  (report an NVIDIA GPU so the game offers DLSS)
};

// Options for OptiScaler's in-game menu, shared by every game.
const MENU_DEFAULTS = {
  style: 'superlay',     // superlay (SuperLay's colours) | game (that game's theme) | optiscaler (stock look)
  key: 0x2d,             // virtual-key code; -1 = no hotkey
  scale: 1.0,
  splash: false,         // OptiScaler's startup message
};

const DLSS_PRESET = { K: 11, L: 12, M: 13 };

function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => +(v / 255).toFixed(3));
}

/** { Section: { Key: value } } for one game. palette = the theme to paint the menu with (or null). */
function iniValues(cfg, menu, palette) {
  const c = { ...GAME_DEFAULTS, ...(cfg || {}) };
  const mn = { ...MENU_DEFAULTS, ...(menu || {}) };
  const auto = 'auto';
  const v = {
    Upscalers: { Dx11Upscaler: auto, Dx12Upscaler: auto, VulkanUpscaler: auto },
    FSR: { UpscalerIndex: auto, Fsr4Update: auto, Fsr4Preset: auto },
    DLSS: { RenderPresetOverride: auto, RenderPresetForAll: auto },
    UpscaleRatio: { UpscaleRatioOverrideEnabled: auto, UpscaleRatioOverrideValue: auto },
    Sharpness: { OverrideSharpness: auto, Sharpness: auto },
    FrameGen: { Enabled: auto, FGInput: auto, FGOutput: auto },
    XeFG: { InterpolationCount: auto },
    OptiFG: { HUDFix: auto },
    Spoofing: { Dxgi: auto },
    Menu: {
      ShortcutKey: auto, Scale: auto, DisableSplash: auto,
      UseHQFont: auto, TTFFontPath: auto, FontSize: auto, LightTheme: auto,
      AccentColorR: auto, AccentColorG: auto, AccentColorB: auto,
      BGColorR: auto, BGColorG: auto, BGColorB: auto, BGColorA: auto,
    },
  };

  // Upscaler. FSR 4 is OptiScaler's "fsr31" backend with the FSR 4 model selected (index 0); DX11 and Vulkan
  // games reach it through OptiScaler's DX12 bridge (_12).
  const U = {
    fsr4: ['fsr31_12', 'fsr31', 'fsr31_12', 0],
    fsr31: ['fsr31', 'fsr31', 'fsr31', 1],
    fsr22: ['fsr22', 'fsr22', 'fsr22', null],
    xess: ['xess_12', 'xess', 'xess', null],
    dlss: ['dlss', 'dlss', 'dlss', null],
  }[c.upscaler];
  if (U) {
    [v.Upscalers.Dx11Upscaler, v.Upscalers.Dx12Upscaler, v.Upscalers.VulkanUpscaler] = U;
    if (U[3] !== null) v.FSR.UpscalerIndex = U[3];
    if (c.upscaler === 'fsr4') v.FSR.Fsr4Update = 'true';
  }
  if (c.fsr4Model !== 'default' && /^[0-5]$/.test(String(c.fsr4Model))) v.FSR.Fsr4Preset = Number(c.fsr4Model);
  if (DLSS_PRESET[c.dlssPreset] !== undefined) { v.DLSS.RenderPresetOverride = 'true'; v.DLSS.RenderPresetForAll = DLSS_PRESET[c.dlssPreset]; }
  if (c.renderScale >= 1 && c.renderScale <= 3) {
    v.UpscaleRatio.UpscaleRatioOverrideEnabled = 'true';
    v.UpscaleRatio.UpscaleRatioOverrideValue = +Number(c.renderScale).toFixed(2);
  }
  if (c.sharpen >= 0) { v.Sharpness.OverrideSharpness = 'true'; v.Sharpness.Sharpness = +Number(Math.min(1.3, c.sharpen)).toFixed(2); }

  // Frame generation: where the frames come from (FGInput) and what generates them (FGOutput).
  const out = c.fgEngine === 'xefg' ? 'xefg' : 'fsrfg';
  if (c.fg === 'off') Object.assign(v.FrameGen, { Enabled: 'false', FGInput: 'nofg', FGOutput: 'nofg' });
  else if (c.fg === 'dlssg') Object.assign(v.FrameGen, { Enabled: 'true', FGInput: 'dlssg', FGOutput: out });
  else if (c.fg === 'fsrfg') Object.assign(v.FrameGen, { Enabled: 'true', FGInput: 'fsrfg', FGOutput: out });
  else if (c.fg === 'optifg') { Object.assign(v.FrameGen, { Enabled: 'true', FGInput: 'upscaler', FGOutput: out }); v.OptiFG.HUDFix = 'true'; }
  if (c.fg !== 'default' && c.fg !== 'off' && out === 'xefg') v.XeFG.InterpolationCount = Math.max(1, Math.min(3, (Number(c.xefgMultiplier) || 2) - 1));

  if (c.spoof === 'on') v.Spoofing.Dxgi = 'true';
  else if (c.spoof === 'off') v.Spoofing.Dxgi = 'false';

  // In-game menu
  const key = Number(mn.key);
  if (key === -1) v.Menu.ShortcutKey = -1;
  else if (key > 0 && key < 256 && key !== 0x2d) v.Menu.ShortcutKey = `0x${key.toString(16).toUpperCase().padStart(2, '0')}`;
  if (mn.scale && Math.abs(mn.scale - 1) > 0.01) v.Menu.Scale = +Number(Math.max(0.5, Math.min(2, mn.scale))).toFixed(2);
  if (!mn.splash) v.Menu.DisableSplash = 'true';
  if (mn.style !== 'optiscaler' && palette) {
    const a = hexToRgb01(palette.accent), bg = hexToRgb01(palette.bg);
    if (a && bg) {
      [v.Menu.AccentColorR, v.Menu.AccentColorG, v.Menu.AccentColorB] = a;
      [v.Menu.BGColorR, v.Menu.BGColorG, v.Menu.BGColorB] = bg;
      v.Menu.BGColorA = 0.94;
      v.Menu.LightTheme = 'false';
    }
    const font = path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts', 'segoeui.ttf');
    if (fs.existsSync(font)) { v.Menu.UseHQFont = 'true'; v.Menu.TTFFontPath = font; v.Menu.FontSize = 16; }
  }
  return v;
}

/** Rewrites Key=value lines inside their sections; adds keys (or sections) that are missing. */
function patchIni(text, values) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const todo = {};
  for (const [s, kv] of Object.entries(values)) todo[s.toLowerCase()] = new Map(Object.entries(kv).map(([k, val]) => [k.toLowerCase(), [k, val]]));
  let section = null, lastKeyLine = {};
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (h) { section = h[1].trim().toLowerCase(); lastKeyLine[section] = i; continue; }
    const kv = /^\s*([^;#=\s][^=]*?)\s*=/.exec(lines[i]);
    if (!kv || !section || !todo[section]) continue;
    const want = todo[section].get(kv[1].toLowerCase());
    lastKeyLine[section] = i;
    if (!want) continue;
    lines[i] = `${want[0]}=${want[1]}`;
    todo[section].delete(kv[1].toLowerCase());
  }
  // Missing keys: insert after the section's last key, newest sections appended at the end.
  const inserts = [];
  for (const [s, rest] of Object.entries(todo)) {
    if (!rest.size) continue;
    const add = [...rest.values()].map(([k, val]) => `${k}=${val}`);
    if (lastKeyLine[s] !== undefined) inserts.push([lastKeyLine[s] + 1, add]);
    else inserts.push([lines.length, ['', `[${Object.keys(values).find((x) => x.toLowerCase() === s)}]`, ...add]]);
  }
  inserts.sort((a, b) => b[0] - a[0]);
  for (const [at, add] of inserts) lines.splice(at, 0, ...add);
  return lines.join(eol);
}

/** Reads back the values SuperLay manages from an ini (for tests and for showing what's on disk). */
function readIni(text) {
  const out = {};
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (h) { section = h[1].trim(); out[section] = out[section] || {}; continue; }
    const kv = /^\s*([^;#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv && section) out[section][kv[1]] = kv[2];
  }
  return out;
}

/** Writes the options into <dir>/OptiScaler.ini. Returns false when there's no ini there. */
function applyToDir(dir, cfg, menu, palette) {
  const file = path.join(dir, 'OptiScaler.ini');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const next = patchIni(text, iniValues(cfg, menu, palette));
  if (next !== text) {
    fs.writeFileSync(`${file}.tmp`, next);
    fs.renameSync(`${file}.tmp`, file);
  }
  return true;
}

module.exports = { GAME_DEFAULTS, MENU_DEFAULTS, iniValues, patchIni, readIni, applyToDir };
