'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('superlay', {
  onConfig: (fn) => ipcRenderer.on('overlay:config', (_e, c) => fn(c)),
  onFrame: (fn) => ipcRenderer.on('overlay:frame', (_e, f) => fn(f)),
  onVisible: (fn) => ipcRenderer.on('overlay:visible', (_e, v) => fn(v)),
  onMedia: (fn) => ipcRenderer.on('overlay:media', (_e, m) => fn(m)),
  reportSize: (w, h) => ipcRenderer.send('overlay:size', { w, h }),
});
