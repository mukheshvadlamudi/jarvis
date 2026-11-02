// Minimal, explicit bridge: the web app gets a few desktop actions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisDesktop', {
  platform: process.platform,
  login: (agent) => ipcRenderer.invoke('jarvis:login', agent),
  openPath: (which) => ipcRenderer.invoke('jarvis:open-path', which),
  info: () => ipcRenderer.invoke('jarvis:info'),
  onCapture: (fn) => {
    const handler = () => fn();
    ipcRenderer.on('jarvis:capture', handler);
    return () => ipcRenderer.removeListener('jarvis:capture', handler);
  },
});
