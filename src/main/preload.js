'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// В интерфейс отдаём только узкий набор действий.
contextBridge.exposeInMainWorld('clipper', {
  defaults: () => ipcRenderer.invoke('app:defaults'),
  pickVideos: () => ipcRenderer.invoke('dialog:video'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  probe: (input) => ipcRenderer.invoke('video:probe', input),
  analyze: (id, file) => ipcRenderer.invoke('video:analyze', { id, file }),
  download: (id, url, outDir) => ipcRenderer.invoke('video:download', { id, url, outDir }),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  trash: (file) => ipcRenderer.invoke('video:trash', file),
  run: (videos, options) => ipcRenderer.invoke('job:run', { videos, options }),
  cancel: () => ipcRenderer.invoke('job:cancel'),
  cutExtra: (folder, extra, fast) => ipcRenderer.invoke('clip:cut-extra', { folder, extra, fast }),
  pickMedia: (kind, multi) => ipcRenderer.invoke('dialog:media', { kind, multi }),
  pickSave: (name) => ipcRenderer.invoke('dialog:save', name),
  montageCaps: () => ipcRenderer.invoke('montage:caps'),
  montageInfo: (file) => ipcRenderer.invoke('montage:info', file),
  montagePreview: (project, index, at) => ipcRenderer.invoke('montage:preview', { project, index, at }),
  montageExport: (project, outFile) => ipcRenderer.invoke('montage:export', { project, outFile }),
  montageCancel: () => ipcRenderer.invoke('montage:cancel'),
  onMontageProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('montage:progress', listener);
    return () => ipcRenderer.removeListener('montage:progress', listener);
  },
  show: (target) => ipcRenderer.invoke('shell:show', target),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },
});
