const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['playback', 'queue', 'settings', 'auth', 'overlay', 'overlay-volume', 'toast'];

contextBridge.exposeInMainWorld('sol', {
  init: () => ipcRenderer.invoke('init'),
  setSettings: partial => ipcRenderer.invoke('settings:set', partial),
  login: clientId => ipcRenderer.invoke('auth:login', clientId),
  logout: () => ipcRenderer.invoke('auth:logout'),
  command: (name, ...args) => ipcRenderer.invoke('spotify:command', name, ...args),
  query: (name, ...args) => ipcRenderer.invoke('spotify:query', name, ...args),
  lockOverlay: locked => ipcRenderer.invoke('overlay:lock', locked),
  resetOverlay: () => ipcRenderer.invoke('overlay:reset'),
  reportOverlaySize: size => ipcRenderer.send('overlay:size', size),
  setOverlayPressing: pressing => ipcRenderer.send('overlay:pressing', pressing),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  openExternal: url => ipcRenderer.invoke('open:external', url),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  on: (channel, cb) => {
    if (!CHANNELS.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
