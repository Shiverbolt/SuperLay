'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('superlay', {
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  resetSettings: invoke('settings:reset'),
  previewTheme: invoke('theme:preview'),
  listGames: invoke('games:list'),
  updateGame: invoke('games:update'),
  refetchGame: invoke('games:refetch'),
  forgetGame: invoke('games:forget'),
  diagnostics: invoke('diag:get'),
  componentsStatus: invoke('components:status'),
  componentAct: invoke('components:act'),
  browsePresentMon: invoke('pm:browse'),
  restartPresentMon: invoke('pm:restart'),
  relaunchAdmin: invoke('app:relaunchAdmin'),
  openData: invoke('app:openData'),
  openUrl: invoke('app:openUrl'),
  setDemo: invoke('overlay:demo'),
  pauseHotkeys: invoke('hotkeys:pause'),
  rtssStatus: invoke('rtss:status'),
  rtssApply: invoke('rtss:apply'),
  on: (ch, fn) => {
    if (!['settings:changed', 'games:changed', 'pm:status', 'components:changed'].includes(ch)) return;
    ipcRenderer.on(ch, (_e, d) => fn(d));
  },
});
