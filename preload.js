const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFile: () => ipcRenderer.invoke('select-file'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  startConversion: (payload) => ipcRenderer.send('start-conversion', payload),
  onProgress: (cb) => ipcRenderer.on('conversion-progress', (e, data) => cb(data)),
  onDone: (cb) => ipcRenderer.on('conversion-done', (e, success) => cb(success)),
  onError: (cb) => ipcRenderer.on('conversion-error', (e, err) => cb(err)),
  showOutput: () => ipcRenderer.invoke('show-output'),
  quit: () => ipcRenderer.send('app-quit')
});

// Pasek okna i aktualizacje (wspólne z innymi aplikacjami Pitayas — patrz pitaya-ui.js)
contextBridge.exposeInMainWorld('pitayaBridge', {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  getAppInfo: () => ipcRenderer.invoke('app-info'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  applyUpdate: () => ipcRenderer.invoke('update-apply'),
  restart: () => ipcRenderer.send('update-restart'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
