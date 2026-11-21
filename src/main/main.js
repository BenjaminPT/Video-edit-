'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const { Job } = require('./job');
const tools = require('./tools');
const { runPipeline, probeDuration } = require('./pipeline');
const { downloadVideo } = require('./downloader');

let win = null;
let currentJob = null;

function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 760,
    minWidth: 640,
    minHeight: 620,
    backgroundColor: '#0e0e10',
    autoHideMenuBar: true,
    title: 'Clipper',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Внутри окна открывается только наш интерфейс.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('closed', () => {
    win = null;
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Любая ошибка уходит в интерфейс обычным объектом, без стека.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      if (err && err.name === 'CancelledError') return { ok: false, cancelled: true, error: 'Отменено' };
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function startJob() {
  if (currentJob) throw new Error('Уже идёт работа, дождись конца или нажми «Отмена»');
  currentJob = new Job();
  return currentJob;
}

function endJob(job) {
  if (currentJob === job) currentJob = null;
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`Не указан параметр: ${name}`);
  return value;
}

handle('app:defaults', async () => ({
  outDir: path.join(app.getPath('videos'), 'Clipper'),
}));

handle('dialog:video', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Выбери видео',
    properties: ['openFile'],
    filters: [
      { name: 'Видео', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'ts', 'm4v', 'wmv'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return res.canceled ? null : res.filePaths[0];
});

handle('dialog:folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Куда сохранять клипы',
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

handle('video:probe', async (input) => {
  requireString(input, 'input');
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error('Файл не найден');
  const job = new Job();
  const duration = await probeDuration({ job, ffprobePath: tools.ffprobePath(), input });
  return { duration, name: path.basename(input) };
});

handle('video:download', async ({ url, outDir }) => {
  requireString(url, 'url');
  requireString(outDir, 'outDir');
  const job = startJob();
  try {
    send('job:progress', { stage: 'download', value: 0, label: 'Готовлю загрузчик' });
    const ytdlp = await tools.ensureYtDlp(app.getPath('userData'));
    const file = await downloadVideo({
      job,
      tools: ytdlp,
      url,
      outDir,
      onProgress: (value) => send('job:progress', { stage: 'download', value, label: 'Скачиваю видео' }),
    });
    const duration = await probeDuration({ job, ffprobePath: tools.ffprobePath(), input: file });
    return { file, duration, name: path.basename(file) };
  } finally {
    endJob(job);
  }
});

handle('job:run', async (options) => {
  const job = startJob();
  try {
    return await runPipeline({
      job,
      ffmpegPath: tools.ffmpegPath(),
      ffprobePath: tools.ffprobePath(),
      options,
      onProgress: (p) => send('job:progress', p),
    });
  } finally {
    endJob(job);
  }
});

handle('job:cancel', async () => {
  if (currentJob) currentJob.cancel();
  return true;
});

handle('shell:show', async (target) => {
  requireString(target, 'path');
  if (!fs.existsSync(target)) throw new Error('Путь не найден');
  if (fs.statSync(target).isDirectory()) await shell.openPath(target);
  else shell.showItemInFolder(target);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (currentJob) currentJob.cancel();
  if (process.platform !== 'darwin') app.quit();
});
