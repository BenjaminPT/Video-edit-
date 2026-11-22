'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const { Job } = require('./job');
const tools = require('./tools');
const { runPipeline, probeMedia, analyzeVideo } = require('./pipeline');
const { downloadVideo } = require('./downloader');

let win = null;
let currentJob = null;
// Файлы, которые скачало само приложение. Только их разрешено отправлять в корзину.
const downloaded = new Set();
// Результат анализа звука по файлу: после него параметры нарезки меняются мгновенно.
const analysisCache = new Map();
const CACHE_LIMIT = 5;

function cacheKey(file) {
  const st = fs.statSync(file);
  return `${file}|${st.size}|${Math.round(st.mtimeMs)}`;
}

function cachedAnalysis(file) {
  try {
    return analysisCache.get(cacheKey(file));
  } catch (_) {
    return undefined;
  }
}

function storeAnalysis(file, analysis) {
  const key = cacheKey(file);
  analysisCache.delete(key);
  analysisCache.set(key, analysis);
  while (analysisCache.size > CACHE_LIMIT) analysisCache.delete(analysisCache.keys().next().value);
}

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

// Анализ звука идёт в фоне и уступает место любой новой работе (скачать, нарезать).
function startJob(kind) {
  if (currentJob && currentJob.kind === 'analyze') currentJob.cancel();
  else if (currentJob) throw new Error('Уже идёт работа, дождись конца или нажми «Отмена»');
  currentJob = new Job();
  currentJob.kind = kind;
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
  const { duration, audioStreams } = await probeMedia({ job: new Job(), ffprobePath: tools.ffprobePath(), input });
  return { duration, audioStreams, name: path.basename(input), downloaded: downloaded.has(input) };
});

// Слушает звук один раз и запоминает результат. Если он уже есть, отвечает сразу.
handle('video:analyze', async (input) => {
  requireString(input, 'input');
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error('Файл не найден');
  const cached = cachedAnalysis(input);
  if (cached) return { duration: cached.duration, audioStreams: cached.audioStreams };
  const job = startJob('analyze');
  try {
    send('job:progress', { stage: 'analyze', value: 0, label: 'Слушаю звук' });
    const info = await analyzeVideo({
      job,
      ffmpegPath: tools.ffmpegPath(),
      ffprobePath: tools.ffprobePath(),
      input,
      onProgress: (value) => send('job:progress', { stage: 'analyze', value, label: 'Слушаю звук' }),
    });
    storeAnalysis(input, info);
    return { duration: info.duration, audioStreams: info.audioStreams };
  } finally {
    endJob(job);
  }
});

// Убрать видео из приложения можно всегда (это делает интерфейс сам).
// Этот обработчик нужен только для файла на диске и только для скачанного приложением:
// оригиналы пользователя мы не трогаем. Файл уходит в корзину, а не стирается.
handle('video:trash', async (file) => {
  requireString(file, 'file');
  if (!downloaded.has(file)) throw new Error('Приложение удаляет только те файлы, которые скачало само');
  if (fs.existsSync(file)) await shell.trashItem(file);
  downloaded.delete(file);
  return true;
});

handle('video:download', async ({ url, outDir }) => {
  requireString(url, 'url');
  requireString(outDir, 'outDir');
  const job = startJob('download');
  try {
    send('job:progress', { stage: 'download', value: 0, label: 'Готовлю загрузчик' });
    const ytdlp = await tools.ensureYtDlp(app.getPath('userData'));
    const { file, title } = await downloadVideo({
      job,
      tools: ytdlp,
      url,
      outDir,
      onProgress: (value) => send('job:progress', { stage: 'download', value, label: 'Скачиваю видео' }),
    });
    const { duration, audioStreams } = await probeMedia({ job, ffprobePath: tools.ffprobePath(), input: file });
    downloaded.add(file);
    return { file, duration, audioStreams, name: title || path.basename(file), downloaded: true };
  } finally {
    endJob(job);
  }
});

handle('job:run', async (options) => {
  const job = startJob('run');
  try {
    const input = options && options.input;
    const exists = typeof input === 'string' && fs.existsSync(input);
    const { analysis, ...result } = await runPipeline({
      job,
      ffmpegPath: tools.ffmpegPath(),
      ffprobePath: tools.ffprobePath(),
      options,
      analysis: exists ? cachedAnalysis(input) : undefined,
      onProgress: (p) => send('job:progress', p),
    });
    if (exists && analysis) storeAnalysis(input, analysis);
    return result; // сам анализ в интерфейс не отдаём: он большой и ему там нечего делать
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
