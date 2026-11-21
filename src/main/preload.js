'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// В интерфейс отдаём только узкий набор действий.
contextBridge.exposeInMainWorld('clipper', {
  defaults: () => ipcRenderer.invoke('app:defaults'),
  pickVideo: () => ipcRenderer.invoke('dialog:video'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  probe: (input) => ipcRenderer.invoke('video:probe', input),
  trash: (file) => ipcRenderer.invoke('video:trash', file),
  download: (url, outDir) => ipcRenderer.invoke('video:download', { url, outDir }),
  run: (options) => ipcRenderer.invoke('job:run', options),
  cancel: () => ipcRenderer.invoke('job:cancel'),
  show: (target) => ipcRenderer.invoke('shell:show', target),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },
});
