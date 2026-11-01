'use strict';
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, dialog, shell, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { Settings, DEFAULTS } = require('./settings');
const { PresentMon } = require('./presentmon');
const { Helper } = require('./helper');
const { Detector } = require('./detect');
const { ThemeStore, identify, presetTheme, customTheme, PRESETS } = require('./theme');
const { makeIcon } = require('./icon');

app.setAppUserModelId('app.superlay');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload');
const LAYOUTS = ['pill', 'card', 'minimal'];
const PANEL_MARGIN = 14; // matches --margin in overlay.css

let settings, themes, helper, pm, detector;
let overlayWin = null, settingsWin = null, tray = null;
let loopTimer = null;
let hotkeyFailures = [];

const state = {
  target: null,          // { pid, app, info, game, entry, detection, disabled }
  userVisible: true,     // toggled by hotkey / tray
  demo: false,           // settings "preview on screen"
  contentSize: { w: 320, h: 80 },
  lastBounds: null,
  shown: false,
  lastStats: null,
  helperStatus: { state: 'starting' },
};

// ------------------------------------------------------------------ windows
function createOverlay() {
  overlayWin = new BrowserWindow({
    width: 360, height: 120,
    transparent: true, frame: false, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(PRELOAD, 'overlay.js'), backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true);
  overlayWin.loadFile(path.join(RENDERER, 'overlay.html'));
  overlayWin.webContents.on('did-finish-load', pushConfig);
  overlayWin.on('closed', () => { overlayWin = null; });
}

function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 1120, height: 760, minWidth: 900, minHeight: 600,
    title: 'SuperLay', icon: makeIcon(64), show: false,
    backgroundColor: '#111116',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#c9c9d4', height: 40 },
    webPreferences: { preload: path.join(PRELOAD, 'settings.js'), contextIsolation: true, sandbox: true },
  });
  settingsWin.loadFile(path.join(RENDERER, 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; state.demo = false; });
}

// ------------------------------------------------------------------ theme + config
function currentTheme() {
  const S = settings.get();
  const t = state.target;
  const override = t?.game && S.games[t.game.key]?.themeOverride;
  if (override) return override.startsWith('#') ? customTheme(override) : presetTheme(override);
  if (S.theme.mode === 'preset') return presetTheme(S.theme.preset);
  if (S.theme.mode === 'custom') return customTheme(S.theme.customAccent);
  return t?.entry?.theme || presetTheme(S.theme.preset);
}

function pushConfig() {
  if (!overlayWin) return;
  const S = settings.get();
  overlayWin.webContents.send('overlay:config', {
    overlay: S.overlay, metrics: S.metrics, stats: S.stats, theme: S.theme, framegen: S.framegen,
    palette: currentTheme(),
    cover: state.target?.entry?.thumb || null,
    gameName: state.target?.entry?.name || state.target?.game?.name || '',
    demo: state.demo,
  });
}

// ------------------------------------------------------------------ target game
function pickTarget() {
  const S = settings.get();
  const fg = helper.last?.fg;
  const active = pm.activeProcesses(1500);
  const blocked = (name) => S.blocklist.includes(String(name || '').toLowerCase());
  let pid = null;
  if (fg && !fg.minimized && active.has(fg.pid) && !blocked(active.get(fg.pid).app)) pid = fg.pid;
  else if (!S.general.hideWhenUnfocused && state.target && active.has(state.target.pid)) pid = state.target.pid;
  else if (pm.status.state !== 'running' && fg && !fg.minimized && coversDisplay(fg)) pid = fg.pid; // no frame data: sensors-only overlay for fullscreen apps
  if (pid !== (state.target?.pid ?? null)) setTarget(pid, active.get(pid)?.app, fg?.title);
  return active;
}

function coversDisplay(fg) {
  const r = screen.screenToDipRect(null, { x: fg.x, y: fg.y, width: fg.w, height: fg.h });
  const b = screen.getDisplayMatching(r).bounds;
  return r.x <= b.x + 2 && r.y <= b.y + 2 && r.x + r.width >= b.x + b.width - 2 && r.y + r.height >= b.y + b.height - 2;
}

async function setTarget(pid, appName, title) {
  if (state.target?.detectTimer) clearInterval(state.target.detectTimer);
  if (!pid) { state.target = null; pushConfig(); return; }
  const t = { pid, app: appName, info: null, game: null, entry: null, detection: null, disabled: false };
  state.target = t;
  pm.resetGraph(pid);

  const info = (await helper.procInfo(pid)) || {};
  if (state.target !== t) return;
  t.info = info;
  t.game = identify({ ...info, title, app: appName });
  const exeName = path.basename(info.path || appName || '').toLowerCase();
  t.disabled = !!settings.get().games[t.game.key]?.disabled || settings.get().blocklist.includes(exeName);
  if (exeName === path.basename(process.execPath).toLowerCase()) t.disabled = true;

  // Theme: cached instantly, otherwise fetched once (cover art lookup) and stored.
  const cached = themes.get(t.game.key);
  if (cached) { t.entry = cached; themes.touch(t.game.key); }
  pushConfig();
  if (!cached || !cached.theme) {
    themes.resolve(t.game, { online: settings.get().theme.onlineLookup }).then((entry) => {
      if (state.target === t) { t.entry = entry; pushConfig(); }
      sendSettings('games:changed');
    });
  }

  const runDetect = async () => {
    if (state.target !== t || !info.path) return;
    try { t.detection = await detector.detect(pid, info.path, helper.last?.gpu?.name || ''); } catch (e) { console.error('detect', e); }
  };
  runDetect();
  t.detectTimer = setInterval(runDetect, 10000); // upscalers often load only once a level starts
}

// ------------------------------------------------------------------ main loop
function computeFrame() {
  const S = settings.get();
  const active = pickTarget();
  const t = state.target;
  const tick = helper.last || {};
  let fps = null;

  if (t) {
    const fgDet = t.detection?.fg;
    const fgHint = fgDet ? { library: fgDet.label, loaded: fgDet.state !== 'idle' } : null;
    fps = pm.stats(t.pid, {
      fpsWindowMs: S.stats.fpsWindowMs, lowWindowSec: S.stats.lowWindowSec, fgHint, multiplierSetting: S.framegen.inGameMultiplier,
    });
    // Lossless Scaling presents its own window: its rate is what you see, the game's is what's rendered.
    if (fps && S.framegen.detectLosslessScaling) {
      for (const p of active.values()) {
        if (!/^losslessscaling/i.test(p.app || '')) continue;
        const ls = pm.stats(p.pid, { fpsWindowMs: S.stats.fpsWindowMs, lowWindowSec: S.stats.lowWindowSec });
        if (ls && fps.presentFps > 0 && ls.displayedFps > fps.presentFps * 1.3) {
          Object.assign(fps, {
            renderedFps: fps.presentFps, displayedFps: ls.displayedFps, frametimeMs: 1000 / ls.displayedFps,
            low1Fps: ls.low1Fps, frames: ls.frames,
            fg: { active: true, multiplier: +(ls.displayedFps / fps.presentFps).toFixed(2), source: 'lossless', name: 'Lossless Scaling' },
          });
        }
      }
    }
    if (fps) fps.fg.available = fgDet ? fgDet.label : null;
  }
  state.lastStats = fps;

  const inGame = !!t && !t.disabled && (!!fps || pm.status.state !== 'running');
  const visible = state.demo || (state.userVisible && (S.general.showOnlyInGames ? inGame : true));
  setOverlayShown(visible);
  if (!overlayWin || !visible) return;
  placeOverlay();

  const det = t?.detection;
  overlayWin.webContents.send('overlay:frame', {
    fps,
    upscaler: det?.upscaler ? { label: det.upscaler.label, model: det.upscaler.model, confidence: det.upscaler.confidence } : null,
    gpu: tick.gpu || null,
    cpu: tick.cpu,
    ram: tick.ramTotal ? { used: tick.ramUsed, total: tick.ramTotal } : null,
    gameGpu: tick.fgGpu || null,
  });
}

function setOverlayShown(v) {
  if (!overlayWin) return;
  if (v === state.shown) return;
  state.shown = v;
  overlayWin.webContents.send('overlay:visible', v);
  clearTimeout(state.hideTimer);
  if (v) {
    placeOverlay(true);
    overlayWin.showInactive();
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
  } else {
    // Let the exit animation play, then really hide so DWM can return the game to independent flip.
    state.hideTimer = setTimeout(() => { if (!state.shown && overlayWin) overlayWin.hide(); }, 450);
  }
}

function placeOverlay(force = false) {
  if (!overlayWin) return;
  const S = settings.get().overlay;
  const fg = helper.last?.fg;
  let display = screen.getPrimaryDisplay();
  if (state.target && fg && fg.w > 0 && !state.demo) {
    display = screen.getDisplayMatching(screen.screenToDipRect(null, { x: fg.x, y: fg.y, width: fg.w, height: fg.h }));
  }
  const b = display.bounds;
  const w = Math.ceil(state.contentSize.w), h = Math.ceil(state.contentSize.h);
  // The renderer pads the panel by PANEL_MARGIN (room for glow + entrance animation); offsets are
  // measured from the panel's visible edge, so pull the window back by that padding.
  const inset = PANEL_MARGIN * S.scale;
  const [v, hz] = S.position.split('-');
  const x = Math.round(hz === 'left' ? b.x + S.offsetX - inset : hz === 'right' ? b.x + b.width - w - S.offsetX + inset : b.x + (b.width - w) / 2);
  const y = Math.round(v === 'top' ? b.y + S.offsetY - inset : b.y + b.height - h - S.offsetY + inset);
  const nb = { x, y, width: w, height: h };
  const lb = state.lastBounds;
  if (force || !lb || lb.x !== x || lb.y !== y || lb.width !== w || lb.height !== h) {
    overlayWin.setBounds(nb);
    state.lastBounds = nb;
  }
}

function startLoop() {
  clearInterval(loopTimer);
  loopTimer = setInterval(computeFrame, Math.max(100, settings.get().overlay.updateMs));
  clearInterval(state.houseTimer);
  state.houseTimer = setInterval(() => {
    pm.housekeeping();
    // Some games re-assert topmost on focus changes; take it back.
    if (overlayWin && state.shown) overlayWin.setAlwaysOnTop(true, 'screen-saver');
  }, 3000);
}

// ------------------------------------------------------------------ PresentMon
function vendorDirs() {
  return [path.join(process.resourcesPath || '', 'vendor'), path.join(app.getAppPath(), 'vendor'), path.join(app.getPath('userData'), 'vendor')];
}

function startPresentMon() {
  const S = settings.get();
  pm.start(PresentMon.locate(S.presentmon.path, vendorDirs()), S.presentmon.extraArgs);
}

async function downloadPresentMon() {
  const res = await net.fetch('https://api.github.com/repos/GameTechDev/PresentMon/releases/latest', {
    headers: { 'User-Agent': 'SuperLay', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const rel = await res.json();
  const assets = rel.assets || [];
  const asset = assets.find((a) => /^PresentMon-[\d.]+-x64\.exe$/i.test(a.name))
    || assets.find((a) => /x64\.exe$/i.test(a.name) && !/service|setup|install/i.test(a.name));
  if (!asset) throw new Error('No console PresentMon build in the latest release.');
  const bin = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'SuperLay' } });
  if (!bin.ok) throw new Error(`Download failed (${bin.status})`);
  const dir = path.join(app.getPath('userData'), 'vendor');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset.name);
  fs.writeFileSync(dest, Buffer.from(await bin.arrayBuffer()));
  settings.set({ presentmon: { path: dest } });
  startPresentMon();
  return { path: dest, version: rel.tag_name };
}

function relaunchElevated() {
  const args = process.argv.slice(1).map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  const cmd = `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}'${args ? ` -ArgumentList ${args}` : ''} -Verb RunAs`;
  app.releaseSingleInstanceLock();
  const p = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true });
  p.on('exit', (code) => {
    if (code === 0) app.quit();
    else app.requestSingleInstanceLock(); // user declined UAC
  });
}

// ------------------------------------------------------------------ hotkeys, tray
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const H = settings.get().hotkeys;
  hotkeyFailures = [];
  const reg = (acc, fn, name) => {
    if (!acc) return;
    try { if (!globalShortcut.register(acc, fn)) hotkeyFailures.push(name); } catch { hotkeyFailures.push(name); }
  };
  reg(H.toggleOverlay, () => { state.userVisible = !state.userVisible; refreshTray(); }, 'toggleOverlay');
  reg(H.cycleLayout, () => {
    const cur = settings.get().overlay.layout;
    settings.set({ overlay: { layout: LAYOUTS[(LAYOUTS.indexOf(cur) + 1) % LAYOUTS.length] } });
  }, 'cycleLayout');
  reg(H.openSettings, openSettings, 'openSettings');
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'SuperLay', enabled: false },
    { type: 'separator' },
    { label: 'Show overlay', type: 'checkbox', checked: state.userVisible, click: (i) => { state.userVisible = i.checked; } },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function sendSettings(channel, payload) { if (settingsWin) settingsWin.webContents.send(channel, payload); }

// ------------------------------------------------------------------ IPC
function diagnostics() {
  const t = state.target;
  const tick = helper.last || {};
  const procs = [...pm.activeProcesses(1500).values()].sort((a, b) => b.rate - a.rate).slice(0, 8);
  return {
    presentmon: pm.status,
    helper: state.helperStatus,
    admin: !!tick.admin,
    perfLogUser: !!tick.perfLogUser,
    gpu: tick.gpu || null,
    cpu: tick.cpu,
    foreground: tick.fg || null,
    hotkeyFailures,
    processes: procs,
    target: t ? {
      pid: t.pid, app: t.app, exe: t.info?.path, name: t.entry?.name || t.game?.name, key: t.game?.key, disabled: t.disabled,
      detection: t.detection,
      stats: state.lastStats && { ...state.lastStats, frames: undefined },
    } : null,
  };
}

function setupIpc() {
  ipcMain.on('overlay:size', (_e, s) => {
    if (!s || !(s.w > 0) || !(s.h > 0)) return;
    state.contentSize = { w: Math.min(1600, s.w), h: Math.min(1200, s.h) };
    if (state.shown) placeOverlay();
  });

  ipcMain.handle('settings:get', () => ({
    settings: settings.get(),
    defaults: DEFAULTS,
    presets: Object.fromEntries(Object.keys(PRESETS).map((k) => [k, presetTheme(k)])),
    version: app.getVersion(),
  }));
  ipcMain.handle('settings:set', (_e, patch) => settings.set(patch));
  ipcMain.handle('settings:reset', (_e, section) => settings.reset(section));
  ipcMain.handle('theme:preview', (_e, { mode, preset, customAccent }) => (
    mode === 'custom' ? customTheme(customAccent) : mode === 'preset' ? presetTheme(preset) : currentTheme()
  ));

  ipcMain.handle('games:list', () => themes.list().map((g) => ({ ...g, ...(settings.get().games[g.key] || {}) })));
  ipcMain.handle('games:update', (_e, key, patch) => {
    settings.set({ games: { [key]: { ...(settings.get().games[key] || {}), ...patch } } });
    if (state.target?.game?.key === key) state.target.disabled = !!settings.get().games[key].disabled;
    pushConfig();
    return true;
  });
  ipcMain.handle('games:refetch', async (_e, key) => {
    const g = themes.get(key);
    if (!g) return null;
    const entry = await themes.resolve({ key, exe: g.exe, name: g.name, steamAppId: g.appId }, { online: true, force: true });
    if (state.target?.game?.key === key) { state.target.entry = entry; pushConfig(); }
    return entry;
  });
  ipcMain.handle('games:forget', (_e, key) => { themes.forget(key); return true; });

  ipcMain.handle('diag:get', diagnostics);
  ipcMain.handle('pm:download', async () => {
    try { return { ok: true, ...(await downloadPresentMon()) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('pm:browse', async () => {
    const r = await dialog.showOpenDialog(settingsWin, { title: 'Locate PresentMon', filters: [{ name: 'PresentMon', extensions: ['exe'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.set({ presentmon: { path: r.filePaths[0] } });
    startPresentMon();
    return r.filePaths[0];
  });
  ipcMain.handle('pm:restart', () => { startPresentMon(); return true; });
  ipcMain.handle('app:relaunchAdmin', () => { relaunchElevated(); return true; });
  ipcMain.handle('app:openData', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:openUrl', (_e, url) => { if (/^https:\/\/(github\.com|store\.steampowered\.com)\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('overlay:demo', (_e, on) => { state.demo = !!on; pushConfig(); return state.demo; });
  ipcMain.handle('hotkeys:pause', (_e, paused) => { if (paused) globalShortcut.unregisterAll(); else registerHotkeys(); return hotkeyFailures; });
}

// ------------------------------------------------------------------ README screenshots (npm run shots)
async function captureShots(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  openSettings();
  const wc = settingsWin.webContents;
  await new Promise((r) => wc.once('did-finish-load', r));
  await wait(3000);
  const shot = async (name) => fs.writeFileSync(path.join(dir, `${name}.png`), (await wc.capturePage()).toPNG());
  const original = settings.get().overlay.layout;
  // Diagnostics is left out on purpose: it shows local paths and running processes.
  for (const page of ['home', 'overlay', 'metrics', 'themes', 'framegen', 'games']) {
    await wc.executeJavaScript(`document.querySelector('#nav [data-page="${page}"]').click()`);
    await wait(1500);
    await shot(page);
  }
  await wc.executeJavaScript(`document.querySelector('#nav [data-page="home"]').click()`);
  for (const layout of ['card', 'minimal']) {
    settings.set({ overlay: { layout } });
    await wait(2500);
    await shot(`home-${layout}`);
  }
  settings.set({ overlay: { layout: original } });
  await wait(300);
  app.quit();
}

// ------------------------------------------------------------------ boot
app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  const firstRun = !fs.existsSync(path.join(dataDir, 'settings.json'));
  settings = new Settings(dataDir);
  themes = new ThemeStore(dataDir);
  helper = new Helper();
  pm = new PresentMon();
  detector = new Detector(helper);

  helper.on('status', (s) => { state.helperStatus = s; });
  pm.on('status', (s) => sendSettings('pm:status', s));
  helper.start(500);
  startPresentMon();

  setupIpc();
  createOverlay();
  tray = new Tray(makeIcon(32));
  tray.setToolTip('SuperLay');
  tray.on('click', openSettings);
  refreshTray();
  registerHotkeys();
  startLoop();

  const S = settings.get();
  const shotsArg = process.argv.find((a) => a.startsWith('--shots='));
  if (!shotsArg) {
    app.setLoginItemSettings({ openAtLogin: S.general.launchAtStartup, args: ['--hidden'] });
    if (firstRun || (!S.general.startMinimized && !process.argv.includes('--hidden'))) openSettings();
  }

  settings.onChange((data, patch) => {
    if (patch.overlay?.updateMs) startLoop();
    if (patch.hotkeys) registerHotkeys();
    if (patch.presentmon) startPresentMon();
    if (patch.general && 'launchAtStartup' in patch.general) app.setLoginItemSettings({ openAtLogin: data.general.launchAtStartup, args: ['--hidden'] });
    pushConfig();
    sendSettings('settings:changed', data);
  });

  if (shotsArg) captureShots(path.resolve(shotsArg.slice(8)));
});

app.on('second-instance', openSettings);
app.on('window-all-closed', (e) => e?.preventDefault?.()); // keep running in the tray
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  pm?.stop(true);
  helper?.stop();
});
