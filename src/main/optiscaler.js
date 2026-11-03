'use strict';
// OptiScaler manager: downloads the official release, installs it next to a game's exe, and removes it
// again exactly. Follows OptiScaler's own install guide (github.com/optiscaler/OptiScaler/wiki).
// SuperLay isn't affiliated with OptiScaler; problems with this installer belong in SuperLay's issues.
//
// Every install is recorded in a manifest with a checksum per file. Game files that OptiScaler's bundle
// overwrites (libxess.dll, amd_fidelityfx_*.dll, ...) are backed up and restored on removal, unless the
// game has since changed them (update / Steam verify), in which case the game's file wins.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { gameRoot } = require('./detect');

const REPO = 'optiscaler/OptiScaler';
const PROXIES = ['dxgi.dll', 'winmm.dll', 'version.dll', 'dbghelp.dll', 'd3d12.dll', 'wininet.dll', 'winhttp.dll'];
const SKIP_FILES = /^(setup_windows\.bat|setup_linux\.sh|!!.*\.txt|Remove.?OptiScaler\.bat)$/i;
const NVIDIA_SKIP = /^fakenvapi\.(dll|ini)$/i;   // wiki: "Do not use with Nvidia, only required for AMD/Intel"
const CACHE_MS = 6 * 3600 * 1000;

// Files and folders that ship with anti-cheat systems. OptiScaler warns it can get accounts banned there.
const ANTI_CHEAT = [
  [/^easyanticheat(_eos)?$|^easyanticheat.*\.(exe|sys|dll)$|^start_protected_game\.exe$/i, 'Easy Anti-Cheat'],
  [/^battleye$|^be(service|client|daemon).*\.(exe|dll)$/i, 'BattlEye'],
  [/^anticheatexpert$|^ace-(base|core|service|setup).*$/i, 'ACE (Anti-Cheat Expert)'],
  [/^eaanticheat.*$/i, 'EA Anti-Cheat'],
  [/^(nprotect|gameguard)$|^gameguard\.des$/i, 'nProtect GameGuard'],
  [/^xigncode.*$|^x3\.xem$/i, 'XIGNCODE3'],
  [/^(pnkbstr[ab]\.exe|punkbuster)$/i, 'PunkBuster'],
  [/^mhyprot.*\.sys$/i, 'mhyprot'],
  [/^vgk\.sys$|^vanguard$/i, 'Riot Vanguard'],
  [/^(tencentprotect|tprot.*\.sys|sguard.*\.exe)$/i, 'Tencent protection'],
  [/^xhunter1\.sys$/i, 'XIGNCODE (xhunter)'],
];

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0; }
  return false;
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, base)); else out.push(path.relative(base, p));
  }
  return out;
}

function findAntiCheat(root, limit = 40000) {
  const found = new Set();
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 6 || seen > limit) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      seen++;
      for (const [re, name] of ANTI_CHEAT) if (re.test(e.name)) found.add(name);
      if (e.isDirectory() && !/^(Content|Paks|Movies|ShaderCache|Saved|__)/i.test(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return [...found];
}

class OptiScaler {
  /** deps: { net, dataDir, helper } */
  constructor(deps) {
    this.d = deps;
    this.root = path.join(deps.dataDir, 'optiscaler');
    this.pkgDir = path.join(this.root, 'packages');
    this.backupDir = path.join(this.root, 'backups');
    this.manifestFile = path.join(this.root, 'installs.json');
    this.latestInfo = null;
    this.scanCache = new Map();
    this.busy = {};
    this.installs = {};
    this.manifestMtime = 0;
    this.loadManifest();
    this.metaFile = path.join(this.root, 'game-signals.json');
    try { this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')); } catch { this.meta = { steam: {}, protected: {} }; }
  }

  saveMeta() {
    try { fs.mkdirSync(this.root, { recursive: true }); fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 2)); } catch { /* best effort */ }
  }

  /** Called when a running game refused module inspection: a strong sign of kernel-level anti-cheat. */
  markProtected(exe) {
    const k = exe.toLowerCase();
    if (this.meta.protected[k]) return;
    this.meta.protected[k] = Date.now();
    this.saveMeta();
  }

  /** Steam store categories for an app (cached for 30 days). */
  async steamCategories(appId) {
    if (!appId || !this.d.net) return [];
    const c = this.meta.steam[appId];
    if (c && Date.now() - c.at < 30 * 86400000) return c.ids;
    try {
      const res = await this.d.net.fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=categories`, { headers: { 'User-Agent': 'SuperLay' } });
      const j = await res.json();
      const ids = (j?.[appId]?.data?.categories || []).map((x) => x.id);
      this.meta.steam[appId] = { at: Date.now(), ids };
      this.saveMeta();
      return ids;
    } catch { return c?.ids || []; }
  }

  /**
   * Why installing could be risky. 'block' risks need explicit confirmation; 'warn' ones are shown only.
   * OptiScaler's own docs: "Do not use this mod with online games. It may trigger anti-cheat software and cause bans!"
   */
  async risks(game, scan) {
    const out = scan.antiCheat.map((n) => ({ level: 'block', text: `Anti-cheat: ${n}` }));
    if (this.meta.protected[game.exe.toLowerCase()]) out.push({ level: 'block', text: 'Blocked inspection while running (usually kernel anti-cheat)' });
    const cats = await this.steamCategories(game.appId);
    if (cats.includes(20) || cats.includes(36)) out.push({ level: 'block', text: cats.includes(20) ? 'Online game (MMO)' : 'Online multiplayer (PvP)' });
    else if (cats.includes(38) || cats.includes(1)) out.push({ level: 'warn', text: 'Has online play: use OptiScaler offline' });
    return out;
  }

  /**
   * (Re)reads the install records when the file changed on disk, e.g. written by another SuperLay copy (dev build
   * vs installed). A failed read never wipes records already in memory.
   */
  loadManifest(force = false) {
    let mtime = 0;
    try { mtime = fs.statSync(this.manifestFile).mtimeMs; } catch { return; }   // no installs yet
    if (mtime === this.manifestMtime && !force) return;
    try {
      this.installs = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'));
      this.manifestMtime = mtime;
    } catch { /* keep what we have; try again next time */ }
  }

  /**
   * The install record for a game. The file on disk is the source of truth: before concluding there is none,
   * re-read it, and also match by install folder, so a key mismatch can never turn our own install into
   * "installed manually" with no Remove button.
   */
  findRecord(game) {
    const byFolder = () => {
      const dir = path.dirname(game.exe || '').toLowerCase();
      return Object.values(this.installs).find((m) => m && m.dir && m.dir.toLowerCase() === dir) || null;
    };
    this.loadManifest();
    let m = this.installs[game.key] || byFolder();
    if (!m) { this.loadManifest(true); m = this.installs[game.key] || byFolder(); }
    return m;
  }

  /**
   * Applies one change (set or delete an entry) to the records on disk. Re-reads first, so a copy of SuperLay
   * with an outdated view can never drop entries another copy wrote.
   */
  updateManifest(key, entry) {
    this.loadManifest(true);
    if (entry) this.installs[key] = entry; else delete this.installs[key];
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.manifestFile + '.tmp', JSON.stringify(this.installs, null, 2));
    fs.renameSync(this.manifestFile + '.tmp', this.manifestFile);
    try { this.manifestMtime = fs.statSync(this.manifestFile).mtimeMs; } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ package (the downloaded release)
  async latest(force = false) {
    if (this.latestInfo && !force && Date.now() - this.latestInfo.checkedAt < CACHE_MS) return this.latestInfo;
    try {
      const res = await this.d.net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': 'SuperLay', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const rel = await res.json();
      const asset = (rel.assets || []).find((a) => /\.7z$/i.test(a.name));
      this.latestInfo = { version: String(rel.tag_name || '').replace(/^v/i, ''), asset, url: rel.html_url, checkedAt: Date.now() };
    } catch (e) {
      this.latestInfo = { version: '', error: e.message, checkedAt: Date.now() };
    }
    return this.latestInfo;
  }

  /** Newest package already downloaded and extracted. */
  cachedPackage() {
    let best = null;
    try {
      for (const v of fs.readdirSync(this.pkgDir)) {
        if (!/^\d+(\.\d+)*$/.test(v) || !fs.existsSync(path.join(this.pkgDir, v, 'OptiScaler.dll'))) continue;
        if (!best || newer(v, best)) best = v;
      }
    } catch { /* none yet */ }
    return best ? { version: best, dir: path.join(this.pkgDir, best) } : null;
  }

  async downloadPackage() {
    const latest = await this.latest(true);
    if (!latest.asset) throw new Error(latest.error || 'No OptiScaler release archive found on GitHub.');
    const dest = path.join(this.pkgDir, latest.version);
    if (fs.existsSync(path.join(dest, 'OptiScaler.dll'))) return { version: latest.version };
    fs.mkdirSync(this.pkgDir, { recursive: true });
    const archive = path.join(this.pkgDir, `${latest.version}.7z`);
    const res = await this.d.net.fetch(latest.asset.browser_download_url, { headers: { 'User-Agent': 'SuperLay' } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    const tmp = `${dest}.partial`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    // Windows' bundled bsdtar reads 7z archives, so no extra dependency is needed.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const r = await run(tar, ['-xf', archive, '-C', tmp], 300000);
    fs.rmSync(archive, { force: true });
    if (r.err || !fs.existsSync(path.join(tmp, 'OptiScaler.dll'))) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error(`Could not extract OptiScaler: ${(r.stderr || r.err?.message || 'unknown error').trim().split(/\r?\n/)[0]}`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    // Keep only the newest package.
    for (const v of fs.readdirSync(this.pkgDir)) if (v !== latest.version) fs.rmSync(path.join(this.pkgDir, v), { recursive: true, force: true });
    return { version: latest.version };
  }

  // ------------------------------------------------------------ per-game state
  async scanGame(exe, force = false) {
    const c = this.scanCache.get(exe);
    if (c && !force && Date.now() - c.at < 60000) return c.scan;
    const dir = path.dirname(exe);
    const present = PROXIES.filter((p) => fs.existsSync(path.join(dir, p)));
    const info = present.length ? await this.d.helper.versions(present.map((p) => path.join(dir, p))) : { files: [] };
    const proxies = {};
    for (const f of info?.files || []) proxies[path.basename(f.path).toLowerCase()] = { orig: f.orig || '', version: f.version || '' };
    const scan = {
      dir,
      antiCheat: findAntiCheat(gameRoot(exe)),
      proxies,                                   // existing proxy-named DLLs: name -> { orig, version }
      writable: (() => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } })(),
    };
    this.scanCache.set(exe, { at: Date.now(), scan });
    return scan;
  }

  async isRunning(exe) {
    const r = await this.d.helper.mapped([exe]);
    return r?.files?.[0]?.state === 'loaded';
  }

  /** Install state for one game: none | installed | damaged | manual (someone else's OptiScaler). */
  async gameStatus(game) {
    const m = this.findRecord(game);
    const scan = await this.scanGame(game.exe);
    const manualProxy = Object.entries(scan.proxies).find(([name, p]) => /optiscaler/i.test(p.orig) && (!m || m.proxy !== name));
    let state = 'none', missing = 0, changed = 0;
    if (m) {
      for (const f of m.files) {
        const p = path.join(m.dir, f.rel);
        if (!fs.existsSync(p)) missing++;
        else if (f.rel.toLowerCase() !== 'optiscaler.ini' && sha256(p) !== f.sha) changed++;
      }
      // The proxy DLL itself gone = OptiScaler no longer loads (Steam verify, game update, manual delete).
      state = !fs.existsSync(path.join(m.dir, m.proxy)) || missing ? 'damaged' : 'installed';
    } else if (manualProxy || fs.existsSync(path.join(scan.dir, 'OptiScaler.dll'))) {
      state = 'manual';
      this.logManual(game, scan);
    }
    return {
      state,
      version: m?.version || (manualProxy ? manualProxy[1].version : ''),
      proxy: m?.proxy || (manualProxy ? manualProxy[0] : ''),
      missing, changed,
      antiCheat: scan.antiCheat,
      risks: await this.risks(game, scan),
      writable: scan.writable,
      freeProxies: PROXIES.filter((p) => !scan.proxies[p] || (m && m.proxy === p)),
      takenProxies: Object.entries(scan.proxies).filter(([n]) => !(m && m.proxy === n)).map(([n, p]) => ({ name: n, by: p.orig || 'unknown' })),
      installedAt: m?.installedAt || null,
      dir: scan.dir,
    };
  }

  // ------------------------------------------------------------ install / remove
  async install(game, { proxy = 'auto', vendor = '', allowRisk = false } = {}) {
    if (!game?.exe || !fs.existsSync(game.exe)) throw new Error('Game executable not found. Launch the game once so SuperLay can find it.');
    if (await this.isRunning(game.exe)) throw new Error('Close the game first: its files are in use.');
    const scan = await this.scanGame(game.exe, true);
    const blocking = (await this.risks(game, scan)).filter((r) => r.level === 'block');
    if (blocking.length && !allowRisk) {
      throw new Error(`${blocking.map((r) => r.text).join('; ')}. OptiScaler can get accounts banned in online games.`);
    }
    if (!scan.writable) throw new Error('SuperLay can\'t write to this game\'s folder. Run SuperLay as administrator or check the folder\'s permissions.');

    // Updating: remove our previous install first so its backups are restored before taking new ones.
    const prev = this.findRecord(game);
    if (prev) await this.uninstall(game, { alreadyCheckedRunning: true });
    const scan2 = await this.scanGame(game.exe, true);

    const pkg = this.cachedPackage() || (await this.downloadPackage(), this.cachedPackage());
    if (!pkg) throw new Error('OptiScaler package is missing.');

    let target = proxy === 'auto' ? (prev?.proxy || 'dxgi.dll') : proxy;
    if (!PROXIES.includes(target)) throw new Error('Unsupported proxy name.');
    if (scan2.proxies[target]) {
      if (proxy !== 'auto') throw new Error(`${target} already exists in the game folder (${scan2.proxies[target].orig || 'another mod'}). Pick another filename.`);
      target = PROXIES.find((p) => !scan2.proxies[p]);
      if (!target) throw new Error('Every filename OptiScaler can load as is already used in this game folder.');
    }

    const files = walkFiles(pkg.dir).filter((rel) => !SKIP_FILES.test(path.basename(rel)) && !(vendor === 'nvidia' && NVIDIA_SKIP.test(path.basename(rel))));
    const entry = { key: game.key, name: game.name, exe: game.exe, dir: scan2.dir, version: pkg.version, proxy: target, installedAt: Date.now(), files: [] };
    const backupRoot = path.join(this.backupDir, game.key);
    try {
      for (const rel of files) {
        const destRel = rel.toLowerCase() === 'optiscaler.dll' ? target : rel;
        const dest = path.join(scan2.dir, destRel);
        const src = path.join(pkg.dir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const rec = { rel: destRel, action: 'added' };
        if (fs.existsSync(dest)) {
          const backup = path.join(backupRoot, destRel);
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.copyFileSync(dest, backup);
          rec.action = 'replaced';
          rec.backup = backup;
        }
        fs.copyFileSync(src, dest);
        rec.sha = sha256(dest);
        entry.files.push(rec);
      }
    } catch (e) {
      await this.rollback(entry);
      throw new Error(`Install failed and was rolled back: ${e.message}`);
    }
    this.updateManifest(game.key, entry);
    this.scanCache.delete(game.exe);
    return { version: pkg.version, proxy: target, replaced: entry.files.filter((f) => f.action === 'replaced').map((f) => f.rel) };
  }

  async rollback(entry) {
    for (const f of entry.files.slice().reverse()) {
      const p = path.join(entry.dir, f.rel);
      try { if (f.action === 'replaced') fs.copyFileSync(f.backup, p); else fs.rmSync(p, { force: true }); } catch { /* best effort */ }
    }
    this.pruneDirs(entry);
    fs.rmSync(path.join(this.backupDir, entry.key), { recursive: true, force: true });
  }

  pruneDirs(entry) {
    const dirs = [...new Set(entry.files.map((f) => path.dirname(f.rel)).filter((d) => d !== '.'))].sort((a, b) => b.length - a.length);
    for (const d of dirs) { try { fs.rmdirSync(path.join(entry.dir, d)); } catch { /* not empty or gone */ } }
  }

  async uninstall(game, { alreadyCheckedRunning = false } = {}) {
    const m = this.findRecord(game);
    if (!m) throw new Error('OptiScaler wasn\'t installed by SuperLay for this game.');
    const recordKey = m.key || game.key;   // the record may have been saved under another key
    if (!alreadyCheckedRunning && await this.isRunning(m.exe)) throw new Error('Close the game first: its files are in use.');
    const kept = [];
    for (const f of m.files.slice().reverse()) {
      const p = path.join(m.dir, f.rel);
      const exists = fs.existsSync(p);
      const ours = exists && (f.rel.toLowerCase() === 'optiscaler.ini' || sha256(p) === f.sha);
      if (f.action === 'replaced') {
        // Restore the game's original unless the game has replaced the file itself since.
        if (!exists || ours) fs.copyFileSync(f.backup, p); else kept.push(f.rel);
      } else if (ours) {
        fs.rmSync(p, { force: true });
      } else if (exists) {
        kept.push(f.rel);
      }
    }
    this.pruneDirs(m);
    fs.rmSync(path.join(this.backupDir, recordKey), { recursive: true, force: true });
    this.updateManifest(recordKey, null);
    this.scanCache.delete(m.exe);
    return { kept };
  }
}

// Files that only OptiScaler's bundle puts in a game folder (safe to remove without a record).
const OPTI_ONLY_FILES = /^(optiscaler\.(dll|ini|log|asi)|fakenvapi\.(dll|ini|log)|dlssg_to_fsr3.*\.(dll|log)|optipatcher\.asi)$/i;
// Libraries OptiScaler ships that games also ship themselves: never removed without a record.
const SHARED_LIBS = /^(libxess.*|libxell|amd_fidelityfx_.*)\.dll$/i;
const OPTI_LICENSES = new Set(['directx_license.txt', 'fidelityfx_v1_license.md', 'fidelityfx_v2_license.md', 'xess_license.txt']);

Object.assign(OptiScaler.prototype, {
  /**
   * Removes OptiScaler from a game folder SuperLay has no record for (installed by hand, by another tool, or a
   * record SuperLay lost). Only unmistakable OptiScaler files are touched, and they're moved to a backup folder
   * rather than deleted. Shared upscaler libraries stay: without a record we can't know if the game shipped them.
   */
  async removeUnmanaged(game) {
    if (!game?.exe) throw new Error('Game executable not found.');
    const m = this.findRecord(game);
    if (m) return { ...(await this.uninstall(game)), managed: true };
    if (await this.isRunning(game.exe)) throw new Error('Close the game first: its files are in use.');

    const dir = path.dirname(game.exe);
    const scan = await this.scanGame(game.exe, true);
    const targets = [];
    for (const [name, p] of Object.entries(scan.proxies)) if (/optiscaler/i.test(p.orig)) targets.push(name);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable */ }
    const kept = [];
    for (const e of entries) {
      if (e.isFile() && OPTI_ONLY_FILES.test(e.name)) targets.push(e.name);
      if (e.isFile() && SHARED_LIBS.test(e.name)) kept.push(e.name);
      if (e.isDirectory() && /^d3d12_optiscaler$/i.test(e.name)) targets.push(e.name);
      if (e.isDirectory() && /^licenses$/i.test(e.name)) {
        const files = fs.readdirSync(path.join(dir, e.name)).map((f) => f.toLowerCase());
        if (files.length && files.every((f) => OPTI_LICENSES.has(f))) targets.push(e.name);
      }
    }
    // A fakenvapi renamed to nvapi64.dll (older setups)
    if (fs.existsSync(path.join(dir, 'nvapi64.dll'))) {
      const v = await this.d.helper.versions([path.join(dir, 'nvapi64.dll')]);
      if (/fakenvapi/i.test(v?.files?.[0]?.orig || '')) targets.push('nvapi64.dll');
    }
    if (!targets.some((t) => PROXIES.includes(t.toLowerCase()) || /^optiscaler\./i.test(t))) {
      throw new Error('No OptiScaler files found in this game\'s folder.');
    }

    const backup = path.join(this.root, 'removed', `${game.key}-${Date.now()}`);
    fs.mkdirSync(backup, { recursive: true });
    const moved = [];
    for (const name of [...new Set(targets)]) {
      const src = path.join(dir, name);
      try {
        fs.cpSync(src, path.join(backup, name), { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
        moved.push(name);
      } catch (e) { throw new Error(`Could not remove ${name}: ${e.message}. Nothing else was changed after that file.`); }
    }
    this.scanCache.delete(game.exe);
    return { moved, kept, backup, managed: false };
  },

  /** Appends what gameStatus saw when it decided "manual", so the cause of a lost record is visible. */
  logManual(game, scan) {
    this._loggedManual = this._loggedManual || new Set();
    if (this._loggedManual.has(game.key)) return;
    this._loggedManual.add(game.key);
    try {
      let fileKeys = [];
      try { fileKeys = Object.entries(JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'))).map(([k, v]) => `${k}:${v.dir}`); } catch (e) { fileKeys = [`unreadable: ${e.message}`]; }
      const line = JSON.stringify({
        at: new Date().toISOString(), key: game.key, exe: game.exe, dir: scan.dir,
        memoryKeys: Object.keys(this.installs), fileKeys, manifestFile: this.manifestFile,
      });
      const log = path.join(this.root, 'manual-detections.log');
      fs.appendFileSync(log, `${line}\n`);
      if (fs.statSync(log).size > 200000) fs.writeFileSync(log, `${line}\n`);
    } catch { /* diagnostics only */ }
  },
});

module.exports = { OptiScaler, findAntiCheat, PROXIES, ANTI_CHEAT };
