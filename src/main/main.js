'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const { Job } = require('./job');
const { Semaphore } = require('./queue');
const tools = require('./tools');
const { runBatch, probeMedia, analyzeVideo } = require('./pipeline');
const { downloadInto } = require('./downloader');
const montage = require('./montage');
const { pathToFileURL } = require('url');

let win = null;
let runJob = null; // идущая нарезка: одновременно только одна
let montageJob = null; // идущий экспорт монтажа
let previewJob = null; // последний запрос кадра: новый отменяет старый

// Загрузки и анализ идут по номеру видео, их можно отменять по одной.
const tasks = new Map();
const downloadSlots = new Semaphore(3); // до трёх загрузок одновременно, остальные в очереди
const analysisSlots = new Semaphore(1); // анализ нагружает процессор, поэтому по одному

// Файлы, которые скачало само приложение. Только их разрешено отправлять в корзину.
const downloaded = new Set();

// Результат анализа звука по файлу: после него параметры нарезки меняются мгновенно.
const analysisCache = new Map();
const CACHE_LIMIT = 30;

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

// yt-dlp готовим один раз, а не по разу на каждую параллельную загрузку.
let ytdlpReady = null;
function getYtDlp() {
  if (!ytdlpReady) {
    ytdlpReady = tools.ensureYtDlp(app.getPath('userData')).catch((err) => {
      ytdlpReady = null;
      throw err;
    });
  }
  return ytdlpReady;
}

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 820,
    minWidth: 700,
    minHeight: 640,
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

function requireString(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`Не указан параметр: ${name}`);
  return value;
}

function requireFile(file) {
  requireString(file, 'file');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Файл не найден');
  return file;
}

// Регистрирует задачу под ключом, чтобы её можно было отменить, и снимает регистрацию в конце.
async function withTask(key, fn) {
  const job = new Job();
  tasks.set(key, job);
  try {
    return await fn(job);
  } finally {
    if (tasks.get(key) === job) tasks.delete(key);
  }
}

handle('app:defaults', async () => ({
  outDir: path.join(app.getPath('videos'), 'Clipper'),
}));

handle('dialog:video', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Выбери видео',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Видео', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'ts', 'm4v', 'wmv'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return res.canceled ? null : res.filePaths;
});

handle('dialog:folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Куда сохранять клипы',
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

handle('video:probe', async (input) => {
  requireFile(input);
  const { duration, audioStreams } = await probeMedia({ job: new Job(), ffprobePath: tools.ffprobePath(), input });
  return { duration, audioStreams, name: path.basename(input), downloaded: downloaded.has(input) };
});

// Слушает звук один раз и запоминает результат. Если он уже есть, отвечает сразу.
handle('video:analyze', async ({ id, file }) => {
  requireFile(file);
  const cached = cachedAnalysis(file);
  if (cached) return { duration: cached.duration, audioStreams: cached.audioStreams };
  return withTask(`an:${id}`, async (job) => {
    send('job:progress', { id, stage: 'analyze', value: null, label: 'В очереди на анализ' });
    const release = await analysisSlots.acquire(job);
    try {
      send('job:progress', { id, stage: 'analyze', value: 0, label: 'Слушаю звук' });
      const info = await analyzeVideo({
        job,
        ffmpegPath: tools.ffmpegPath(),
        ffprobePath: tools.ffprobePath(),
        input: file,
        onProgress: (value) => send('job:progress', { id, stage: 'analyze', value, label: 'Слушаю звук' }),
      });
      storeAnalysis(file, info);
      return { duration: info.duration, audioStreams: info.audioStreams };
    } finally {
      release();
    }
  });
});

// Несколько ссылок можно запускать сразу: параллельно идут три, остальные ждут своей очереди.
handle('video:download', async ({ id, url, outDir }) => {
  requireString(url, 'url');
  requireString(outDir, 'outDir');
  return withTask(`dl:${id}`, async (job) => {
    send('job:progress', { id, stage: 'download', value: null, label: 'В очереди' });
    const release = await downloadSlots.acquire(job);
    try {
      send('job:progress', { id, stage: 'download', value: null, label: 'Готовлю загрузчик' });
      const ytdlp = await getYtDlp();
      job.throwIfCancelled();
      const { file, title } = await downloadInto({
        job,
        tools: ytdlp,
        url,
        outDir,
        id,
        onProgress: (value) => send('job:progress', { id, stage: 'download', value, label: 'Скачиваю видео' }),
      });
      try {
        const { duration, audioStreams } = await probeMedia({ job, ffprobePath: tools.ffprobePath(), input: file });
        downloaded.add(file);
        return { file, duration, audioStreams, name: title || path.basename(file), downloaded: true };
      } catch (err) {
        if (job.cancelled) fs.rmSync(file, { force: true }); // отменили в последний момент: файл не оставляем
        throw err;
      }
    } finally {
      release();
    }
  });
});

// Отменяет загрузку или анализ конкретного видео (или обе задачи сразу).
handle('task:cancel', async (id) => {
  for (const key of [`dl:${id}`, `an:${id}`]) {
    const job = tasks.get(key);
    if (job) job.cancel();
  }
  return true;
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

handle('job:run', async ({ videos, options }) => {
  if (runJob) throw new Error('Нарезка уже идёт, дождись конца или нажми «Отмена»');
  if (!Array.isArray(videos) || videos.length === 0) throw new Error('Не выбрано видео');
  videos.forEach((v) => requireFile(v && v.file));

  const job = new Job();
  runJob = job;
  try {
    const result = await runBatch({
      job,
      ffmpegPath: tools.ffmpegPath(),
      ffprobePath: tools.ffprobePath(),
      videos: videos.map((v) => ({ id: v.id, input: v.file, analysis: cachedAnalysis(v.file) })),
      options,
      onProgress: (p) => send('job:progress', p),
    });
    result.analyses.forEach((info, i) => storeAnalysis(videos[i].file, info));
    const { analyses, ...rest } = result; // сам анализ в интерфейс не отдаём: он большой и ему там нечего делать
    return rest;
  } finally {
    if (runJob === job) runJob = null;
  }
});

handle('job:cancel', async () => {
  if (runJob) runJob.cancel();
  return true;
});

// ---- Монтаж ----

const MEDIA_FILTERS = {
  video: [{ name: 'Видео', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'ts', 'm4v', 'wmv'] }],
  audio: [{ name: 'Музыка', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] }],
  background: [
    { name: 'Картинка или видео', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'mp4', 'mov', 'webm', 'mkv'] },
  ],
};

handle('dialog:media', async ({ kind, multi }) => {
  const filters = MEDIA_FILTERS[kind] || MEDIA_FILTERS.video;
  const res = await dialog.showOpenDialog(win, {
    title: 'Выбери файл',
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [...filters, { name: 'Все файлы', extensions: ['*'] }],
  });
  if (res.canceled) return null;
  return multi ? res.filePaths : res.filePaths[0];
});

handle('dialog:save', async (defaultName) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Сохранить ролик',
    defaultPath: path.join(app.getPath('videos'), typeof defaultName === 'string' && defaultName ? defaultName : 'montage.mp4'),
    filters: [{ name: 'MP4', extensions: ['mp4'] }],
  });
  if (res.canceled || !res.filePath) return null;
  return /\.mp4$/i.test(res.filePath) ? res.filePath : res.filePath + '.mp4';
});

handle('montage:caps', async () => montage.probeCapabilities({ job: new Job(), ffmpegPath: tools.ffmpegPath() }));

// Сведения о файле для монтажа плюс адрес, по которому окно проигрывает его само.
handle('montage:info', async (file) => {
  requireFile(file);
  const info = await montage.probeFile({ job: new Job(), ffprobePath: tools.ffprobePath(), file });
  return { ...info, name: path.basename(file), url: pathToFileURL(file).href };
});

handle('montage:preview', async ({ project, index, at }) => {
  if (previewJob) previewJob.cancel();
  const job = new Job();
  previewJob = job;
  try {
    return await montage.previewFrame({
      job, ffmpegPath: tools.ffmpegPath(), ffprobePath: tools.ffprobePath(), rawProject: project, index, at,
    });
  } finally {
    if (previewJob === job) previewJob = null;
  }
});

handle('montage:export', async ({ project, outFile }) => {
  if (montageJob) throw new Error('Монтаж уже собирается');
  requireString(outFile, 'outFile');
  const job = new Job();
  montageJob = job;
  try {
    return await montage.exportProject({
      job, ffmpegPath: tools.ffmpegPath(), ffprobePath: tools.ffprobePath(), rawProject: project, outFile,
      onProgress: (value) => send('montage:progress', { value }),
    });
  } finally {
    if (montageJob === job) montageJob = null;
  }
});

handle('montage:cancel', async () => {
  if (montageJob) montageJob.cancel();
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
  if (runJob) runJob.cancel();
  if (montageJob) montageJob.cancel();
  if (previewJob) previewJob.cancel();
  for (const job of tasks.values()) job.cancel();
  if (process.platform !== 'darwin') app.quit();
});
