'use strict';
// Finds installed games from each store's own install records, like other game-overlay and launcher apps do:
//   Steam   libraryfolders.vdf + appmanifest_*.acf in every library
//   Epic    ProgramData\Epic\EpicGamesLauncher\Data\Manifests\*.item
//   GOG     HKLM\SOFTWARE\WOW6432Node\GOG.com\Games
//   Ubisoft HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs
//   Xbox    <drive>\XboxGames\* on drives with a .GamingRoot marker
// Store records say where a game is, rarely which exe is the game. pickExe() chooses it; an exe SuperLay has
// actually seen running always wins.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const NOT_GAMES = /redistributable|steamworks shared|steam linux runtime|proton|steamvr|wallpaper engine|dedicated server|\bsdk\b|soundtrack|benchmark tool|^steam controller/i;
const NOT_GAME_APPIDS = new Set(['228980', '431960', '250820', '1070560', '1391110', '1628350', '1493710', '2180100']);

const SKIP_EXE = /^(unins.*|setup.*|.*vc_?redist.*|vcredist.*|dxsetup|dxwebsetup|ue\dprereq.*|ueprereq.*|.*crash.*|easyanticheat.*|start_protected_game|be(service|launcher|client).*|ace-.*|7za?|8za.*|.*helper|unitycrashhandler.*|d3dconfig|.*compiler.*|checkenv|notification_helper|ccmini|ccgamerecord.*|render|.*redist.*|.*install(er)?.*|.*updater.*|.*launcher.*|.*config(urator)?|.*protocolselector|cefsharp.*|dotnet.*|vs_.*|.*overlay.*|.*report.*|.*bootstrap.*|quicksfv|dxsetup.*)\.exe$/i;
const SKIP_DIR = /^(_commonredist|redist|extras|crashreporter|crashpad|anticheatexpert|easyanticheat|battleye|cc_bin|cc|webviewsupport.*|directx|dotnet|vcredist|__installer|installers?|prereq.*|support|tools?|ue4prereq|sdk|.*cache|saved|logs?|content|paks)$/i;

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout))));
}

const keyOf = (exe) => crypto.createHash('sha1').update(exe.toLowerCase()).digest('hex').slice(0, 12);

// Store launchers and clients: they render with the GPU and take focus, but they're never the game.
const LAUNCHERS = /^(redlauncher|redprelauncher|epicgameslauncher|steam|steamwebhelper|galaxyclient|gogalaxy|ubisoftconnect|upc|uplay|eadesktop|eabackgroundservice|origin|battle\.net|blizzard ?launcher|bethesdanetlauncher|rockstarservice|launcher|launcherpatcher|playnite\.(desktop|fullscreen)app|heroiclauncher|amazon games|xboxpcapp|gamingservices)\.exe$/i;

/**
 * True for executables that must never be treated as games: Windows itself (explorer.exe's desktop window is
 * titled "Program Manager", which once matched a Steam game by name), Store system apps, launchers, and the
 * user's "never a game" list.
 */
function isNonGameExe(exe, blocklist = []) {
  if (!exe) return true;
  const lower = exe.toLowerCase();
  const sysRoot = `${(process.env.SystemRoot || 'C:\\Windows').toLowerCase()}\\`;
  if (lower.startsWith(sysRoot)) return true;
  if (/\\windowsapps\\microsoft\.(windows|xbox(app|gamingoverlay)|gamingapp)/.test(lower)) return true;
  const base = path.basename(lower);
  return LAUNCHERS.test(base) || blocklist.includes(base);
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** The game's exe in an install folder: Unreal's *-Shipping.exe if present, else the largest plausible exe. */
function pickExe(dir, maxDepth = 5) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p, depth + 1); continue; }
      if (!/\.exe$/i.test(e.name) || SKIP_EXE.test(e.name)) continue;
      let size = 0;
      try { size = fs.statSync(p).size; } catch { continue; }
      if (size < 1024 * 1024) continue;            // stubs and tiny tools
      found.push({ p, size, shipping: /-(win64|wingdk)-shipping\.exe$/i.test(e.name), engine: /\\Engine\\(Binaries|Extras)\\/i.test(p) && !/\\Engine\\Binaries\\Win64r?\\[^\\]+\.exe$/i.test(p) });
    }
  };
  walk(dir, 0);
  if (!found.length) return null;
  found.sort((a, b) => (b.shipping - a.shipping) || (a.engine - b.engine) || (b.size - a.size));
  return found[0].p;
}

// ---------------------------------------------------------------- stores
async function steamGames() {
  const out = [];
  const reg = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
  const steamPath = (reg.match(/SteamPath\s+REG_SZ\s+(.+)/) || [])[1]?.trim().replace(/\//g, '\\');
  if (!steamPath) return out;
  // libraryfolders.vdf keeps real casing (the registry's SteamPath is lowercased), so it goes first.
  const libs = [];
  try {
    const vdf = fs.readFileSync(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  } catch { /* single library */ }
  if (!libs.some((l) => l.toLowerCase() === steamPath.toLowerCase())) libs.push(steamPath);
  for (const lib of libs) {
    const apps = path.join(lib, 'steamapps');
    let files = [];
    try { files = fs.readdirSync(apps).filter((f) => /^appmanifest_\d+\.acf$/i.test(f)); } catch { continue; } // drive missing
    for (const f of files) {
      let txt;
      try { txt = fs.readFileSync(path.join(apps, f), 'utf8'); } catch { continue; }
      const get = (k) => (txt.match(new RegExp(`"${k}"\\s+"([^"]*)"`, 'i')) || [])[1];
      const appId = get('appid'), name = get('name'), installdir = get('installdir');
      if (!appId || !name || !installdir || NOT_GAME_APPIDS.has(appId) || NOT_GAMES.test(name)) continue;
      const dir = path.join(apps, 'common', installdir);
      if (isDir(dir)) out.push({ store: 'steam', appId, name, dir });
    }
  }
  return out;
}

function epicGames() {
  const out = [];
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.item')); } catch { return out; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j.bIsIncompleteInstall || !j.InstallLocation || !isDir(j.InstallLocation)) continue;
      if (Array.isArray(j.AppCategories) && !j.AppCategories.includes('games')) continue;
      const hint = j.LaunchExecutable ? path.join(j.InstallLocation, j.LaunchExecutable) : null;
      out.push({ store: 'epic', name: j.DisplayName, dir: j.InstallLocation, exeHint: hint && fs.existsSync(hint) ? hint : null });
    } catch { /* malformed manifest */ }
  }
  return out;
}

async function registryGames(key, store, map) {
  const txt = await run('reg', ['query', key, '/s']);
  const out = [];
  for (const block of txt.split(/\r?\n(?=HKEY_)/)) {
    const v = {};
    for (const m of block.matchAll(/^\s+(\S[^\r\n]*?)\s{4}REG_\w+\s{4}(.*)$/gm)) v[m[1].toLowerCase()] = m[2].trim();
    const g = map(v);
    if (g && g.dir && isDir(g.dir)) out.push({ store, ...g });
  }
  return out;
}

const gogGames = () => registryGames('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', 'gog',
  (v) => v.path && { name: v.gamename || path.basename(v.path), dir: v.path, exeHint: v.exe && fs.existsSync(v.exe) ? v.exe : null });

const ubisoftGames = () => registryGames('HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs', 'ubisoft',
  (v) => v.installdir && { name: path.basename(v.installdir.replace(/[\\/]+$/, '')), dir: v.installdir.replace(/\//g, '\\') });

function xboxGames() {
  const out = [];
  for (let c = 67; c <= 90; c++) {                  // C..Z
    const root = `${String.fromCharCode(c)}:\\`;
    if (!fs.existsSync(path.join(root, '.GamingRoot'))) continue;
    const base = path.join(root, 'XboxGames');
    let dirs = [];
    try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !/^gamesave$/i.test(d.name)); } catch { continue; }
    for (const d of dirs) {
      const content = path.join(base, d.name, 'Content');
      out.push({ store: 'xbox', name: d.name, dir: isDir(content) ? content : path.join(base, d.name) });
    }
  }
  return out;
}

/**
 * All installed games. knownExes: exes SuperLay has seen running (from its game database), used instead of
 * guessing when one lives inside a game's folder.
 */
async function scanLibrary(knownExes = []) {
  const lists = await Promise.all([steamGames(), epicGames(), gogGames(), ubisoftGames(), xboxGames()].map((p) => Promise.resolve(p).catch(() => [])));
  const games = [];
  const seenDirs = new Set();
  for (const g of lists.flat()) {
    const dirKey = g.dir.toLowerCase().replace(/[\\/]+$/, '');
    if (seenDirs.has(dirKey)) continue;
    seenDirs.add(dirKey);
    const known = knownExes.find((e) => e.toLowerCase().startsWith(`${dirKey}\\`) && fs.existsSync(e));
    const exe = known || g.exeHint || pickExe(g.dir);
    if (!exe) continue;
    games.push({ key: keyOf(exe), name: g.name, exe, dir: g.dir, store: g.store, appId: g.appId || null, exeSource: known ? 'seen' : g.exeHint ? 'store' : 'guessed' });
  }
  return games.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { scanLibrary, pickExe, keyOf, isNonGameExe, NOT_GAMES };
