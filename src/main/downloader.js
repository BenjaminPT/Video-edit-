'use strict';

const fs = require('fs');
const path = require('path');

const ANSI = /\u001b\[[0-9;]*m/g;

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

/**
 * Скачивает видео по ссылке через yt-dlp и возвращает путь к файлу.
 * Ссылка передаётся отдельным аргументом после "--", оболочка не используется.
 */
async function downloadVideo({ job, tools, url, outDir, onProgress }) {
  const safeUrl = assertHttpUrl(url);
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    '--no-playlist',
    '--windows-filenames',
    '--newline',
    '--progress',
    '--progress-template', 'CLP %(progress._percent_str)s',
    '--no-simulate',
    '--print', 'after_move:filepath',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', tools.dir,
    '-o', path.join(outDir, '%(title).100B [%(id)s].%(ext)s'),
    '--', safeUrl,
  ];

  let filePath = null;
  let buffer = '';
  const onStdout = (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(ANSI, '').trim();
      if (!line) continue;
      if (line.startsWith('CLP')) {
        const m = /([\d.]+)%/.exec(line);
        if (m && onProgress) onProgress(Math.min(1, parseFloat(m[1]) / 100));
      } else if (path.isAbsolute(line)) {
        filePath = line;
      }
    }
  };

  const { code, stderr } = await job.run(tools.ytdlp, args, { onStdout });
  if (buffer.trim() && path.isAbsolute(buffer.trim())) filePath = buffer.trim();
  if (code !== 0) {
    const reason = stderr.trim().split('\n').filter(Boolean).pop() || 'код ' + code;
    throw new Error('Не удалось скачать видео: ' + reason.replace(/^ERROR:\s*/, ''));
  }
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Видео скачалось, но файл не найден');
  }
  return filePath;
}

module.exports = { downloadVideo, assertHttpUrl };
