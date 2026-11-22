'use strict';

const fs = require('fs');
const path = require('path');

const pad = (n, w = 2) => String(n).padStart(w, '0');
const MAX_TRACKS = 4;

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

function lastLines(text, n = 3) {
  return text.trim().split('\n').filter(Boolean).slice(-n).join(' | ');
}

/**
 * Аргументы ffmpeg для одного клипа.
 *
 * Звук: берём ВСЕ дорожки и сводим в одну (у записей стримов голос и игра бывают
 * на разных дорожках), а aresample выравнивает провалы во времени, из-за которых
 * звук «пропадает» посреди клипа. Звук всегда перекодируется, даже в быстром режиме.
 *
 * variant 'precise': запасной способ. Перематываем чуть раньше начала и досматриваем
 * до нужной секунды, видео перекодируется. Медленнее, зато не зависит от ключевых кадров.
 */
function buildCutArgs({ input, seg, file, fast, audioStreams, variant }) {
  const length = seg.end - seg.start;
  const precise = variant === 'precise';
  const lead = precise ? Math.min(seg.start, 3) : 0;

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(seg.start - lead), '-i', input];
  if (lead > 0) args.push('-ss', String(lead));
  args.push('-t', String(length), '-map', '0:v:0?', '-sn', '-dn');

  const tracks = Math.min(audioStreams, MAX_TRACKS);
  if (tracks <= 0) {
    args.push('-an');
  } else if (tracks === 1) {
    args.push('-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0');
  } else {
    const prep = [];
    const inputs = [];
    for (let i = 0; i < tracks; i++) {
      prep.push(`[0:a:${i}]aformat=channel_layouts=stereo,aresample=48000[a${i}]`);
      inputs.push(`[a${i}]`);
    }
    prep.push(`${inputs.join('')}amix=inputs=${tracks}:duration=longest:dropout_transition=0,aresample=async=1:first_pts=0[aout]`);
    args.push('-filter_complex', prep.join(';'), '-map', '[aout]');
  }
  if (tracks > 0) args.push('-c:a', 'aac', '-b:a', '160k');

  if (fast && !precise) {
    args.push('-c:v', 'copy', '-avoid_negative_ts', 'make_zero');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  }
  args.push('-movflags', '+faststart', file);
  return args;
}

/**
 * Проверяет звук готового клипа.
 * 'ok': звук есть на всём клипе; 'partial': заметная часть клипа тихая; 'none': звука нет.
 */
async function checkAudio({ job, ffmpegPath, file, length }) {
  let log = '';
  const { code } = await job.run(
    ffmpegPath,
    // apad дополняет звук тишиной до длины клипа: если дорожка оборвалась раньше конца,
    // недостающий хвост тоже считается тишиной.
    ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `apad=whole_dur=${length},silencedetect=n=-60dB:d=2,volumedetect`, '-f', 'null', '-'],
    { onStderr: (d) => { if (log.length < 300000) log += d.toString(); } }
  );
  // Нет аудиопотока: ffmpeg отвечает ошибкой «не из чего делать выход».
  if (code !== 0) return 'none';

  const mean = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(log);
  if (!mean || mean[1] === '-inf' || parseFloat(mean[1]) < -70) return 'none';

  let silent = 0;
  let openStart = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)(?:\s*\|\s*silence_duration:\s*([\d.]+))?/g)) {
    if (m[1] === 'start') {
      openStart = Math.max(0, parseFloat(m[2]));
    } else {
      silent += m[3] ? parseFloat(m[3]) : 0;
      openStart = null;
    }
  }
  if (openStart !== null) silent += Math.max(0, length - openStart);

  const fraction = length > 0 ? silent / length : 0;
  if (fraction >= 0.97) return 'none';
  if (fraction >= 0.4) return 'partial';
  return 'ok';
}

/**
 * Режет сегменты по очереди и проверяет звук в каждом клипе.
 * fast = true: видео без перекодирования (быстро, границы по ключевым кадрам).
 * fast = false: видео перекодируется (точнее, работает везде).
 * Если звук в клипе пропал, клип режется заново запасным способом; если и это не помогло,
 * в результате у клипа остаётся отметка audio: 'partial' или 'none'.
 */
async function cutClips({ job, ffmpegPath, input, segments, outDir, fast, audioStreams = 1, onProgress }) {
  const base = safeName(path.parse(input).name);
  const folder = uniqueDir(outDir, `${base}_clips`);
  const clips = [];

  for (let i = 0; i < segments.length; i++) {
    job.throwIfCancelled();
    const seg = segments[i];
    const file = path.join(folder, `${base}_${pad(i + 1)}_${clockForFile(seg.start)}.mp4`);
    const length = seg.end - seg.start;

    let audio = audioStreams > 0 ? 'ok' : 'none';
    for (const variant of ['normal', 'precise']) {
      const { code, stderr } = await job.run(ffmpegPath, buildCutArgs({ input, seg, file, fast, audioStreams, variant }));
      if (code !== 0) {
        throw new Error(`Не удалось вырезать клип ${i + 1}: ` + (lastLines(stderr) || 'код ' + code));
      }
      if (audioStreams === 0) break; // в исходнике звука нет, проверять нечего
      audio = await checkAudio({ job, ffmpegPath, file, length });
      if (audio === 'ok') break;
    }

    clips.push({ index: i + 1, start: seg.start, end: seg.end, file, score: seg.score, audio });
    if (onProgress) onProgress((i + 1) / segments.length, i + 1, segments.length);
  }

  const mark = { ok: '', partial: '  [звук пропадает]', none: '  [нет звука]' };
  const lines = clips.map(
    (c) => `${pad(c.index)}  ${clock(c.start)} - ${clock(c.end)}  ${path.basename(c.file)}${mark[c.audio]}`
  );
  fs.writeFileSync(path.join(folder, 'timecodes.txt'), lines.join('\n') + '\n', 'utf8');

  return { folder, clips };
}

module.exports = { cutClips, clock, buildCutArgs, checkAudio };
