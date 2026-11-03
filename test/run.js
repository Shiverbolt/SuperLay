'use strict';
// Frame-statistics tests against synthetic PresentMon v2 CSV. Run: npm test
const assert = require('assert');
const { PresentMon } = require('../src/main/presentmon');

const HEADER = 'Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,FrameType,CPUStartTime,MsBetweenSimulationStart,MsPCLatency,MsBetweenPresents,MsBetweenAppStart,MsCPUBusy,MsCPUWait,MsGPULatency,MsGPUTime,MsGPUBusy,MsGPUWait,MsVideoBusy,MsAnimationError,AnimationTime,MsFlipDelay,MsAllInputToPhotonLatency,MsClickToPhotonLatency,MsUntilDisplayed,MsBetweenDisplayChange';

function row({ pid = 100, t, type = 'Application', between, display, sim = 'NA', gpu = 5, chain = '0x1' }) {
  const d = display === null ? 'NA' : display.toFixed(3);
  return `game.exe,${pid},${chain},DXGI,0,512,1,Hardware: Independent Flip,${type},${t.toFixed(3)},${sim},NA,${between.toFixed(3)},${between.toFixed(3)},1,1,1,${gpu},${gpu},0,0,0,0,0,NA,NA,${display === null ? 'NA' : '5'},${d}`;
}

function feed(pm, rows) { pm.onLine(HEADER); rows.forEach((r) => pm.onLine(row(r))); }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ≈${b}, got ${a}`);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

test('plain 144 fps: displayed = rendered, no FG', () => {
  const pm = new PresentMon();
  const ft = 1000 / 144, rows = [];
  for (let i = 0; i < 600; i++) rows.push({ t: i * ft, between: ft, display: ft });
  feed(pm, rows);
  const s = pm.stats(100);
  near(s.displayedFps, 144, 0.5, 'displayed');
  near(s.renderedFps, 144, 0.5, 'rendered');
  assert.strictEqual(s.fg.active, false);
});

test('AFMF tagged frames: displayed 2×, rendered measured', () => {
  const pm = new PresentMon();
  const ft = 1000 / 240, rows = [];
  for (let i = 0; i < 1000; i++) rows.push({ t: i * ft, type: i % 2 ? 'AMD_AFMF' : 'Application', between: i % 2 ? 0 : ft * 2, display: ft });
  feed(pm, rows);
  const s = pm.stats(100);
  near(s.displayedFps, 240, 1, 'displayed');
  near(s.renderedFps, 120, 1, 'rendered');
  assert.strictEqual(s.fg.source, 'frame-type');
  assert.strictEqual(s.fg.name, 'AFMF');
  near(s.fg.multiplier, 2, 0.05, 'multiplier');
});

test('dropped presents are not counted as displayed frames', () => {
  const pm = new PresentMon();
  const ft = 1000 / 200, rows = [];
  // 200 presents/s, every other one dropped → screen shows 100 fps
  for (let i = 0; i < 800; i++) rows.push({ t: i * ft, between: ft, display: i % 2 ? null : ft * 2 });
  feed(pm, rows);
  const s = pm.stats(100);
  near(s.displayedFps, 100, 1, 'displayed');
  near(s.presentFps, 200, 1, 'present');
});

test('in-game FG with Reflex/PCL timing', () => {
  const pm = new PresentMon();
  const ft = 1000 / 180, rows = [];
  for (let i = 0; i < 900; i++) rows.push({ t: i * ft, between: ft, display: ft, sim: i % 2 ? '0' : (ft * 2).toFixed(3) });
  feed(pm, rows);
  const s = pm.stats(100, { fgHint: { library: 'DLSS 4 FG', loaded: true } });
  near(s.renderedFps, 90, 1, 'rendered');
  assert.strictEqual(s.fg.source, 'pcl');
});

test('in-game FG via GPU cadence needs several agreeing windows', () => {
  const pm = new PresentMon();
  const ft = 1000 / 160, rows = [];
  for (let i = 0; i < 2000; i++) rows.push({ t: i * ft, between: ft, display: ft, gpu: i % 2 ? 1.2 + (i % 5) * 0.05 : 9 + (i % 7) * 0.2 });
  feed(pm, rows);
  const hint = { fgHint: { library: 'FSR 3 FG', loaded: true } };
  let s;
  for (let k = 0; k < 2; k++) s = pm.stats(100, hint);
  assert.strictEqual(s.fg.active, false, 'should not trust one or two windows');
  s = pm.stats(100, hint);           // third agreeing window
  assert.strictEqual(s.fg.source, 'cadence');
  near(s.renderedFps, 80, 1, 'rendered');
});

test('cadence: Wuthering Waves rhythm (generated frames not free) and GPU-wait fallback', () => {
  // Heavy 6.6 ms / light 3.2 ms alternating: only ~2x apart, but a strict rhythm.
  const busy = Array.from({ length: 180 }, (_, i) => (i % 2 ? 3.2 + (i % 7) * 0.05 : 6.6 + (i % 5) * 0.05));
  assert.strictEqual(PresentMon.cadenceVote(busy), 2);
  // Light scene: busy converges (no usable rhythm) but GPU wait keeps a big split.
  const flatBusy = Array.from({ length: 180 }, (_, i) => 4.8 + ((i * 7) % 5) * 0.04);
  const wait = Array.from({ length: 180 }, (_, i) => (i % 2 ? 2.5 + (i % 3) * 0.1 : 0.1));
  assert.strictEqual(PresentMon.cadenceVote(flatBusy), 1);
  assert.strictEqual(PresentMon.cadenceVote(wait, { minRatio: 3, minShare: 0.9 }), 2);
  // 3x: heavy, light, light
  const triple = Array.from({ length: 180 }, (_, i) => (i % 3 === 0 ? 8 : 1));
  assert.strictEqual(PresentMon.cadenceVote(triple), 3);
  // Irregular bimodal noise (a browser's compositor) is not frame gen
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const noise = Array.from({ length: 180 }, () => (rnd() < 0.5 ? 0.3 : 1.5));
  assert.strictEqual(PresentMon.cadenceVote(noise), 1);
});

test('FG library loaded but uniform GPU cadence → FG off', () => {
  const pm = new PresentMon();
  const ft = 1000 / 120, rows = [];
  for (let i = 0; i < 1200; i++) rows.push({ t: i * ft, between: ft, display: ft, gpu: 7 + (i % 9) * 0.1 });
  feed(pm, rows);
  let s;
  for (let k = 0; k < 6; k++) s = pm.stats(100, { fgHint: { library: 'FSR 3 FG', loaded: true } });
  assert.strictEqual(s.fg.active, false);
  near(s.renderedFps, 120, 1, 'rendered');
});

// Pattern measured in The Witcher 3 with OptiScaler FG: untagged generated frames (0 ms GPU busy) alternate with
// real frames (~7.3 ms), and Fakenvapi's Reflex markers arrive only ~3 times a second.
function witcherLike({ sims = true, until = 12000 } = {}) {
  const rows = [];
  for (let i = 0, t = 0; t < until; i++, t += 8.33) {
    const real = i % 2 === 0;
    rows.push({ t, between: 8.33, display: 8.33, gpu: real ? 7.3 : 0, sim: sims && real && i % 40 === 0 ? '16.7' : 'NA' });
  }
  return rows;
}
// Feeds rows as they'd arrive live and samples stats every 250 ms from `from` on.
function timeline(rows, from, opts) {
  const pm = new PresentMon();
  pm.onLine(HEADER);
  const out = [];
  let next = from;
  for (const r of rows) {
    pm.onLine(row(r));
    if (r.t >= next) { out.push(pm.stats(100, opts)); next += 250; }
  }
  return out;
}

test('untagged FG with sparse Reflex markers: steady ON, no flicker', () => {
  const tl = timeline(witcherLike(), 4000, { fgHint: { library: 'FSR 3 FG', loaded: true } });
  assert.ok(tl.every((s) => s.fg.active), `on in ${tl.filter((s) => s.fg.active).length}/${tl.length} updates`);
  assert.strictEqual(tl[tl.length - 1].fg.multiplier, 2);
  near(tl[tl.length - 1].renderedFps, 60, 1, 'rendered');
});

test('untagged FG without Reflex: 0 ms generated frames drive cadence detection', () => {
  const tl = timeline(witcherLike({ sims: false }), 4000, { fgHint: { library: 'FSR 3 FG', loaded: true } });
  const on = tl.filter((s) => s.fg.active);
  assert.ok(on.length >= tl.length - 5, `on in ${on.length}/${tl.length} updates`);
  assert.ok(on.every((s) => s.fg.source === 'cadence' && s.fg.multiplier === 2));
});

test('FG hysteresis: brief gaps hold, a real stop turns it off', () => {
  // FG frames for 5 s (tagged), then 4 s of plain 120 fps
  const rows = [];
  let t = 0;
  for (let i = 0; t < 5000; i++, t += 8.33) rows.push({ t, type: i % 2 ? 'Unknown' : 'Application', between: 8.33, display: 8.33 });
  for (; t < 9000; t += 8.33) rows.push({ t, between: 8.33, display: 8.33 });
  const tl = timeline(rows, 2000);
  const at = (ms) => tl[Math.round((ms - 2000) / 250)];
  assert.ok(at(4750).fg.active, 'on during FG');
  assert.ok(at(6250).fg.active, 'held while the 1 s window empties of FG frames');
  assert.ok(!at(8750).fg.active, 'off once FG has really stopped');
  let flips = 0; for (let i = 1; i < tl.length; i++) if (tl[i].fg.active !== tl[i - 1].fg.active) flips++;
  assert.strictEqual(flips, 1, 'exactly one switch');
});

test('manual multiplier', () => {
  const pm = new PresentMon();
  const ft = 1000 / 240, rows = [];
  for (let i = 0; i < 800; i++) rows.push({ t: i * ft, between: ft, display: ft });
  feed(pm, rows);
  const s = pm.stats(100, { fgHint: { library: 'DLSS 4 FG', loaded: true }, multiplierSetting: '4' });
  near(s.renderedFps, 60, 0.5, 'rendered');
  assert.strictEqual(s.fg.source, 'manual');
});

test('1% low reflects stutters', () => {
  const pm = new PresentMon();
  const rows = []; let t = 0;
  for (let i = 0; i < 2000; i++) { const v = i % 50 === 0 ? 40 : 8; t += v; rows.push({ t, between: v, display: v }); }
  feed(pm, rows);
  const s = pm.stats(100);
  near(s.low1Fps, 25, 0.5, '1% low');
});

test('picks the busiest swapchain and ignores other processes', () => {
  const pm = new PresentMon();
  const rows = [];
  for (let i = 0; i < 600; i++) {
    rows.push({ t: i * 5, between: 5, display: 5 });
    if (i % 20 === 0) rows.push({ t: i * 5, between: 100, display: 100, chain: '0x2' });
    rows.push({ pid: 200, t: i * 5 + 1, between: 16.7, display: 16.7 });
  }
  feed(pm, rows);
  near(pm.stats(100).displayedFps, 200, 1, 'game');
  assert.strictEqual(pm.activeProcesses().size, 2);
});

test('v1 CSV columns (TimeInSeconds) still parse', () => {
  const pm = new PresentMon();
  pm.onLine('Application,ProcessID,SwapChainAddress,Runtime,SyncInterval,PresentFlags,Dropped,TimeInSeconds,msInPresentAPI,msBetweenPresents,AllowsTearing,PresentMode,msUntilRenderComplete,msUntilDisplayed,msBetweenDisplayChange');
  for (let i = 0; i < 300; i++) pm.onLine(`old.exe,300,0x9,DXGI,0,0,0,${(i / 60).toFixed(5)},0.1,16.667,0,Hardware: Independent Flip,1,2,16.667`);
  near(pm.stats(300).displayedFps, 60, 0.5, 'v1');
});

test('PresentMon 2.6 CSV (TimeInMs) parses — real Forza Horizon 6 header', () => {
  const pm = new PresentMon();
  pm.onLine('Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,FrameType,TimeInMs,MsBetweenSimulationStart,MsBetweenPresents,MsBetweenDisplayChange,MsInPresentAPI,MsRenderPresentLatency,MsUntilDisplayed,CPUStartTimeInMs,MsBetweenAppStart,MsCPUBusy,MsCPUWait,MsGPULatency,MsGPUTime,MsGPUBusy,MsGPUWait,MsAnimationError,AnimationTime,MsFlipDelay,MsAllInputToPhotonLatency,MsClickToPhotonLatency');
  for (let i = 0; i < 300; i++) {
    const t = (27.943 + i * 11.11).toFixed(4);
    pm.onLine(`forzahorizon6.exe,14236,0x212264FF390,DXGI,1,0,0,Hardware Composed: Independent Flip,Application,${t},NA,11.11,11.11,0.09,2.37,5.89,${t},10.99,10.90,0.09,6.45,6.82,6.67,0.15,NA,${t},NA,NA,NA`);
  }
  const s = pm.stats(14236);
  near(s.displayedFps, 90, 0.5, 'displayed');
  assert.strictEqual(s.presentMode, 'Hardware Composed: Independent Flip');
  assert.strictEqual(pm.activeProcesses().size, 1);
});

test('pacing: steady frames ≈ 0, alternating frames show jitter', () => {
  const steady = new PresentMon();
  const rows = [];
  for (let i = 0; i < 600; i++) rows.push({ t: i * 10, between: 10, display: 10 });
  feed(steady, rows);
  near(steady.stats(100).pacingMs, 0, 0.01, 'steady');
  const uneven = new PresentMon();
  const rows2 = []; let t = 0;
  for (let i = 0; i < 600; i++) { const v = i % 2 ? 6 : 14; t += v; rows2.push({ t, between: v, display: v }); }
  feed(uneven, rows2);
  const s = uneven.stats(100);
  near(s.displayedFps, 100, 0.5, 'same average fps');
  near(s.pacingMs, 8, 0.05, 'jitter');
});

test('frame-time source: capped game is steady at present, quantized at display (Forza capture)', () => {
  // 90 fps cap on a 180 Hz display: presents every ~11.1 ms, display changes snap to 5.55 / 11.1 / 16.7 ms.
  const mk = () => {
    const pm = new PresentMon(); const rows = []; let t = 0;
    const disp = [11.11, 11.11, 5.55, 16.67, 11.11, 11.11, 16.67, 5.55];
    for (let i = 0; i < 900; i++) { t += 11.11; rows.push({ t, between: 11.11 + (i % 3 - 1) * 0.05, display: disp[i % disp.length] }); }
    feed(pm, rows); return pm;
  };
  const p = mk().stats(100, { frametimeSource: 'present' });
  const d = mk().stats(100, { frametimeSource: 'display' });
  assert.strictEqual(p.frametimeSource, 'present');
  assert.ok(p.pacingMs < 0.1, `present pacing ${p.pacingMs}`);
  assert.ok(d.pacingMs > 3, `display pacing ${d.pacingMs}`);
  near(p.low1Fps, 90, 1, 'present 1% low stays at the cap');
  near(p.displayedFps, d.displayedFps, 0.01, 'FPS is display-based either way');
});

test('frame-time source: driver FG forces display timing', () => {
  const pm = new PresentMon(); const ft = 1000 / 240, rows = [];
  for (let i = 0; i < 1000; i++) rows.push({ t: i * ft, type: i % 2 ? 'AMD_AFMF' : 'Application', between: i % 2 ? 0 : ft * 2, display: ft });
  feed(pm, rows);
  assert.strictEqual(pm.stats(100, { frametimeSource: 'present' }).frametimeSource, 'display');
});

test('component version comparison', () => {
  const { newer } = require('../src/main/components');
  assert.ok(newer('2.10.1', '2.6.0'));
  assert.ok(newer('7.3.8', '7.3.7'));
  assert.ok(!newer('2.6.0', '2.6.0'));
  assert.ok(!newer('2.6', '2.6.0'));
});

const rtss = require('../src/main/rtss');
test('RTSS profile parsing (real Forza profile shape)', () => {
  const p = rtss.parseFramerate('[OSD]\nEnableOSD=1\n[Framerate]\nLimit=5994\nLimitDenominator=100\nLimitTime=0\nSyncLimiter=1\n[Hooking]\nEnableHooking=1\n');
  near(p.limit, 59.94, 0.001, 'limit');
  assert.strictEqual(p.mode, 'front-edge');
});

test('cap recommendation: VRR, driver FG, sustained fps', () => {
  assert.strictEqual(rtss.recommendCap({ refresh: 165, vrr: true }).cap, 162);
  assert.strictEqual(rtss.recommendCap({ refresh: 144, vrr: true }).cap, 141);
  assert.strictEqual(rtss.recommendCap({ refresh: 240, vrr: true }).cap, 237);
  assert.strictEqual(rtss.recommendCap({ refresh: 60, vrr: false }).cap, 60);
  // AFMF 2× on 165 Hz: base frames capped at 81 so output stays under 162
  assert.strictEqual(rtss.recommendCap({ refresh: 165, vrr: true, fg: { active: true, multiplier: 2, source: 'frame-type', name: 'AFMF' } }).cap, 81);
  // can only hold ~97 fps → cap at 97 instead of 162
  assert.strictEqual(rtss.recommendCap({ refresh: 165, vrr: true, sustainedFps: 97.6 }).cap, 97);
});

// ---------------------------------------------------------------- OptiScaler installer (fake game + package)
const fsx = require('fs');
const osx = require('os');
const pathx = require('path');
const { OptiScaler, findAntiCheat } = require('../src/main/optiscaler');

function optiFixture() {
  const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'sl-opti-'));
  const data = pathx.join(root, 'data');
  const pkg = pathx.join(data, 'optiscaler', 'packages', '0.9.4');
  const w = (p, s) => { fsx.mkdirSync(pathx.dirname(p), { recursive: true }); fsx.writeFileSync(p, s); };
  for (const [f, s] of Object.entries({
    'OptiScaler.dll': 'OPTI', 'OptiScaler.ini': '[Spoofing]\nDxgi=auto\n', 'libxess.dll': 'XESS-OPTI', 'amd_fidelityfx_dx12.dll': 'FFX-OPTI',
    'fakenvapi.dll': 'FNV', 'fakenvapi.ini': 'x', 'D3D12_Optiscaler/D3D12Core.dll': 'D3D', 'Licenses/XeSS_LICENSE.txt': 'L',
    'setup_windows.bat': 'bat', '!! README_EXTRACT ALL FILES TO GAME FOLDER !!.txt': 'r',
  })) w(pathx.join(pkg, f), s);
  const game = pathx.join(root, 'steamapps', 'common', 'MyGame', 'Bin');
  w(pathx.join(game, 'MyGame.exe'), 'EXE');
  w(pathx.join(game, 'libxess.dll'), 'XESS-GAME');
  const origs = {};
  const helper = {
    versions: async (paths) => ({ files: paths.map((p) => ({ path: p, version: '1.0', orig: origs[pathx.basename(p).toLowerCase()] || '' })) }),
    mapped: async (paths) => ({ files: paths.map((p) => ({ path: p, state: 'idle' })) }),
  };
  const opti = new OptiScaler({ net: null, dataDir: data, helper });
  const g = { key: 'k1', name: 'MyGame', exe: pathx.join(game, 'MyGame.exe') };
  const read = (f) => fsx.readFileSync(pathx.join(game, f), 'utf8');
  const has = (f) => fsx.existsSync(pathx.join(game, f));
  return { root, game, g, opti, helper, origs, w, read, has, cleanup: () => fsx.rmSync(root, { recursive: true, force: true }) };
}

const asyncTests = [];
const atest = (name, fn) => asyncTests.push([name, fn]);

atest('OptiScaler: install backs up game files, uninstall restores exactly', async () => {
  const t = optiFixture();
  try {
    const r = await t.opti.install(t.g, { vendor: 'amd' });
    assert.strictEqual(r.proxy, 'dxgi.dll');
    assert.deepStrictEqual(r.replaced, ['libxess.dll']);
    assert.strictEqual(t.read('dxgi.dll'), 'OPTI');
    assert.strictEqual(t.read('libxess.dll'), 'XESS-OPTI');
    assert.ok(t.has('fakenvapi.dll'), 'fakenvapi installed for AMD');
    assert.ok(!t.has('setup_windows.bat') && !t.has('OptiScaler.dll'), 'setup script skipped, dll renamed');
    assert.strictEqual((await t.opti.gameStatus(t.g)).state, 'installed');
    await t.opti.uninstall(t.g);
    assert.strictEqual(t.read('libxess.dll'), 'XESS-GAME', 'original restored');
    assert.deepStrictEqual(fsx.readdirSync(t.game).sort(), ['MyGame.exe', 'libxess.dll'], 'nothing left behind');
    assert.strictEqual((await t.opti.gameStatus(t.g)).state, 'none');
  } finally { t.cleanup(); }
});

atest('OptiScaler: NVIDIA skips fakenvapi', async () => {
  const t = optiFixture();
  try { await t.opti.install(t.g, { vendor: 'nvidia' }); assert.ok(!t.has('fakenvapi.dll') && !t.has('fakenvapi.ini')); } finally { t.cleanup(); }
});

atest('OptiScaler: a game update after install wins over the backup', async () => {
  const t = optiFixture();
  try {
    await t.opti.install(t.g, { vendor: 'amd' });
    t.w(pathx.join(t.game, 'libxess.dll'), 'XESS-GAME-V2');            // game patch replaced it
    const r = await t.opti.uninstall(t.g);
    assert.strictEqual(t.read('libxess.dll'), 'XESS-GAME-V2');
    assert.deepStrictEqual(r.kept, ['libxess.dll']);
  } finally { t.cleanup(); }
});

atest('OptiScaler: Steam verify removing the proxy shows as damaged', async () => {
  const t = optiFixture();
  try {
    await t.opti.install(t.g, { vendor: 'amd' });
    fsx.rmSync(pathx.join(t.game, 'dxgi.dll'));
    assert.strictEqual((await t.opti.gameStatus(t.g)).state, 'damaged');
  } finally { t.cleanup(); }
});

atest('OptiScaler: existing dxgi.dll (ReShade) is left alone, next name used', async () => {
  const t = optiFixture();
  try {
    t.w(pathx.join(t.game, 'dxgi.dll'), 'RESHADE'); t.origs['dxgi.dll'] = 'ReShade64.dll';
    const r = await t.opti.install(t.g, { vendor: 'amd' });
    assert.strictEqual(r.proxy, 'winmm.dll');
    assert.strictEqual(t.read('dxgi.dll'), 'RESHADE');
    await assert.rejects(t.opti.install(t.g, { vendor: 'amd', proxy: 'dxgi.dll' }), /already exists/);
  } finally { t.cleanup(); }
});

atest('OptiScaler: anti-cheat blocks install unless explicitly allowed', async () => {
  const t = optiFixture();
  try {
    t.w(pathx.join(t.game, 'AntiCheatExpert', 'ACE-Base64.dll'), 'ace');   // Wuthering Waves layout
    await assert.rejects(t.opti.install(t.g, { vendor: 'amd' }), /ACE/);
    assert.ok(!t.has('dxgi.dll'));
    await t.opti.install(t.g, { vendor: 'amd', allowRisk: true });
    assert.ok(t.has('dxgi.dll'));
  } finally { t.cleanup(); }
});

atest('OptiScaler: running game blocks install; manual installs are recognised', async () => {
  const t = optiFixture();
  try {
    t.helper.mapped = async (paths) => ({ files: paths.map((p) => ({ path: p, state: 'loaded' })) });
    await assert.rejects(t.opti.install(t.g, { vendor: 'amd' }), /Close the game/);
    t.w(pathx.join(t.game, 'winmm.dll'), 'OPTI-MANUAL'); t.origs['winmm.dll'] = 'OptiScaler.dll';
    const s = await t.opti.gameStatus(t.g);
    assert.strictEqual(s.state, 'manual');
    assert.strictEqual(s.proxy, 'winmm.dll');
  } finally { t.cleanup(); }
});

test('library: picks the game exe, not launchers, redistributables or crash tools', () => {
  const { pickExe } = require('../src/main/library');
  const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'sl-lib-'));
  const mk = (rel, mb) => { const p = pathx.join(root, rel); fsx.mkdirSync(pathx.dirname(p), { recursive: true }); fsx.writeFileSync(p, Buffer.alloc(mb * 1024 * 1024)); };
  try {
    // Wuthering Waves layout: small launcher at the root, big redist, Unreal shipping exe deep down
    mk('WW/Wuthering Waves.exe', 1); mk('WW/Engine/Extras/Redist/en-us/UE4PrereqSetup_x64.exe', 39);
    mk('WW/Client/Binaries/Win64/Client-Win64-Shipping.exe', 20); mk('WW/Client/Binaries/Win64/AntiCheatExpert/ACE-Service64.exe', 3);
    assert.ok(pickExe(pathx.join(root, 'WW')).endsWith('Client-Win64-Shipping.exe'));
    // Witcher 3: launcher + crash reporter + the real exe
    mk('W3/REDprelauncher.exe', 1); mk('W3/bin/x64_dx12/crashreporter/CrashReporter.exe', 2); mk('W3/bin/x64_dx12/witcher3.exe', 12);
    assert.ok(pickExe(pathx.join(root, 'W3')).endsWith('witcher3.exe'));
    // Forza: protocol helper next to the game
    mk('FH/forzaprotocolselector.exe', 2); mk('FH/forzahorizon6.exe', 9);
    assert.ok(pickExe(pathx.join(root, 'FH')).endsWith('forzahorizon6.exe'));
    // Where Winds Meet: the game itself lives under Engine\Binaries\Win64r
    mk('WWM/Engine/Binaries/Win64r/wwm.exe', 8); mk('WWM/Engine/Binaries/Win64r/UniCrashReporter.exe', 3);
    assert.ok(pickExe(pathx.join(root, 'WWM')).endsWith('wwm.exe'));
  } finally { fsx.rmSync(root, { recursive: true, force: true }); }
});

atest('OptiScaler: online PvP (Steam) and protected processes need confirmation', async () => {
  const t = optiFixture();
  try {
    const cats = { 100: [2, 1, 36, 38], 200: [2, 38], 300: [2] };
    t.opti.d.net = { fetch: async (url) => { const id = url.match(/appids=(\d+)/)[1]; return { json: async () => ({ [id]: { data: { categories: cats[id].map((x) => ({ id: x })) } } }) }; } };
    const pvp = { ...t.g, appId: '100' };
    await assert.rejects(t.opti.install(pvp, { vendor: 'amd' }), /Online multiplayer/);
    const coop = await t.opti.risks({ ...t.g, appId: '200' }, await t.opti.scanGame(t.g.exe));
    assert.deepStrictEqual(coop.map((r) => r.level), ['warn'], 'co-op only warns');
    const solo = { ...t.g, appId: '300' };
    t.opti.markProtected(solo.exe);
    await assert.rejects(t.opti.install(solo, { vendor: 'amd' }), /Blocked inspection/);
    await t.opti.install(solo, { vendor: 'amd', allowRisk: true });
    assert.ok(t.has('dxgi.dll'));
  } finally { t.cleanup(); }
});

test('non-games: Windows, launchers and the blocklist are never games', () => {
  const { isNonGameExe } = require('../src/main/library');
  const win = process.env.SystemRoot || 'C:\\Windows';
  assert.ok(isNonGameExe(`${win}\\explorer.exe`), 'explorer (desktop window "Program Manager")');
  assert.ok(isNonGameExe('C:\\Users\\x\\AppData\\Local\\Programs\\CD Projekt Red\\REDlauncher\\REDlauncher.exe'));
  assert.ok(isNonGameExe('C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe'));
  assert.ok(isNonGameExe('C:\\Tools\\chrome.exe', ['chrome.exe']));
  assert.ok(isNonGameExe(''), 'no path');
  assert.ok(!isNonGameExe('C:\\Program Files (x86)\\Steam\\steamapps\\common\\The Witcher 3\\bin\\x64_dx12\\witcher3.exe'));
  assert.ok(!isNonGameExe('E:\\SteamLibrary\\steamapps\\common\\ForzaHorizon6\\forzahorizon6.exe'));
});

atest('OptiScaler: install records written by another SuperLay copy are picked up', async () => {
  const t = optiFixture();
  try {
    const other = new OptiScaler({ net: null, dataDir: t.opti.d.dataDir, helper: t.helper });  // e.g. the dev build
    assert.strictEqual((await t.opti.gameStatus(t.g)).state, 'none');
    await new Promise((r) => setTimeout(r, 20));
    await other.install(t.g, { vendor: 'amd' });
    const s = await t.opti.gameStatus(t.g);
    assert.strictEqual(s.state, 'installed', 'not "manual"');
    await t.opti.uninstall(t.g);
    assert.strictEqual(t.read('libxess.dll'), 'XESS-GAME');
  } finally { t.cleanup(); }
});

atest('RTSS helper: back-to-back and concurrent requests never lose contact', async () => {
  const dir = 'C:\\Program Files (x86)\\RivaTuner Statistics Server';
  if (!fsx.existsSync(pathx.join(dir, 'RTSSHooks64.dll'))) { console.log('    (skipped: RTSS not installed)'); return; }
  const rtssMod = require('../src/main/rtss');
  // elevated=true starts the helper unelevated (no UAC): it can't write RTSS's profiles, but the pipe
  // protocol is identical, and "Lost contact" is exactly the failure users saw.
  const cap = { limit: 60, mode: 'async' };
  const results = [];
  for (let i = 0; i < 8; i++) results.push(await rtssMod.applyCap(dir, 'superlay-selftest.exe', cap, true));
  results.push(...await Promise.all(Array.from({ length: 5 }, () => rtssMod.applyCap(dir, 'superlay-selftest.exe', cap, true))));
  const lost = results.filter((r) => /lost contact|did not start/i.test(r.message));
  assert.strictEqual(lost.length, 0, `${lost.length} of ${results.length} lost contact`);
});

test('anti-cheat signatures', () => {
  const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'sl-ac-'));
  try {
    fsx.mkdirSync(pathx.join(root, 'EasyAntiCheat'), { recursive: true });
    fsx.writeFileSync(pathx.join(root, 'BEService_x64.exe'), '');
    assert.deepStrictEqual(findAntiCheat(root).sort(), ['BattlEye', 'Easy Anti-Cheat']);
  } finally { fsx.rmSync(root, { recursive: true, force: true }); }
});

(async () => {
  for (const [name, fn] of asyncTests) { await fn(); passed++; console.log(`  ✓ ${name}`); }
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
