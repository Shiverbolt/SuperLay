'use strict';
// Music controls: talks to media.ps1, which drives Windows' current media session (Spotify, browsers, ...).
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'media.ps1').replace('app.asar', 'app.asar.unpacked');

// SourceAppUserModelId -> readable player name
function appName(id = '') {
  const s = id.toLowerCase();
  if (s.includes('spotify')) return 'Spotify';
  if (s.includes('applemusic') || s.includes('apple music')) return 'Apple Music';
  if (s.includes('zunemusic') || s.includes('mediaplayer')) return 'Media Player';
  if (s.includes('msedge')) return 'Edge';
  if (s.includes('chrome')) return 'Chrome';
  if (s.includes('firefox') || s === '308046b0af4a39cb') return 'Firefox';
  if (s.includes('zen')) return 'Zen';
  if (s.includes('brave')) return 'Brave';
  if (s.includes('opera')) return 'Opera';
  if (s.includes('vlc')) return 'VLC';
  if (s.includes('foobar')) return 'foobar2000';
  if (s.includes('tidal')) return 'TIDAL';
  if (s.includes('deezer')) return 'Deezer';
  if (s.includes('youtube')) return 'YouTube Music';
  const tail = id.split('!').pop().split('\\').pop().replace(/\.exe$/i, '');
  return tail.length > 24 ? '' : tail;
}

class Media {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.ready = false;
  }

  start() {
    if (this.proc) return;
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'ready') { this.ready = true; continue; }
        const p = this.pending.get(String(msg.id));
        if (p) { this.pending.delete(String(msg.id)); clearTimeout(p.timer); p.resolve(this.shape(msg)); }
      }
    });
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(null); }
      this.pending.clear();
    });
  }

  shape(m) {
    return {
      ok: m.ok !== false, action: m.action, active: !!m.active, fallback: !!m.fallback,
      app: appName(m.app), title: m.title || '', artist: m.artist || '', album: m.album || '',
      playing: m.status === 'Playing', status: m.status || '', error: m.error || null,
    };
  }

  request(action) {
    this.start();
    const id = `m${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, 8000);
      this.pending.set(id, { resolve, timer });
      this.proc.stdin.write(`${id} ${action}\n`);
    });
  }

  playPause() { return this.request('playpause'); }
  next() { return this.request('next'); }
  prev() { return this.request('prev'); }
  state() { return this.request('state'); }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try { p.stdin.end(); p.kill(); } catch { /* gone */ }
  }
}

module.exports = { Media, appName };
