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
const rtss = require('./rtss');
const { Components } = require('./components');
const { OptiScaler } = require('./optiscaler');

app.setAppUserModelId('app.superlay');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload');
const LAYOUTS = ['pill', 'card', 'minimal'];
const PANEL_MARGIN = 14; // matches --margin in overlay.css

let settings, themes, helper, pm, detector, components, opti;
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
  fpsHistory: [],        // [{ t, displayed, rendered }] for the current target, last 30 s
  rtss: { install: null, running: false, cap: null, checkedAt: 0 },
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
    overlay: S.overlay, metrics: S.metrics, stats: S.stats, theme: S.theme, framegen: S.framegen, limiter: S.limiter,
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
  state.fpsHistory = [];
  state.rtss.checkedAt = 0;
  pm.resetGraph(pid);

  // A hung or just-starting process can fail the path query; retry briefly before giving up.
  let info = (await helper.procInfo(pid)) || {};
  for (let i = 0; i < 3 && !info.path && state.target === t; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    info = (await helper.procInfo(pid)) || {};
  }
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
  // Without an exe path there's no stable identity, so don't create a game entry (it would be named
  // after a window title such as "Client (Not Responding)").
  if ((!cached || !cached.theme) && info.path) {
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
      frametimeSource: S.stats.frametimeSource,
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
  if (fps && fps.displayedFps > 0) {
    const now = Date.now();
    state.fpsHistory.push({ t: now, displayed: fps.displayedFps, rendered: fps.renderedFps });
    while (state.fpsHistory.length && state.fpsHistory[0].t < now - 30000) state.fpsHistory.shift();
  }
  refreshRtssCap();

  const inGame = !!t && !t.disabled && (!!fps || pm.status.state !== 'running');
  const visible = state.demo || (state.userVisible && (S.general.showOnlyInGames ? inGame : true));
  setOverlayShown(visible);
  if (!overlayWin || !visible) return;
  placeOverlay();

  const det = t?.detection;
  const cap = state.rtss.running && state.rtss.cap?.limit > 0 ? state.rtss.cap : null;
  overlayWin.webContents.send('overlay:frame', {
    fps,
    limiter: cap ? { limit: cap.limit, mode: cap.mode } : null,
    upscaler: det?.upscaler ? { label: det.upscaler.label, model: det.upscaler.model, confidence: det.upscaler.confidence, opti: !!det.optiscaler } : null,
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

// Installs/updates of PresentMon and RTSS live in components.js.
async function componentAct(id, action) {
  const res = await components.act(id, action);
  if (id === 'rtss') await refreshRtssStatus();
  sendSettings('components:changed');
  return res;
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

// ------------------------------------------------------------------ RTSS frame limiter
const exeOf = (t) => (t?.info?.path ? path.basename(t.info.path) : t?.app || null);

async function refreshRtssStatus() {
  state.rtss.install = await rtss.locate();
  state.rtss.running = state.rtss.install ? await rtss.isRunning() : false;
  state.rtss.checkedAt = 0;
}

/** Re-reads the current game's cap from its RTSS profile every few seconds (cheap file read). */
function refreshRtssCap(force = false) {
  const R = state.rtss;
  if (!R.install) { R.cap = null; return; }
  if (!force && Date.now() - R.checkedAt < 5000) return;
  R.checkedAt = Date.now();
  const exe = exeOf(state.target);
  R.cap = exe ? rtss.readProfile(R.install.dir, exe) : null;
}

function gameRefreshRate() {
  const fg = helper.last?.fg;
  let display = screen.getPrimaryDisplay();
  if (state.target && fg && fg.w > 0) display = screen.getDisplayMatching(screen.screenToDipRect(null, { x: fg.x, y: fg.y, width: fg.w, height: fg.h }));
  return Math.round(display.displayFrequency || 0);
}

function sustainedFps(field) {
  const v = state.fpsHistory.map((h) => h[field]).filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length < 20) return 0; // need ~5 s of data
  return v[Math.floor(v.length * 0.1)];
}

async function rtssStatus(exeOverride) {
  if (!state.rtss.install || !state.rtss.checkedStatusAt || Date.now() - state.rtss.checkedStatusAt > 5000) {
    await refreshRtssStatus();
    state.rtss.checkedStatusAt = Date.now();
  }
  const R = state.rtss;
  const exe = exeOverride || exeOf(state.target);
  const fg = state.lastStats?.fg || null;
  const driverFg = fg?.active && fg.source === 'frame-type';
  const refresh = gameRefreshRate();
  const rec = rtss.recommendCap({
    refresh, vrr: settings.get().limiter.vrr, fg,
    sustainedFps: sustainedFps(driverFg ? 'rendered' : 'displayed'),
  });
  return {
    installed: !!R.install,
    version: R.install?.version || '',
    running: R.running,
    elevated: !!helper.last?.admin,
    brokerReady: rtss.brokerReady(),
    exe,
    isCurrentGame: !!exe && exe === exeOf(state.target),
    profile: R.install && exe ? rtss.readProfile(R.install.dir, exe) : null,
    refresh,
    recommendation: rec,
    games: themes.list().filter((g) => g.exe).map((g) => ({ exe: path.basename(g.exe), name: g.name })),
  };
}

async function rtssApply(exe, limit, mode) {
  if (!state.rtss.install) await refreshRtssStatus();
  if (!state.rtss.install) return { ok: false, message: 'RTSS is not installed.' };
  if (!exe) return { ok: false, message: 'No game selected.' };
  const res = await rtss.applyCap(state.rtss.install.dir, exe, { limit: Math.max(0, +limit || 0), mode }, !!helper.last?.admin);
  refreshRtssCap(true);
  return { ...res, profile: rtss.readProfile(state.rtss.install.dir, exe) };
}

// ------------------------------------------------------------------ OptiScaler
function gpuVendor() {
  const n = helper.last?.gpu?.name || '';
  return /nvidia|geforce|rtx|gtx/i.test(n) ? 'nvidia' : /amd|radeon/i.test(n) ? 'amd' : /intel|arc/i.test(n) ? 'intel' : '';
}

function knownGames() {
  const list = themes.list().filter((g) => g.exe && fs.existsSync(g.exe)).map((g) => ({ key: g.key, name: g.name, exe: g.exe, thumb: g.thumb }));
  const t = state.target;
  if (t?.game?.key && t.info?.path && !list.some((g) => g.key === t.game.key)) {
    list.unshift({ key: t.game.key, name: t.entry?.name || t.game.name, exe: t.info.path, thumb: t.entry?.thumb });
  }
  return list;
}

async function optiStatus({ checkUpdates = false } = {}) {
  const cached = opti.cachedPackage();
  const latest = checkUpdates ? await opti.latest(false) : opti.latestInfo;
  const games = await Promise.all(knownGames().map(async (g) => {
    let status;
    try { status = await opti.gameStatus(g); } catch (e) { status = { state: 'error', error: e.message }; }
    const running = state.target?.info?.path?.toLowerCase() === g.exe.toLowerCase();
    return { ...g, running, ...status, busy: opti.busy[g.key] || null };
  }));
  return {
    package: { version: cached?.version || '', latest: latest?.version || '', updateAvailable: !!(cached && latest?.version && latest.version !== cached.version), busy: opti.busy.package || null },
    vendor: gpuVendor(),
    rtssInstalled: !!state.rtss.install,
    games,
  };
}

async function optiAct(key, action, opts = {}) {
  const busyKey = action === 'download' ? 'package' : key;
  if (opti.busy[busyKey]) return { ok: false, message: 'Already in progress.' };
  opti.busy[busyKey] = action;
  sendSettings('opti:changed');
  try {
    if (action === 'download') return { ok: true, ...(await opti.downloadPackage()) };
    const game = knownGames().find((g) => g.key === key);
    if (!game) return { ok: false, message: 'Game not found.' };
    if (action === 'folder') { await shell.openPath(path.dirname(game.exe)); return { ok: true }; }
    let res;
    if (action === 'install' || action === 'update') res = await opti.install(game, { proxy: opts.proxy || 'auto', vendor: gpuVendor(), allowAntiCheat: !!opts.allowAntiCheat });
    else if (action === 'remove') res = await opti.uninstall(game);
    else return { ok: false, message: 'Unknown action.' };
    if (state.target?.game?.key === key) state.target.detection = null; // re-detect upscaler on next pass
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, message: e.message };
  } finally {
    delete opti.busy[busyKey];
    sendSettings('opti:changed');
    sendSettings('components:changed');
  }
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
  ipcMain.handle('components:status', (_e, opts) => components.status(opts || {}));
  ipcMain.handle('components:act', (_e, id, action) => (id === 'optiscaler' ? optiAct(null, 'download') : componentAct(id, action)));
  ipcMain.handle('opti:status', (_e, opts) => optiStatus(opts || {}));
  ipcMain.handle('opti:act', (_e, key, action, opts) => optiAct(key, action, opts || {}));
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
  ipcMain.handle('rtss:status', (_e, exe) => rtssStatus(exe));
  ipcMain.handle('rtss:apply', (_e, { exe, limit, mode }) => rtssApply(exe, limit, mode));
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
  for (const page of ['home', 'overlay', 'metrics', 'themes', 'framegen', 'limiter', 'optiscaler', 'components', 'games']) {
    await wc.executeJavaScript(`document.querySelector('#nav [data-page="${page}"]').click()`);
    await wait(page === 'components' || page === 'optiscaler' ? 9000 : 1500); // these check GitHub/winget for updates
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
  opti = new OptiScaler({ net, dataDir, helper });
  components = new Components({
    net, shell, settings, dataDir, opti,
    vendorDirs, pmStatus: () => pm.status, stopPresentMon: () => pm.stop(false),
  });

  helper.on('status', (s) => { state.helperStatus = s; });
  pm.on('status', (s) => sendSettings('pm:status', s));
  helper.start(500);
  startPresentMon();
  refreshRtssStatus();
  setInterval(refreshRtssStatus, 15000);

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
