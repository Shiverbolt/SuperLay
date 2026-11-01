'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');

// helper.ps1 must live outside the asar archive for powershell.exe to read it.
const SCRIPT = path.join(__dirname, 'helper.ps1').replace('app.asar', 'app.asar.unpacked');

class Helper extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.last = null;
    this.ready = false;
  }

  start(intervalMs = 500) {
    this.intervalMs = intervalMs;
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-IntervalMs', String(intervalMs)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
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
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.onMessage(msg);
      }
    });
    let err = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = false;
      this.emit('status', { state: 'error', message: `Sensor helper exited (${code}) ${err.trim().split('\n').pop() || ''}` });
      for (const p of this.pending.values()) p.resolve(null);
      this.pending.clear();
      this.restart = setTimeout(() => this.start(this.intervalMs), 3000);
    });
  }

  onMessage(msg) {
    if (msg.type === 'ready') { this.ready = true; this.emit('status', { state: 'running', gpu: msg.gpu }); return; }
    if (msg.type === 'tick') { this.last = msg; this.emit('tick', msg); return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  request(cmd, ...args) {
    if (!this.proc) return Promise.resolve(null);
    const id = `r${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, 8000);
      this.pending.set(id, { resolve, timer });
      this.proc.stdin.write(`${cmd} ${id} ${args.join(' ')}\n`);
    });
  }

  setInterval(ms) {
    this.intervalMs = ms;
    if (this.proc) this.proc.stdin.write(`interval ${ms}\n`);
  }

  procInfo(pid) { return this.request('procinfo', pid); }
  modules(pid, pattern) { return this.request('modules', pid, pattern); }
  versions(paths) { return paths.length ? this.request('versions', paths.join('|')) : Promise.resolve({ files: [] }); }
  mapped(paths) { return paths.length ? this.request('mapped', paths.join('|')) : Promise.resolve({ files: [] }); }

  stop() {
    clearTimeout(this.restart);
    if (this.proc) { const p = this.proc; this.proc = null; try { p.stdin.end(); p.kill(); } catch { /* gone */ } }
  }
}

module.exports = { Helper };
