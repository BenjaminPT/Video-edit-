'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// Внутри asar бинарники запустить нельзя: берём распакованную копию.
function unpacked(p) {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function ffmpegPath() {
  return unpacked(require('ffmpeg-static'));
}

function ffprobePath() {
  return unpacked(require('ffprobe-static').path);
}

const exe = process.platform === 'win32' ? '.exe' : '';

// yt-dlp и копии ffmpeg/ffprobe лежат рядом в одной папке данных приложения:
// yt-dlp ищет ffprobe там же, где ffmpeg.
function toolsDir(userDataDir) {
  const dir = path.join(userDataDir, 'tools');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyIfMissing(src, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) return;
  fs.copyFileSync(src, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
}

const YTDLP_ASSET = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: 'yt-dlp_linux',
};

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error('Слишком много перенаправлений при загрузке yt-dlp'));
      return;
    }
    https
      .get(url, { headers: { 'User-Agent': 'clipper-app' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          download(next, dest, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Не удалось скачать yt-dlp (HTTP ${res.statusCode})`));
          return;
        }
        const tmp = dest + '.part';
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            fs.renameSync(tmp, dest);
            resolve();
          });
        });
        out.on('error', reject);
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

// Готовит папку с инструментами и возвращает путь к yt-dlp.
async function ensureYtDlp(userDataDir) {
  const dir = toolsDir(userDataDir);
  copyIfMissing(ffmpegPath(), path.join(dir, 'ffmpeg' + exe));
  copyIfMissing(ffprobePath(), path.join(dir, 'ffprobe' + exe));

  const asset = YTDLP_ASSET[process.platform];
  if (!asset) throw new Error('Загрузка по ссылке не поддерживается на этой системе');
  const ytdlp = path.join(dir, 'yt-dlp' + exe);
  const exists = fs.existsSync(ytdlp);
  const stale = exists && Date.now() - fs.statSync(ytdlp).mtimeMs > WEEK_MS;

  if (!exists || stale) {
    try {
      await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, ytdlp);
      if (process.platform !== 'win32') fs.chmodSync(ytdlp, 0o755);
    } catch (err) {
      // Старая копия лучше, чем ничего.
      if (!exists) throw err;
    }
  }
  return { ytdlp, dir };
}

module.exports = { ffmpegPath, ffprobePath, ensureYtDlp, unpacked };
