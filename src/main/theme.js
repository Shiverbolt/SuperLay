'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, nativeImage, net } = require('electron');

// ---------------------------------------------------------------- colour math (OKLab)
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToLab(r, g, b) {
  r = toLin(r / 255); g = toLin(g / 255); b = toLin(b / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToRgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toGam);
}

function lchToHex(L, C, h) {
  // Reduce chroma until the colour fits in sRGB.
  for (let c = C; c >= 0; c -= 0.004) {
    const rad = (h * Math.PI) / 180;
    const rgb = labToRgb(L, c * Math.cos(rad), c * Math.sin(rad));
    if (rgb.every((v) => v >= -0.001 && v <= 1.001)) {
      return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
    }
  }
  return '#808080';
}

function hexToLch(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const [L, a, b] = rgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Build the full overlay theme from an accent hue/chroma and a background hue/chroma. */
function buildTheme({ accent, accent2, bgHue, bgChroma = 0.03 }) {
  return {
    accent: lchToHex(clamp(accent.L, 0.72, 0.82), clamp(accent.C, 0.1, 0.2), accent.h),
    accent2: lchToHex(clamp(accent2.L, 0.68, 0.8), clamp(accent2.C, 0.08, 0.18), accent2.h),
    bg: lchToHex(0.17, Math.min(bgChroma, 0.035), bgHue),
    surface: lchToHex(0.235, Math.min(bgChroma, 0.04), bgHue),
    line: lchToHex(0.32, Math.min(bgChroma, 0.04), bgHue),
    text: lchToHex(0.97, 0.01, bgHue),
    muted: lchToHex(0.74, 0.025, bgHue),
    good: lchToHex(0.8, 0.15, 150),
    warn: lchToHex(0.82, 0.15, 80),
    bad: lchToHex(0.7, 0.18, 25),
  };
}

const PRESETS = {
  midnight: { name: 'Midnight', accent: { L: 0.76, C: 0.15, h: 285 }, accent2: { L: 0.75, C: 0.13, h: 220 }, bgHue: 275, bgChroma: 0.03 },
  glacier: { name: 'Glacier', accent: { L: 0.82, C: 0.11, h: 210 }, accent2: { L: 0.78, C: 0.1, h: 175 }, bgHue: 230, bgChroma: 0.025 },
  ember: { name: 'Ember', accent: { L: 0.76, C: 0.17, h: 45 }, accent2: { L: 0.8, C: 0.14, h: 80 }, bgHue: 30, bgChroma: 0.025 },
  verdant: { name: 'Verdant', accent: { L: 0.8, C: 0.16, h: 145 }, accent2: { L: 0.78, C: 0.12, h: 190 }, bgHue: 160, bgChroma: 0.02 },
  synth: { name: 'Synthwave', accent: { L: 0.74, C: 0.19, h: 350 }, accent2: { L: 0.78, C: 0.14, h: 250 }, bgHue: 300, bgChroma: 0.035 },
  mono: { name: 'Mono', accent: { L: 0.9, C: 0.01, h: 260 }, accent2: { L: 0.75, C: 0.01, h: 260 }, bgHue: 260, bgChroma: 0.004 },
};
// mono needs low chroma: bypass buildTheme's accent floor.
function presetTheme(id) {
  const p = PRESETS[id] || PRESETS.midnight;
  const t = buildTheme(p);
  if (id === 'mono') { t.accent = '#ededf0'; t.accent2 = '#a9abb3'; }
  return { ...t, name: p.name };
}

function customTheme(hex) {
  const a = hexToLch(hex);
  return buildTheme({ accent: a, accent2: { L: a.L, C: a.C * 0.8, h: (a.h + 40) % 360 }, bgHue: a.h, bgChroma: 0.03 });
}

// ---------------------------------------------------------------- palette extraction
function extractPalette(img) {
  const small = img.resize({ width: 72, quality: 'good' });
  const { width, height } = small.getSize();
  const bmp = small.toBitmap(); // BGRA
  const px = [];
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (bmp[o + 3] < 128) continue;
    px.push(rgbToLab(bmp[o + 2], bmp[o + 1], bmp[o]));
  }
  if (px.length < 16) return null;

  // k-means with farthest-point seeding (deterministic, so the same cover always gives the same theme).
  const K = Math.min(8, px.length);
  const cents = [px[Math.floor(px.length / 2)]];
  while (cents.length < K) {
    let best = null, bd = -1;
    for (let i = 0; i < px.length; i += 3) {
      const d = Math.min(...cents.map((c) => (c[0] - px[i][0]) ** 2 + (c[1] - px[i][1]) ** 2 + (c[2] - px[i][2]) ** 2));
      if (d > bd) { bd = d; best = px[i]; }
    }
    cents.push(best.slice());
  }
  const assign = new Array(px.length).fill(0);
  for (let it = 0; it < 10; it++) {
    const sum = cents.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) {
      let bi = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const c = cents[k];
        const d = (c[0] - px[i][0]) ** 2 + (c[1] - px[i][1]) ** 2 + (c[2] - px[i][2]) ** 2;
        if (d < bd) { bd = d; bi = k; }
      }
      assign[i] = bi;
      const s = sum[bi]; s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++;
    }
    for (let k = 0; k < K; k++) if (sum[k][3]) cents[k] = [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]];
  }
  const counts = new Array(K).fill(0);
  for (const a of assign) counts[a]++;
  return cents.map((c, k) => ({
    L: c[0], C: Math.hypot(c[1], c[2]), h: ((Math.atan2(c[2], c[1]) * 180) / Math.PI + 360) % 360, share: counts[k] / px.length,
  })).filter((c) => c.share > 0.01);
}

function themeFromImage(img) {
  const pal = extractPalette(img);
  if (!pal || !pal.length) return null;
  const score = (c) => c.C * (0.35 + Math.sqrt(c.share)) * (1 - Math.abs(c.L - 0.65) * 0.9);
  const vivid = pal.filter((c) => c.C > 0.045 && c.L > 0.25).sort((a, b) => score(b) - score(a));
  const dominant = pal.slice().sort((a, b) => b.share - a.share)[0];
  if (!vivid.length) {
    // Greyscale cover: neutral theme tinted by the dominant hue.
    return buildTheme({ accent: { L: 0.88, C: 0.1, h: dominant.h }, accent2: { L: 0.75, C: 0.08, h: (dominant.h + 30) % 360 }, bgHue: dominant.h, bgChroma: 0.012 });
  }
  const accent = vivid[0];
  const accent2 = vivid.find((c) => hueDist(c.h, accent.h) > 35) || { L: accent.L, C: accent.C * 0.85, h: (accent.h + 45) % 360 };
  // Background follows the cover's dominant dark tone, so the overlay reads as part of the art.
  const darks = pal.filter((c) => c.L < 0.5).sort((a, b) => b.share - a.share);
  const base = darks[0] || dominant;
  return {
    ...buildTheme({ accent, accent2, bgHue: base.C > 0.02 ? base.h : accent.h, bgChroma: Math.max(0.012, base.C * 0.6) }),
    palette: pal.sort((a, b) => b.share - a.share).slice(0, 6).map((c) => lchToHex(c.L, c.C, c.h)),
  };
}

// ---------------------------------------------------------------- game identification
const GENERIC = /^(unreal|unity|game|launcher|client|shipping|win64|main|application|bootstrap|start)$/i;

function cleanName(s) {
  return String(s || '')
    .replace(/[™®©]/g, '')
    .replace(/\s*\((not responding|keine rückmeldung|ne répond pas)\)\s*$/i, '')
    .replace(/\s*[-–|]\s*(dx1[12]|vulkan|directx ?1[12]|d3d1[12])\b.*$/i, '')
    .replace(/\((dx1[12]|vulkan|64-bit|x64)\)/gi, '')
    .replace(/[-_]?(win64|win32)?[-_]?shipping$/i, '')
    .replace(/\bv?\d+\.\d+(\.\d+)*\b.*$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const manifestCache = new Map();
function steamManifest(exe) {
  const m = exe.match(/^(.*?\\steamapps)\\common\\([^\\]+)/i);
  if (!m) return null;
  const [, lib, dir] = m;
  let list = manifestCache.get(lib);
  if (!list) {
    list = [];
    try {
      for (const f of fs.readdirSync(lib)) {
        if (!/^appmanifest_\d+\.acf$/i.test(f)) continue;
        const txt = fs.readFileSync(path.join(lib, f), 'utf8');
        const get = (k) => (txt.match(new RegExp(`"${k}"\\s+"([^"]*)"`, 'i')) || [])[1];
        list.push({ appId: get('appid'), name: get('name'), installdir: get('installdir') });
      }
    } catch { /* unreadable library */ }
    manifestCache.set(lib, list);
  }
  return list.find((e) => e.installdir && e.installdir.toLowerCase() === dir.toLowerCase()) || null;
}

function identify(info) {
  const exe = info.path || '';
  const key = crypto.createHash('sha1').update(exe.toLowerCase() || String(info.app)).digest('hex').slice(0, 12);
  const steam = exe ? steamManifest(exe) : null;
  const folder = exe.match(/\\(?:steamapps\\common|Epic Games|GOG Games|XboxGames)\\([^\\]+)/i)?.[1];
  const candidates = [
    steam?.name,
    cleanName(info.title),
    cleanName(info.product),
    folder && cleanName(folder),
    cleanName(path.basename(exe, '.exe')),
  ].filter((n) => n && n.length >= 2 && n.length <= 70 && !GENERIC.test(n));
  return { key, exe, name: candidates[0] || path.basename(exe || 'Game', '.exe'), steamAppId: steam?.appId || null };
}

// ---------------------------------------------------------------- fetching
function bigrams(s) {
  s = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
  return out;
}
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, total = 0;
  for (const [g, n] of A) { inter += Math.min(n, B.get(g) || 0); total += n; }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

async function fetchBuf(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'SuperLay/0.1' } });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, type };
  } catch { return null; } finally { clearTimeout(t); }
}

async function searchSteam(name) {
  const r = await fetchBuf(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=US`);
  if (!r) return null;
  try {
    const items = JSON.parse(r.buf.toString('utf8')).items || [];
    let best = null, bs = 0;
    for (const it of items.slice(0, 10)) {
      const s = similarity(name, it.name);
      if (s > bs) { bs = s; best = it; }
    }
    return bs >= 0.55 ? { appId: String(best.id), name: best.name } : null;
  } catch { return null; }
}

async function steamCover(appId) {
  const urls = [
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
  ];
  for (const u of urls) {
    const r = await fetchBuf(u);
    if (r && /image/.test(r.type) && r.buf.length > 2000) return r.buf;
  }
  // Newer apps store assets under hashed paths; appdetails gives the real header URL.
  const d = await fetchBuf(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`);
  try {
    const header = JSON.parse(d.buf.toString('utf8'))[appId]?.data?.header_image;
    if (header) { const r = await fetchBuf(header); if (r && /image/.test(r.type)) return r.buf; }
  } catch { /* no data */ }
  return null;
}

// ---------------------------------------------------------------- cache + resolution
class ThemeStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'games.json');
    this.coverDir = path.join(dir, 'covers');
    try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.db = {}; }
    this.inflight = new Map();
  }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.db, null, 2)); } catch (e) { console.error(e); }
    }, 200);
  }

  list() { return Object.entries(this.db).map(([key, g]) => ({ key, ...g })).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)); }
  get(key) { return this.db[key]; }
  forget(key) {
    const g = this.db[key];
    if (g?.coverFile) { try { fs.unlinkSync(g.coverFile); } catch { /* gone */ } }
    delete this.db[key];
    this.save();
  }

  touch(key) { if (this.db[key]) { this.db[key].lastSeen = Date.now(); this.save(); } }

  /** Returns a cached entry immediately when available, otherwise resolves it (network on first run only). */
  resolve(game, { online = true, force = false } = {}) {
    const cached = this.db[game.key];
    if (cached && cached.theme && !force) { this.touch(game.key); return Promise.resolve(cached); }
    if (this.inflight.has(game.key)) return this.inflight.get(game.key);
    const p = this._resolve(game, online).finally(() => this.inflight.delete(game.key));
    this.inflight.set(game.key, p);
    return p;
  }

  async _resolve(game, online) {
    let appId = game.steamAppId, name = game.name, buf = null, source = 'icon';
    if (online) {
      if (!appId) { const hit = await searchSteam(game.name); if (hit) { appId = hit.appId; name = hit.name; } }
      if (appId) { buf = await steamCover(appId); if (buf) source = game.steamAppId ? 'steam' : 'steam-search'; }
    }
    let img = buf ? nativeImage.createFromBuffer(buf) : null;
    if (!img || img.isEmpty()) {
      img = null;
      try { if (game.exe) img = await app.getFileIcon(game.exe, { size: 'large' }); } catch { /* no icon */ }
      source = 'icon';
    }
    const theme = (img && !img.isEmpty() && themeFromImage(img)) || presetTheme('midnight');
    let thumb = null, coverFile = null;
    if (img && !img.isEmpty()) {
      thumb = 'data:image/jpeg;base64,' + img.resize({ width: 180, quality: 'good' }).toJPEG(82).toString('base64');
      if (buf) {
        try {
          fs.mkdirSync(this.coverDir, { recursive: true });
          coverFile = path.join(this.coverDir, `${game.key}.jpg`);
          fs.writeFileSync(coverFile, buf);
        } catch { coverFile = null; }
      }
    }
    const entry = { name, exe: game.exe, appId, source, theme, thumb, coverFile, fetchedAt: Date.now(), lastSeen: Date.now() };
    this.db[game.key] = { ...(this.db[game.key] || {}), ...entry };
    this.save();
    return this.db[game.key];
  }
}

module.exports = { ThemeStore, identify, presetTheme, customTheme, themeFromImage, PRESETS, cleanName, similarity };
