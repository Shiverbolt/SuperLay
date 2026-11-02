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
  for (let k = 0; k < 4; k++) s = pm.stats(100, hint);
  assert.strictEqual(s.fg.active, false, 'should not trust a single window');
  s = pm.stats(100, hint);
  assert.strictEqual(s.fg.source, 'cadence');
  near(s.renderedFps, 80, 1, 'rendered');
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

console.log(`\n${passed} passed`);
