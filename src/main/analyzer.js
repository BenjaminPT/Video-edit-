'use strict';

const SAMPLE_RATE = 8000; // для голоса хватает и 8 кГц
const FRAME_BYTES = 4; // два канала по 16 бит: слева весь звук, справа только голосовой диапазон
const MAX_TRACKS = 4;

/**
 * Граф ffmpeg: все аудиодорожки видео сводятся в одну, затем делятся на два канала.
 * Левый канал: весь звук. Правый: только голосовой диапазон 200-3400 Гц (два фильтра подряд, чтобы басы гасились сильнее).
 * Так басы музыки, взрывы и гул в игре почти не попадают в оценку «голоса».
 */
function buildAnalysisGraph(tracks) {
  const n = Math.min(Math.max(1, tracks), MAX_TRACKS);
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(`[0:a:${i}]aformat=channel_layouts=mono,aresample=${SAMPLE_RATE}[a${i}]`);
  }
  let mixed = '[a0]';
  if (n > 1) {
    const inputs = Array.from({ length: n }, (_, i) => `[a${i}]`).join('');
    parts.push(`${inputs}amix=inputs=${n}:duration=longest:dropout_transition=0[mix]`);
    mixed = '[mix]';
  }
  parts.push(`${mixed}asplit=2[full][tap]`);
  parts.push('[tap]highpass=f=200,highpass=f=200,lowpass=f=3400[voice]');
  parts.push('[full][voice]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[st]');
  return parts.join(';');
}

/**
 * Считает громкость (дБ) на каждую секунду: общую и в голосовом диапазоне.
 * Возвращает { total, voice }: два Float32Array, индекс = секунда видео.
 */
async function computeProfile({ job, ffmpegPath, input, duration, audioStreams = 1, onProgress }) {
  const seconds = Math.max(1, Math.ceil(duration));
  const total = new Float32Array(seconds).fill(-90);
  const voice = new Float32Array(seconds).fill(-90);

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-filter_complex', buildAnalysisGraph(audioStreams),
    '-map', '[st]',
    '-vn', '-sn', '-dn',
    '-ac', '2', '-ar', String(SAMPLE_RATE),
    '-f', 's16le', '-',
  ];

  let sumTotal = 0;
  let sumVoice = 0;
  let inWindow = 0;
  let second = 0;
  let leftover = null;
  let lastReport = 0;

  const toDb = (sumSq) => Math.max(-90, 10 * Math.log10(sumSq / inWindow + 1e-9));
  const flush = () => {
    if (inWindow > 0 && second < seconds) {
      total[second] = toDb(sumTotal);
      voice[second] = toDb(sumVoice);
    }
    sumTotal = 0;
    sumVoice = 0;
    inWindow = 0;
    second += 1;
  };

  const onData = (chunk) => {
    let buf = chunk;
    if (leftover) {
      buf = Buffer.concat([leftover, chunk]);
      leftover = null;
    }
    const usable = buf.length - (buf.length % FRAME_BYTES);
    if (usable !== buf.length) leftover = buf.subarray(usable);
    for (let i = 0; i < usable; i += FRAME_BYTES) {
      const l = buf.readInt16LE(i) / 32768;
      const r = buf.readInt16LE(i + 2) / 32768;
      sumTotal += l * l;
      sumVoice += r * r;
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
  return { total, voice };
}

function median(sorted) {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Скользящая медиана: «обычный» уровень голоса вокруг каждой секунды.
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

function prefixSums(values) {
  const out = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) out[i + 1] = out[i] + values[i];
  return out;
}

/**
 * Ищет моменты, где стример реагирует: голос резко выше обычного (крик, смех, эмоция).
 *
 * Правила:
 * 1. Считаем только голосовой диапазон. Громкая музыка и взрывы без голоса не в счёт.
 * 2. Пик сравниваем с обычным уровнем голоса за ~3 минуты вокруг, а не с абсолютным порогом.
 * 3. Вокруг момента должна быть речь: клип, где звука почти нет (тишина, заглушённая
 *    музыка в записи Twitch), отбрасывается, даже если там есть один громкий хлопок.
 * 4. Клипы не пересекаются. Если строгих моментов меньше заказанного числа,
 *    добираем более мягкими.
 */
function findHighlights(profile, { clipLen, count, duration, preRoll = 0.35 }) {
  const { total, voice } = profile;
  const n = voice.length;
  if (n === 0 || duration < 1) return [];

  const smooth = movingAverage(voice, 1); // ~3 секунды
  const baseline = rollingMedian(voice, 90); // ~3 минуты

  // «Есть голос»: порог между самыми тихими и самыми громкими секундами записи.
  const quiet = percentile(voice, 0.1);
  const loud = percentile(voice, 0.9);
  const speechFloor = Math.min(-35, Math.max(-60, quiet + 0.35 * (loud - quiet)));

  const active = new Float32Array(n);
  const share = new Float32Array(n); // доля голоса в общем звуке: 0 дБ = только голос, -20 дБ = в основном музыка
  for (let i = 0; i < n; i++) {
    active[i] = voice[i] >= speechFloor ? 1 : 0;
    share[i] = Math.max(-20, Math.min(0, voice[i] - total[i]));
  }
  const activeSum = prefixSums(active);
  const shareSum = prefixSums(share);

  const maxStart = Math.max(0, duration - clipLen);
  const candidates = [];
  for (let i = 0; i < n; i++) {
    const spike = voice[i] >= speechFloor ? smooth[i] - baseline[i] : 0;
    if (spike <= 0) continue;
    const start = Math.min(maxStart, Math.max(0, Math.round(i - clipLen * preRoll)));
    const end = Math.min(duration, start + clipLen);
    const from = Math.floor(start);
    const to = Math.min(n, Math.ceil(end));
    const len = Math.max(1, to - from);
    candidates.push({
      peak: i,
      spike,
      start,
      end,
      activeFrac: (activeSum[to] - activeSum[from]) / len,
      voiceShare: (shareSum[to] - shareSum[from]) / len,
    });
  }

  const passes = [
    { minSpike: 3, minActive: 0.6 },
    { minSpike: 1.5, minActive: 0.45 },
  ];
  const picked = [];
  const overlaps = (c) => picked.some((p) => c.start < p.end && c.end > p.start);

  for (const pass of passes) {
    if (picked.length >= count) break;
    const pool = candidates
      .filter((c) => c.spike >= pass.minSpike && c.activeFrac >= pass.minActive)
      .map((c) => ({ ...c, score: c.spike + 0.25 * c.voiceShare }))
      .sort((a, b) => b.score - a.score);
    for (const c of pool) {
      if (picked.length >= count) break;
      if (!overlaps(c)) picked.push(c);
    }
  }

  return picked
    .sort((a, b) => a.start - b.start)
    .map((c) => ({
      start: c.start,
      end: c.end,
      peak: c.peak,
      score: Math.round(c.spike * 10) / 10,
    }));
}

// Режим «подряд»: без пропусков. Хвост короче 3 секунд отбрасываем.
function fixedSegments(duration, clipLen) {
  const out = [];
  for (let start = 0; start < duration; start += clipLen) {
    const end = Math.min(duration, start + clipLen);
    if (end - start >= 3) out.push({ start, end });
  }
  return out;
}

module.exports = { computeProfile, findHighlights, fixedSegments, rollingMedian, buildAnalysisGraph };
