'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  general: {
    launchAtStartup: false,
    startMinimized: true,
    showOnlyInGames: true,
    hideWhenUnfocused: true,
  },
  overlay: {
    layout: 'pill',            // pill | card | minimal
    position: 'top-left',      // top-left | top-right | bottom-left | bottom-right | top-center
    offsetX: 10,
    offsetY: 10,
    scale: 1,
    opacity: 0.9,
    updateMs: 250,
    coverBackdrop: true,
    showGameName: true,
    radius: 14,
  },
  metrics: {
    fps: true,
    renderedFps: true,
    frametime: true,
    graph: true,
    low1: true,
    gpuLoad: true,
    gpuTemp: true,
    gpuClock: false,
    vram: true,
    cpuLoad: true,
    ram: false,
    upscaler: true,
    framegen: true,
    latency: false,
    time: false,
  },
  stats: {
    fpsWindowMs: 1000,
    lowWindowSec: 10,
    graphSeconds: 5,
  },
  theme: {
    mode: 'auto',              // auto (cover art) | preset | custom
    preset: 'midnight',
    customAccent: '#8b7bff',
    onlineLookup: true,
    transitionMs: 900,
    reduceMotion: false,
  },
  framegen: {
    inGameMultiplier: 'auto',  // auto | off | 2 | 3 | 4
    detectLosslessScaling: true,
    showSource: true,
  },
  hotkeys: {
    toggleOverlay: 'Alt+Shift+O',
    cycleLayout: 'Alt+Shift+L',
    openSettings: 'Alt+Shift+S',
  },
  presentmon: {
    path: '',
    extraArgs: '',
  },
  games: {},                   // key -> { disabled, themeOverride }
  blocklist: [
    'explorer.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'brave.exe', 'discord.exe',
    'steamwebhelper.exe', 'steam.exe', 'epicgameslauncher.exe', 'code.exe', 'claude.exe', 'electron.exe',
    'superlay.exe', 'dwm.exe', 'searchhost.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe',
    'radeonsoftware.exe', 'nvidia app.exe', 'obs64.exe', 'spotify.exe', 'textinputhost.exe', 'applicationframehost.exe',
  ],
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.listeners = new Set();
    let saved = {};
    let exists = true;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { exists = false; }
    this.data = merge(DEFAULTS, saved);
    if (!exists) this.save();
  }

  get() { return this.data; }

  set(patch) {
    this.data = merge(this.data, patch);
    this.save();
    for (const fn of this.listeners) fn(this.data, patch);
    return this.data;
  }

  reset(section) {
    this.data = section ? { ...this.data, [section]: structuredClone(DEFAULTS[section]) } : structuredClone(DEFAULTS);
    this.save();
    for (const fn of this.listeners) fn(this.data, {});
    return this.data;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
        fs.renameSync(this.file + '.tmp', this.file);
      } catch (e) { console.error('settings save failed', e); }
    }, 150);
  }
}

module.exports = { Settings, DEFAULTS, merge };
