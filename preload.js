const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { makeBridge } = require('./core/bridge');

contextBridge.exposeInMainWorld('api', {
  selectFile: () => ipcRenderer.invoke('select-file'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  detect: (force) => ipcRenderer.invoke('convert:detect', force),
  probe: (file) => ipcRenderer.invoke('convert:probe', file),
  start: (job) => ipcRenderer.invoke('convert:start', job),
  cancel: () => ipcRenderer.invoke('convert:cancel'),
  estimate: (info, job) => ipcRenderer.invoke('convert:estimate', info, job),
  onProgress: (cb) => ipcRenderer.on('convert:progress', (e, data) => cb(data)),
  onNotice: (cb) => ipcRenderer.on('convert:notice', (e, text) => cb(text)),
  showOutput: () => ipcRenderer.invoke('show-output'),
  quit: () => ipcRenderer.send('app-quit'),
});

// Pasek okna, ustawienia, folder danych i aktualizacje — wspólne z innymi aplikacjami (Pitaya Core)
contextBridge.exposeInMainWorld('pitayaBridge', makeBridge(ipcRenderer));
