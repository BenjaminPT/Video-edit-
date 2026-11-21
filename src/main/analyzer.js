'use strict';

const SAMPLE_RATE = 8000; // для поиска пиков хватает и 8 кГц моно
const BYTES_PER_SAMPLE = 2;

/**
 * Читает звук через ffmpeg и считает громкость (дБ) на каждую секунду.
 * Возвращает Float32Array: индекс = секунда видео.
 */
async function computeLoudness({ job, ffmpegPath, input, duration, onProgress }) {
  const seconds = Math.max(1, Math.ceil(duration));
  const db = new Float32Array(seconds).fill(-90);

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-f', 's16le', '-',
  ];

  let sumSq = 0;
  let inWindow = 0;
  let second = 0;
  let leftover = null;
  let lastReport = 0;

  const flush = () => {
    if (inWindow > 0 && second < seconds) {
      const mean = sumSq / inWindow; // значения в диапазоне -1..1
      db[second] = Math.max(-90, 10 * Math.log10(mean + 1e-9));
    }
    sumSq = 0;
    inWindow = 0;
    second += 1;
  };

  const onData = (chunk) => {
    let buf = chunk;
    if (leftover) {
      buf = Buffer.concat([leftover, chunk]);
      leftover = null;
    }
    const usable = buf.length - (buf.length % BYTES_PER_SAMPLE);
    if (usable !== buf.length) leftover = buf.subarray(usable);
    for (let i = 0; i < usable; i += BYTES_PER_SAMPLE) {
      const s = buf.readInt16LE(i) / 32768;
      sumSq += s * s;
      inWindow += 1;
      if (inWindow === SAMPLE_RATE) flush();
    }
    if (onProgress && second - lastReport >= 20) {
      lastReport = second;
      onProgress(Math.min(1, second / seconds));
    }
  };

  const { code, stderr } = await job.run(ffmpegPath, args, { onStdout: onData });
  if (inWindow > 0) flush();
  if (code !== 0) {
    throw new Error('ffmpeg не смог прочитать звук: ' + (stderr.trim().split('\n').pop() || 'код ' + code));
  }
  if (onProgress) onProgress(1);
  return db;
}

function median(sortedCopy) {
  const n = sortedCopy.length;
  const mid = n >> 1;
  return n % 2 ? sortedCopy[mid] : (sortedCopy[mid - 1] + sortedCopy[mid]) / 2;
}

// Скользящая медиана: "обычная" громкость вокруг каждой секунды.
function rollingMedian(values, radius) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - radius);
    const to = Math.min(values.length, i + radius + 1);
    const win = Array.from(values.subarray(from, to)).sort((a, b) => a - b);
    out[i] = median(win);
  }
  return out;
}

function movingAverage(values, radius) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - radius);
    const to = Math.min(values.length, i + radius + 1);
    let sum = 0;
    for (let j = from; j < to; j++) sum += values[j];
    out[i] = sum / (to - from);
  }
  return out;
}

function percentile(values, p) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Находит самые "громкие относительно обычного" моменты.
 * Крики и смех выделяются на фоне обычной громкости стрима,
 * поэтому сравниваем с медианой за ~2 минуты вокруг, а не с абсолютным порогом.
 */
function findHighlights(db, { clipLen, count, duration, minScoreDb = 3, preRoll = 0.4 }) {
  const total = Math.floor(duration);
  if (total < 1 || db.length === 0) return [];

  const shortTerm = movingAverage(db, 2); // ~5 секунд
  const baseline = rollingMedian(db, 60); // ~2 минуты
  const floor = percentile(db, 0.4); // тишину и тихий разговор не считаем

  const scores = new Float32Array(db.length);
  for (let i = 0; i < db.length; i++) {
    scores[i] = shortTerm[i] >= floor ? shortTerm[i] - baseline[i] : 0;
  }

  const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]);
  const picked = [];
  for (const i of order) {
    if (picked.length >= count) break;
    if (scores[i] < minScoreDb) break;
    if (picked.some((p) => Math.abs(p - i) < clipLen)) continue; // клипы не пересекаются
    picked.push(i);
  }

  const maxStart = Math.max(0, duration - clipLen);
  return picked
    .sort((a, b) => a - b)
    .map((peak) => {
      const start = Math.min(maxStart, Math.max(0, Math.round(peak - clipLen * preRoll)));
      const end = Math.min(duration, start + clipLen);
      return { start, end, peak, score: Math.round(scores[peak] * 10) / 10 };
    });
}

// Режим "кусками": подряд, без пропусков. Хвост короче 3 секунд отбрасываем.
function fixedSegments(duration, clipLen) {
  const out = [];
  for (let start = 0; start < duration; start += clipLen) {
    const end = Math.min(duration, start + clipLen);
    if (end - start >= 3) out.push({ start, end });
  }
  return out;
}

module.exports = { computeLoudness, findHighlights, fixedSegments, rollingMedian };
