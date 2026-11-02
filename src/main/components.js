'use strict';
// Extra programs SuperLay relies on: what's installed, what's current, and how to install or update it.
//   PresentMon: required; downloaded from Intel's GitHub releases into SuperLay's data folder.
//   RTSS:       optional (frame limiter); installed with Windows Package Manager from Guru3D's package.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const rtss = require('./rtss');

const PM_REPO = 'GameTechDev/PresentMon';
const RTSS_WINGET_ID = 'Guru3D.RTSS';
const RTSS_PAGE = 'https://www.guru3d.com/download/rtss-rivatuner-statistics-server-download/';
const CACHE_MS = 6 * 3600 * 1000;

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

// Compare dotted versions ("2.6.0" < "2.10.1").
function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

class Components {
  /**
   * deps: { net, settings, dataDir, vendorDirs(), startPresentMon(), pmStatus(), stopPresentMon() }
   */
  constructor(deps) {
    this.d = deps;
    this.latest = { presentmon: null, rtss: null };   // { version, asset?, checkedAt }
    this.busy = {};                                    // id -> 'installing' | 'updating'
    this.lastError = {};
  }

  // ------------------------------------------------------------ PresentMon
  pmPath() {
    const { PresentMon } = require('./presentmon');
    return PresentMon.locate(this.d.settings.get().presentmon.path, this.d.vendorDirs());
  }

  static pmVersionOf(file) {
    return (path.basename(file || '').match(/PresentMon-([\d.]+)/i) || [])[1] || '';
  }

  async pmLatest(force) {
    const c = this.latest.presentmon;
    if (c && !force && Date.now() - c.checkedAt < CACHE_MS) return c;
    try {
      const res = await this.d.net.fetch(`https://api.github.com/repos/${PM_REPO}/releases/latest`, {
        headers: { 'User-Agent': 'SuperLay', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const rel = await res.json();
      const assets = rel.assets || [];
      const asset = assets.find((a) => /^PresentMon-[\d.]+-x64\.exe$/i.test(a.name))
        || assets.find((a) => /x64\.exe$/i.test(a.name) && !/service|setup|install/i.test(a.name));
      this.latest.presentmon = { version: (rel.tag_name || '').replace(/^v/i, ''), asset, checkedAt: Date.now() };
    } catch (e) {
      this.latest.presentmon = { version: '', error: e.message, checkedAt: Date.now() };
    }
    return this.latest.presentmon;
  }

  async pmInstall() {
    const latest = await this.pmLatest(true);
    if (!latest.asset) throw new Error(latest.error || 'No console PresentMon build in the latest release.');
    const bin = await this.d.net.fetch(latest.asset.browser_download_url, { headers: { 'User-Agent': 'SuperLay' } });
    if (!bin.ok) throw new Error(`Download failed (${bin.status})`);
    const dir = path.join(this.d.dataDir, 'vendor');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, latest.asset.name);
    fs.writeFileSync(dest + '.part', Buffer.from(await bin.arrayBuffer()));
    const old = this.pmPath();
    this.d.stopPresentMon();
    // The old process may take a moment to release the file it's replacing.
    for (let i = 0; ; i++) {
      try { fs.renameSync(dest + '.part', dest); break; } catch (e) {
        if (i >= 20) throw e;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    this.d.settings.set({ presentmon: { path: dest } });   // restarts capture via the settings listener
    // Remove the build we replaced, but only if it's one SuperLay downloaded itself.
    if (old && old !== dest && path.dirname(old) === dir) { try { fs.unlinkSync(old); } catch { /* in use: leave it */ } }
    return { version: latest.version, path: dest };
  }

  // ------------------------------------------------------------ RTSS
  async hasWinget() {
    if (this._winget !== undefined) return this._winget;
    const r = await run('winget', ['--version'], 15000);
    this._winget = !r.err && /^v?\d/.test(r.stdout.trim());
    return this._winget;
  }

  async rtssLatest(force) {
    const c = this.latest.rtss;
    if (c && !force && Date.now() - c.checkedAt < CACHE_MS) return c;
    if (!(await this.hasWinget())) return (this.latest.rtss = { version: '', checkedAt: Date.now() });
    const r = await run('winget', ['show', '--id', RTSS_WINGET_ID, '--exact', '--accept-source-agreements', '--disable-interactivity'], 60000);
    const version = (r.stdout.match(/^Version:\s*([\d.]+)/m) || [])[1] || '';
    this.latest.rtss = { version, checkedAt: Date.now(), error: version ? null : 'winget lookup failed' };
    return this.latest.rtss;
  }

  /** install or upgrade through winget; Guru3D's installer raises its own UAC prompt. */
  async rtssInstall(upgrade) {
    if (!(await this.hasWinget())) throw new Error('Windows Package Manager (winget) is not available.');
    const args = [upgrade ? 'upgrade' : 'install', '--id', RTSS_WINGET_ID, '--exact', '--silent',
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
    const r = await run('winget', args, 15 * 60 * 1000);
    const install = await rtss.locate();
    if (!install) {
      const out = `${r.stdout}\n${r.stderr}`;
      if (/cancel|1602|declined/i.test(out)) throw new Error('Installation was cancelled.');
      const last = out.trim().split(/\r?\n/).filter((l) => l.trim() && !/^[\s\-\\|/█▒]+$/.test(l)).pop();
      throw new Error(last || 'RTSS installation failed.');
    }
    return { version: install.version };
  }

  async rtssStart() {
    const install = await rtss.locate();
    if (!install) throw new Error('RTSS is not installed.');
    // RTSS asks for admin itself; ShellExecute handles the prompt.
    const err = await this.d.shell.openPath(path.join(install.dir, 'RTSS.exe'));
    if (err) throw new Error(err);
    return {};
  }

  // ------------------------------------------------------------ status + actions
  async status({ checkUpdates = false } = {}) {
    const pmFile = this.pmPath();
    const pmVer = Components.pmVersionOf(pmFile);
    const pmLatest = checkUpdates ? await this.pmLatest(false) : this.latest.presentmon;
    const pmState = this.d.pmStatus();

    const rInstall = await rtss.locate();
    const rRunning = rInstall ? await rtss.isRunning() : false;
    const rLatest = checkUpdates ? await this.rtssLatest(false) : this.latest.rtss;
    const winget = await this.hasWinget();

    return [
      {
        id: 'presentmon',
        name: 'PresentMon',
        by: 'Intel · open source (MIT)',
        role: 'Captures every frame that reaches the display, including generated frames. Needed for FPS, frame times and frame-generation reporting.',
        required: true,
        installed: !!pmFile,
        version: pmVer,
        latest: pmLatest?.version || '',
        updateAvailable: !!(pmFile && pmVer && pmLatest?.version && newer(pmLatest.version, pmVer)),
        running: pmState.state === 'running',
        state: pmState.state,
        message: pmState.message,
        path: pmFile || '',
        source: `Downloaded from github.com/${PM_REPO} into SuperLay's data folder.`,
        busy: this.busy.presentmon || null,
        error: this.lastError.presentmon || null,
        canInstall: true,
      },
      {
        id: 'rtss',
        name: 'RivaTuner Statistics Server',
        by: 'Unwinder / Guru3D · freeware',
        role: 'Limits frame rate inside the game. Optional: needed for the frame limiter.',
        required: false,
        installed: !!rInstall,
        version: rInstall?.version || '',
        latest: rLatest?.version || '',
        updateAvailable: !!(rInstall?.version && rLatest?.version && newer(rLatest.version, rInstall.version)),
        running: rRunning,
        state: !rInstall ? 'missing' : rRunning ? 'running' : 'stopped',
        path: rInstall?.dir || '',
        source: winget
          ? 'Installed with Windows Package Manager from Guru3D\'s official package (checksum-verified). Installing accepts RTSS\'s freeware licence.'
          : 'Windows Package Manager isn\'t available, so SuperLay opens Guru3D\'s download page instead.',
        busy: this.busy.rtss || null,
        error: this.lastError.rtss || null,
        canInstall: winget,
        page: RTSS_PAGE,
      },
      this.optiCard(checkUpdates ? await this.d.opti.latest(false) : this.d.opti.latestInfo),
    ];
  }

  optiCard(latest) {
    const o = this.d.opti;
    o.loadManifest();
    const cached = o.cachedPackage();
    const games = Object.keys(o.installs).length;
    return {
      id: 'optiscaler',
      name: 'OptiScaler',
      by: 'OptiScaler team · open source (GPL-3.0) · not affiliated with SuperLay',
      role: 'Swaps the upscaler a game uses: for example DLSS or XeSS inputs to FSR 4 on Radeon. Optional. Installed per game from the OptiScaler page.',
      required: false,
      installed: !!cached,
      version: cached?.version || '',
      latest: latest?.version || '',
      updateAvailable: !!(cached && latest?.version && newer(latest.version, cached.version)),
      running: false,
      state: cached ? 'downloaded' : 'missing',
      inUse: games,
      path: cached?.dir || '',
      source: 'Official releases from github.com/optiscaler/OptiScaler. Problems with SuperLay\'s installer belong in SuperLay\'s issues, not OptiScaler\'s.',
      busy: o.busy.package || null,
      error: null,
      canInstall: true,
      manage: true,
    };
  }

  async act(id, action) {
    if (this.busy[id]) return { ok: false, message: 'Already in progress.' };
    const jobs = {
      presentmon: { install: () => this.pmInstall(), update: () => this.pmInstall() },
      rtss: {
        install: () => this.rtssInstall(false),
        update: () => this.rtssInstall(true),
        start: () => this.rtssStart(),
        page: () => this.d.shell.openExternal(RTSS_PAGE).then(() => ({})),
      },
    };
    const job = jobs[id]?.[action];
    if (!job) return { ok: false, message: 'Unknown action.' };
    this.busy[id] = action === 'update' ? 'updating' : action === 'install' ? 'installing' : action;
    delete this.lastError[id];
    try {
      const res = await job();
      if (action === 'install' || action === 'update') this.latest[id] = null; // re-check versions next time
      return { ok: true, ...res };
    } catch (e) {
      this.lastError[id] = e.message;
      return { ok: false, message: e.message };
    } finally {
      delete this.busy[id];
    }
  }
}

module.exports = { Components, newer };
