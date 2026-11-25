'use strict';

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const ANSI = /\u001b\[[0-9;]*m/g;
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.ts', '.flv', '.avi']);

function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error('Это не похоже на ссылку');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Поддерживаются только ссылки http и https');
  }
  return parsed.toString();
}

// Самый свежий видеофайл, появившийся в папке после начала загрузки.
// Запасной путь на случай, если yt-dlp не напечатал имя файла внятно.
function newestVideoSince(dir, since) {
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    if (!VIDEO_EXT.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs < since - 2000) continue;
    if (!best || stat.mtimeMs > best.mtime) best = { full, mtime: stat.mtimeMs };
  }
  return best && best.full;
}

/**
 * Скачивает видео по ссылке через yt-dlp.
 * Возвращает { file, title }. Ссылка идёт отдельным аргументом после "--",
 * оболочка не используется.
 *
 * Имя файла делаем только из ASCII (id видео): название стрима может быть
 * на любом языке с эмодзи, а Windows и ffmpeg с такими путями дружат хуже.
 * Настоящее название берём отдельной строкой и показываем в интерфейсе.
 */
async function downloadVideo({ job, tools, url, outDir, onProgress }) {
  const safeUrl = assertHttpUrl(url);
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = Date.now();

  const args = [
    '--no-playlist',
    '--restrict-filenames',
    '--encoding', 'utf-8',
    '--newline',
    '--progress',
    '--progress-template', 'CLP %(progress._percent_str)s',
    '--no-simulate',
    '--print', 'after_move:TTL:%(title)s',
    '--print', 'after_move:filepath',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', tools.dir,
    '-o', path.join(outDir, '%(id)s.%(ext)s'),
    '--', safeUrl,
  ];

  let filePath = null;
  let title = null;
  const decoder = new StringDecoder('utf8'); // не рвёт многобайтные символы на границе кусков
  let buffer = '';

  const handleLine = (raw) => {
    const line = raw.replace(ANSI, '').trim();
    if (!line) return;
    if (line.startsWith('CLP')) {
      const m = /([\d.]+)%/.exec(line);
      if (m && onProgress) onProgress(Math.min(1, parseFloat(m[1]) / 100));
    } else if (line.startsWith('TTL:')) {
      title = line.slice(4).trim() || null;
    } else if (path.isAbsolute(line)) {
      filePath = line;
    }
  };

  const onStdout = (chunk) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach(handleLine);
  };

  const { code, stderr } = await job.run(tools.ytdlp, args, {
    onStdout,
    env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  handleLine(buffer + decoder.end());

  if (code !== 0) {
    const reason = stderr.trim().split('\n').filter(Boolean).pop() || 'код ' + code;
    throw new Error('Не удалось скачать видео: ' + reason.replace(/^ERROR:\s*/, ''));
  }

  if (!filePath || !fs.existsSync(filePath)) {
    filePath = newestVideoSince(outDir, startedAt);
  }
  if (!filePath) {
    throw new Error('Видео скачалось, но файл не найден в папке ' + outDir);
  }
  return { file: filePath, title };
}

/**
 * Скачивает в отдельную временную папку и только потом переносит файл в outDir.
 * Так несколько загрузок одновременно не мешают друг другу (запасной поиск файла
 * видит только свою папку), а при отмене или ошибке остатки загрузки удаляются.
 */
async function downloadInto({ job, tools, url, outDir, id, onProgress }) {
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = path.join(outDir, `.clipper-dl-${String(id).replace(/[^\w-]/g, '')}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const { file, title } = await downloadVideo({ job, tools, url, outDir: tmp, onProgress });
    const parsed = path.parse(file);
    let dest = path.join(outDir, parsed.base);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(outDir, `${parsed.name}_${n}${parsed.ext}`);
    fs.renameSync(file, dest);
    return { file: dest, title };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { downloadVideo, downloadInto, assertHttpUrl, newestVideoSince };
