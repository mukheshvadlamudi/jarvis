// Minimal, explicit bridge: the web app gets a few desktop actions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisDesktop', {
  platform: process.platform,
  login: (agent) => ipcRenderer.invoke('jarvis:login', agent),
  openPath: (which) => ipcRenderer.invoke('jarvis:open-path', which),
  info: () => ipcRenderer.invoke('jarvis:info'),
  anywhereSettings: (patch) => ipcRenderer.invoke('jarvis:anywhere-settings', patch),
  closeAnywhere: () => ipcRenderer.invoke('jarvis:anywhere-close'),
  expandAnywhere: () => ipcRenderer.invoke('jarvis:anywhere-expand'),
  releaseAnywhereFocus: () => ipcRenderer.invoke('jarvis:anywhere-release-focus'),
  openAnywhere: (id) => ipcRenderer.invoke('jarvis:anywhere-open', id),
  pasteAnywhere: (text) => ipcRenderer.invoke('jarvis:anywhere-paste', text),
  onAnywhere: (fn) => {
    const handler = (_event, value) => fn(value);
    ipcRenderer.on('jarvis:anywhere', handler);
    return () => ipcRenderer.removeListener('jarvis:anywhere', handler);
  },
  onAnywhereActive: (fn) => {
    const handler = (_event, active) => fn(active);
    ipcRenderer.on('jarvis:anywhere-active', handler);
    return () => ipcRenderer.removeListener('jarvis:anywhere-active', handler);
  },
  onCapture: (fn) => {
    const handler = () => fn();
    ipcRenderer.on('jarvis:capture', handler);
    return () => ipcRenderer.removeListener('jarvis:capture', handler);
  },
});
