'use strict';

const path = require('path');
const { computeProfile, findHighlights, rankCandidates, pickTop, fixedSegments } = require('./analyzer');
const { cutClips, cutPlan, clockForFile, safeName, uniqueDir, pad } = require('./cutter');

const ALLOWED_LENGTHS = [20, 30, 60];
const MAX_CLIPS = 200;
const MODES = ['top', 'smart', 'fixed'];

/** Длительность и число аудиодорожек одним вызовом ffprobe. */
async function probeMedia({ job, ffprobePath, input }) {
  let out = '';
  const { code, stderr } = await job.run(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', input],
    { onStdout: (d) => (out += d.toString()) }
  );
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch (_) {
    /* разберём ниже */
  }
  const duration = parsed && parsed.format ? parseFloat(parsed.format.duration) : NaN;
  if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Не удалось прочитать видео: ' + (stderr.trim().split('\n').pop() || 'неизвестный формат'));
  }
  const streams = (parsed && parsed.streams) || [];
  return { duration, audioStreams: streams.filter((s) => s.codec_type === 'audio').length };
}

async function probeDuration(args) {
  return (await probeMedia(args)).duration;
}

/**
 * Слушает звук видео один раз. Результат можно переиспользовать для любых параметров нарезки.
 * Возвращает { duration, audioStreams, profile }, где profile = null, если звука нет.
 */
async function analyzeVideo({ job, ffmpegPath, ffprobePath, input, onProgress }) {
  const { duration, audioStreams } = await probeMedia({ job, ffprobePath, input });
  if (audioStreams === 0) return { duration, audioStreams, profile: null };
  const profile = await computeProfile({ job, ffmpegPath, input, duration, audioStreams, onProgress });
  return { duration, audioStreams, profile };
}

function validateOptions(opts) {
  if (!opts || typeof opts !== 'object') throw new Error('Не заданы параметры нарезки');
  if (typeof opts.outDir !== 'string' || !opts.outDir) throw new Error('Не выбрана папка для клипов');
  if (!MODES.includes(opts.mode)) throw new Error('Неизвестный режим');
  if (!ALLOWED_LENGTHS.includes(opts.clipLen)) throw new Error('Длина клипа: 20, 30 или 60 секунд');
  const count = Number(opts.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CLIPS) {
    throw new Error(`Количество клипов: от 1 до ${MAX_CLIPS}`);
  }
  return { ...opts, count, fast: Boolean(opts.fast) };
}

const plural = (n, one, few, many) => {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
};

const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
};

/**
 * Нарезка одного или нескольких видео.
 *   videos: [{ id, input, analysis? }]  analysis: готовый результат analyzeVideo (кэш)
 *   options.mode:
 *     'top'   лучшие N моментов среди всех видео сразу, по рейтингу, в одну папку
 *     'smart' до N реакций из каждого видео, в папку каждого видео
 *     'fixed' всё видео подряд кусками, в папку каждого видео
 * onProgress({ stage: 'analyze' | 'cut', value: 0..1, label })
 * Возвращает { folder, clips, note, analyses } (analyses по порядку videos: их кэширует вызывающий).
 */
async function runBatch({ job, ffmpegPath, ffprobePath, videos, options, onProgress }) {
  const opts = validateOptions(options);
  if (!Array.isArray(videos) || videos.length === 0) throw new Error('Не выбрано видео');
  videos.forEach((v) => {
    if (!v || typeof v.input !== 'string' || !v.input) throw new Error('Не выбрано видео');
  });

  const needsAudio = opts.mode !== 'fixed';
  const infos = [];
  for (let v = 0; v < videos.length; v++) {
    let info = videos[v].analysis;
    const missing = !info || (needsAudio && info.audioStreams > 0 && !info.profile);
    if (missing) {
      if (needsAudio) {
        const label = videos.length > 1 ? `Слушаю звук (${v + 1} из ${videos.length})` : 'Слушаю звук';
        onProgress({ stage: 'analyze', value: v / videos.length, label });
        info = await analyzeVideo({
          job, ffmpegPath, ffprobePath, input: videos[v].input,
          onProgress: (f) => onProgress({ stage: 'analyze', value: (v + f) / videos.length, label }),
        });
      } else {
        info = { ...(await probeMedia({ job, ffprobePath, input: videos[v].input })), profile: null };
      }
    }
    infos.push(info);
  }

  const names = videos.map((v) => safeName(path.parse(v.input).name));
  const silentVideos = needsAudio ? infos.filter((i) => !i.profile) : [];
  if (needsAudio && silentVideos.length === videos.length) {
    throw new Error(
      videos.length === 1
        ? 'В этом видео нет звука, поэтому этот режим не работает. Выбери «Подряд».'
        : 'Ни в одном из выбранных видео нет звука, поэтому этот режим не работает. Выбери «Подряд».'
    );
  }

  const notes = [];
  if (silentVideos.length > 0) {
    notes.push(`${silentVideos.length} ${plural(silentVideos.length, 'видео пропущено', 'видео пропущено', 'видео пропущено')}: в нём нет звука.`);
  }

  const onCut = (value, done, total) => onProgress({ stage: 'cut', value, label: `Режу клипы ${done} из ${total}` });
  let clips = [];
  let folder = opts.outDir;

  if (opts.mode === 'top') {
    const entries = [];
    infos.forEach((info, v) => {
      if (!info.profile) return;
      for (const c of rankCandidates(info.profile, { clipLen: opts.clipLen, duration: info.duration })) {
        entries.push({ ...c, videoId: v });
      }
    });
    const top = pickTop(entries, { count: opts.count });
    if (top.length === 0) {
      return { folder: null, clips: [], note: 'Ярких моментов с голосом не нашлось. Попробуй режим «Подряд».', analyses: infos };
    }
    if (top.length < opts.count) {
      notes.push(`Нашлось ${top.length} из ${opts.count}: в остальных местах нет заметных реакций с голосом.`);
    }
    folder = uniqueDir(opts.outDir, videos.length === 1 ? `${names[0]}_top` : `Лучшие_${stamp()}`);
    const plan = top.map((t, i) => ({
      input: videos[t.videoId].input,
      seg: { start: t.start, end: t.end, score: t.score },
      audioStreams: infos[t.videoId].audioStreams,
      name: `${pad(i + 1)}_${names[t.videoId]}_${clockForFile(t.start)}.mp4`,
      meta: { rank: i + 1, tag: t.tag, video: names[t.videoId] },
    }));
    ({ clips } = await cutPlan({ job, ffmpegPath, plan, folder, fast: opts.fast, onProgress: onCut }));
  } else {
    // По видео: у каждого своя папка, а прогресс общий.
    const perVideo = infos.map((info, v) => {
      if (opts.mode === 'fixed') return fixedSegments(info.duration, opts.clipLen);
      if (!info.profile) return [];
      return findHighlights(info.profile, { clipLen: opts.clipLen, count: opts.count, duration: info.duration });
    });
    const totalClips = perVideo.reduce((sum, list) => sum + list.length, 0);
    if (totalClips === 0) {
      return {
        folder: null, clips: [], analyses: infos,
        note: opts.mode === 'smart' ? 'Подходящих моментов с голосом не нашлось. Попробуй режим «Подряд».' : 'Видео слишком короткое',
      };
    }
    if (opts.mode === 'smart') {
      const short = perVideo.filter((list, v) => infos[v].profile && list.length < opts.count).length;
      if (short > 0) {
        notes.push(
          videos.length === 1
            ? `Нашлось ${totalClips} из ${opts.count}: в остальных местах нет заметных реакций с голосом.`
            : `У ${short} ${plural(short, 'видео', 'видео', 'видео')} нашлось меньше ${opts.count} моментов: в остальных местах нет заметных реакций с голосом.`
        );
      }
    }
    let done = 0;
    const folders = [];
    for (let v = 0; v < videos.length; v++) {
      if (perVideo[v].length === 0) continue;
      const base = done;
      const res = await cutClips({
        job, ffmpegPath, input: videos[v].input, segments: perVideo[v], outDir: opts.outDir,
        fast: opts.fast, audioStreams: infos[v].audioStreams,
        onProgress: (_f, n) => onCut((base + n) / totalClips, base + n, totalClips),
      });
      done += perVideo[v].length;
      folders.push(res.folder);
      clips.push(...res.clips.map((c) => ({ ...c, video: names[v] })));
    }
    clips.forEach((c, i) => { c.index = i + 1; });
    folder = folders.length === 1 ? folders[0] : opts.outDir;
  }

  const noSound = clips.filter((c) => c.audio !== 'ok').length;
  if (infos.every((i) => i.audioStreams === 0)) {
    notes.push('В исходном видео нет звука, клипы тоже без звука.');
  } else if (noSound > 0) {
    notes.push(`В ${noSound} ${noSound === 1 ? 'клипе' : 'клипах'} звук пропадает: ${noSound === 1 ? 'он отмечен' : 'они отмечены'} в списке.`);
  }

  return { folder, clips, note: notes.join(' '), analyses: infos };
}

/** Нарезка одного видео (options.input). Оставлена для простых вызовов и тестов. */
async function runPipeline({ job, ffmpegPath, ffprobePath, options, analysis, onProgress }) {
  if (!options || typeof options.input !== 'string' || !options.input) throw new Error('Не выбрано видео');
  const result = await runBatch({
    job, ffmpegPath, ffprobePath, options, onProgress,
    videos: [{ id: '0', input: options.input, analysis }],
  });
  const info = result.analyses[0];
  return { ...result, duration: info.duration, audioStreams: info.audioStreams, analysis: info };
}

module.exports = { runPipeline, runBatch, analyzeVideo, probeMedia, probeDuration, MAX_CLIPS };
