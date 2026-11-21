'use strict';

const fs = require('fs');
const path = require('path');

const pad = (n, w = 2) => String(n).padStart(w, '0');

function clock(sec) {
  const s = Math.round(sec);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function clockForFile(sec) {
  const s = Math.round(sec);
  return `${pad(Math.floor(s / 3600))}h${pad(Math.floor((s % 3600) / 60))}m${pad(s % 60)}s`;
}

function safeName(name) {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || 'video';
}

function uniqueDir(parent, name) {
  let dir = path.join(parent, name);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(parent, `${name}_${n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Вертикальный кадр 9:16: берём центральную полосу нужной ширины и растягиваем до 1080x1920.
// Если исходник уже уже, чем 9:16, режем сверху и снизу. Размеры чётные, как требует h264.
const VERTICAL_FILTER =
  "crop='if(gt(a,9/16),trunc(ih*9/16/2)*2,iw)':'if(gt(a,9/16),ih,trunc(iw*16/9/2)*2)'," +
  'scale=1080:1920:flags=lanczos,setsar=1';

function lastLines(text, n = 3) {
  return text.trim().split('\n').filter(Boolean).slice(-n).join(' | ');
}

/**
 * Режет сегменты по очереди.
 * fast = true: без перекодирования (мгновенно, но границы привязаны к ключевым кадрам).
 * fast = false: перекодирование h264/aac (медленнее, зато точно и работает везде).
 * vertical = true: кадр 9:16 с обрезкой краёв; требует перекодирования, поэтому fast игнорируется.
 */
async function cutClips({ job, ffmpegPath, input, segments, outDir, fast, vertical = false, onProgress }) {
  if (vertical) fast = false;
  const base = safeName(path.parse(input).name);
  const folder = uniqueDir(outDir, `${base}_clips`);
  const clips = [];

  for (let i = 0; i < segments.length; i++) {
    job.throwIfCancelled();
    const seg = segments[i];
    const file = path.join(folder, `${base}_${pad(i + 1)}_${clockForFile(seg.start)}.mp4`);
    const length = seg.end - seg.start;

    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(seg.start),
      '-i', input,
      '-t', String(length),
      '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
    ];
    if (fast) {
      args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
    } else {
      if (vertical) args.push('-vf', VERTICAL_FILTER);
      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k'
      );
    }
    args.push('-movflags', '+faststart', file);

    const { code, stderr } = await job.run(ffmpegPath, args);
    if (code !== 0) {
      throw new Error(`Не удалось вырезать клип ${i + 1}: ` + (lastLines(stderr) || 'код ' + code));
    }
    clips.push({ index: i + 1, start: seg.start, end: seg.end, file, score: seg.score });
    if (onProgress) onProgress((i + 1) / segments.length, i + 1, segments.length);
  }

  const lines = clips.map(
    (c) => `${pad(c.index)}  ${clock(c.start)} - ${clock(c.end)}  ${path.basename(c.file)}`
  );
  fs.writeFileSync(path.join(folder, 'timecodes.txt'), lines.join('\n') + '\n', 'utf8');

  return { folder, clips };
}

module.exports = { cutClips, clock, VERTICAL_FILTER };
