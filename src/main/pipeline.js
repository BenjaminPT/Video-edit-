'use strict';

const { computeProfile, findHighlights, fixedSegments } = require('./analyzer');
const { cutClips } = require('./cutter');

const ALLOWED_LENGTHS = [20, 30, 60];
const MAX_CLIPS = 200;

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
  if (!opts || typeof opts.input !== 'string' || !opts.input) throw new Error('Не выбрано видео');
  if (typeof opts.outDir !== 'string' || !opts.outDir) throw new Error('Не выбрана папка для клипов');
  if (opts.mode !== 'fixed' && opts.mode !== 'smart') throw new Error('Неизвестный режим');
  if (!ALLOWED_LENGTHS.includes(opts.clipLen)) throw new Error('Длина клипа: 20, 30 или 60 секунд');
  const count = Number(opts.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CLIPS) {
    throw new Error(`Количество клипов: от 1 до ${MAX_CLIPS}`);
  }
  return { ...opts, count, fast: Boolean(opts.fast) };
}

/**
 * Выбор моментов и нарезка. Если анализ звука уже сделан (analysis), он не повторяется.
 * onProgress({ stage: 'analyze' | 'cut', value: 0..1, label })
 * Возвращает результат и сам анализ (его кэширует вызывающий код).
 */
async function runPipeline({ job, ffmpegPath, ffprobePath, options, analysis, onProgress }) {
  const opts = validateOptions(options);

  let info = analysis;
  if (!info) {
    if (opts.mode === 'smart') {
      onProgress({ stage: 'analyze', value: 0, label: 'Слушаю звук' });
      info = await analyzeVideo({
        job, ffmpegPath, ffprobePath, input: opts.input,
        onProgress: (v) => onProgress({ stage: 'analyze', value: v, label: 'Слушаю звук' }),
      });
    } else {
      const media = await probeMedia({ job, ffprobePath, input: opts.input });
      info = { ...media, profile: null };
    }
  }
  const { duration, audioStreams } = info;

  let segments;
  let note = '';
  if (opts.mode === 'fixed') {
    segments = fixedSegments(duration, opts.clipLen);
  } else if (!info.profile) {
    if (audioStreams === 0) {
      throw new Error('В этом видео нет звука, поэтому режим «По звуку» не работает. Выбери «Подряд».');
    }
    // Анализ ещё не делали (например, был отменён): делаем сейчас.
    onProgress({ stage: 'analyze', value: 0, label: 'Слушаю звук' });
    info = await analyzeVideo({
      job, ffmpegPath, ffprobePath, input: opts.input,
      onProgress: (v) => onProgress({ stage: 'analyze', value: v, label: 'Слушаю звук' }),
    });
    segments = findHighlights(info.profile, { clipLen: opts.clipLen, count: opts.count, duration });
  } else {
    segments = findHighlights(info.profile, { clipLen: opts.clipLen, count: opts.count, duration });
  }
  if (opts.mode === 'smart') {
    if (segments.length === 0) {
      note = 'Подходящих моментов с голосом не нашлось. Попробуй режим «Подряд».';
    } else if (segments.length < opts.count) {
      note = `Нашлось ${segments.length} из ${opts.count}: в остальных местах нет заметных реакций с голосом.`;
    }
  }

  if (segments.length === 0) {
    return { folder: null, clips: [], duration, note: note || 'Видео слишком короткое', analysis: info };
  }

  const result = await cutClips({
    job,
    ffmpegPath,
    input: opts.input,
    segments,
    outDir: opts.outDir,
    fast: opts.fast,
    audioStreams,
    onProgress: (value, done, total) =>
      onProgress({ stage: 'cut', value, label: `Режу клипы ${done} из ${total}` }),
  });

  const noSound = result.clips.filter((c) => c.audio !== 'ok').length;
  if (audioStreams === 0) {
    note = (note ? note + ' ' : '') + 'В исходном видео нет звука, клипы тоже без звука.';
  } else if (noSound > 0) {
    note = (note ? note + ' ' : '') + `В ${noSound} ${noSound === 1 ? 'клипе' : 'клипах'} звук пропадает: ${noSound === 1 ? 'он отмечен' : 'они отмечены'} в списке.`;
  }

  return { ...result, duration, audioStreams, note, analysis: info };
}

module.exports = { runPipeline, analyzeVideo, probeMedia, probeDuration, MAX_CLIPS };
