'use strict';

const { computeLoudness, findHighlights, fixedSegments } = require('./analyzer');
const { cutClips } = require('./cutter');

const ALLOWED_LENGTHS = [20, 30, 60];

async function probeDuration({ job, ffprobePath, input }) {
  let out = '';
  const { code, stderr } = await job.run(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input],
    { onStdout: (d) => (out += d.toString()) }
  );
  const duration = parseFloat(out.trim());
  if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Не удалось прочитать видео: ' + (stderr.trim().split('\n').pop() || 'неизвестный формат'));
  }
  return duration;
}

function validateOptions(opts) {
  if (!opts || typeof opts.input !== 'string' || !opts.input) throw new Error('Не выбрано видео');
  if (typeof opts.outDir !== 'string' || !opts.outDir) throw new Error('Не выбрана папка для клипов');
  if (opts.mode !== 'fixed' && opts.mode !== 'smart') throw new Error('Неизвестный режим');
  if (!ALLOWED_LENGTHS.includes(opts.clipLen)) throw new Error('Длина клипа: 20, 30 или 60 секунд');
  const count = Number(opts.count);
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new Error('Количество клипов: от 1 до 60');
  const orientation = opts.orientation === undefined ? 'horizontal' : opts.orientation;
  if (orientation !== 'horizontal' && orientation !== 'vertical') throw new Error('Формат: горизонтальный или вертикальный');
  return { ...opts, count, orientation, fast: Boolean(opts.fast) };
}

/**
 * Весь процесс: длительность -> выбор моментов -> нарезка.
 * onProgress({ stage: 'analyze' | 'cut', value: 0..1, label })
 */
async function runPipeline({ job, ffmpegPath, ffprobePath, options, onProgress }) {
  const opts = validateOptions(options);
  const duration = await probeDuration({ job, ffprobePath, input: opts.input });

  let segments;
  let note = '';
  if (opts.mode === 'fixed') {
    segments = fixedSegments(duration, opts.clipLen);
  } else {
    onProgress({ stage: 'analyze', value: 0, label: 'Слушаю звук' });
    const db = await computeLoudness({
      job,
      ffmpegPath,
      input: opts.input,
      duration,
      onProgress: (v) => onProgress({ stage: 'analyze', value: v, label: 'Слушаю звук' }),
    });
    segments = findHighlights(db, { clipLen: opts.clipLen, count: opts.count, duration });
    if (segments.length === 0) {
      note = 'Ярких моментов не нашлось: звук ровный. Попробуй режим «Подряд».';
    } else if (segments.length < opts.count) {
      note = `Нашлось ${segments.length} из ${opts.count}: остальные моменты слишком тихие.`;
    }
  }

  if (segments.length === 0) {
    return { folder: null, clips: [], duration, note: note || 'Видео слишком короткое' };
  }

  const result = await cutClips({
    job,
    ffmpegPath,
    input: opts.input,
    segments,
    outDir: opts.outDir,
    fast: opts.fast,
    vertical: opts.orientation === 'vertical',
    onProgress: (value, done, total) =>
      onProgress({ stage: 'cut', value, label: `Режу клипы ${done} из ${total}` }),
  });

  return { ...result, duration, note };
}

module.exports = { runPipeline, probeDuration };
