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
 * Кандидаты на момент: каждая секунда, где голос выше обычного уровня.
 * Для каждой считаем окно клипа, долю секунд с речью, долю голоса в общем звуке
 * и «затяжность» подъёма (смех и долгая реакция держатся дольше, чем одиночный крик).
 * sigma: типичный разброс уровня голоса в этой записи (устойчивая оценка по MAD);
 * по нему оценки из разных видео становятся сравнимыми.
 */
function buildCandidates(profile, { clipLen, duration, preRoll = 0.35 }) {
  const { total, voice } = profile;
  const n = voice.length;
  if (n === 0 || duration < 1) return { candidates: [], sigma: 1 };

  const smooth = movingAverage(voice, 1); // ~3 секунды
  const baseline = rollingMedian(voice, 90); // ~3 минуты

  // «Есть голос»: порог между самыми тихими и самыми громкими секундами записи.
  const quiet = percentile(voice, 0.1);
  const loud = percentile(voice, 0.9);
  const speechFloor = Math.min(-35, Math.max(-60, quiet + 0.35 * (loud - quiet)));

  const active = new Float32Array(n);
  const share = new Float32Array(n); // доля голоса в общем звуке: 0 дБ = только голос, -20 дБ = в основном музыка
  const diff = new Float32Array(n); // насколько голос выше обычного
  for (let i = 0; i < n; i++) {
    active[i] = voice[i] >= speechFloor ? 1 : 0;
    share[i] = Math.max(-20, Math.min(0, voice[i] - total[i]));
    diff[i] = smooth[i] - baseline[i];
  }
  const activeSum = prefixSums(active);
  const shareSum = prefixSums(share);
  const diffSum = prefixSums(diff);
  const voiceSum = prefixSums(voice);

  const sorted = Array.from(diff).sort((a, b) => a - b);
  const mid = median(sorted);
  const deviations = sorted.map((v) => Math.abs(v - mid)).sort((a, b) => a - b);
  const sigma = Math.max(1, 1.4826 * median(deviations));

  const maxStart = Math.max(0, duration - clipLen);
  const candidates = [];
  for (let i = 0; i < n; i++) {
    const spike = voice[i] >= speechFloor ? diff[i] : 0;
    if (spike <= 0) continue;
    const start = Math.min(maxStart, Math.max(0, Math.round(i - clipLen * preRoll)));
    const end = Math.min(duration, start + clipLen);
    const from = Math.floor(start);
    const to = Math.min(n, Math.ceil(end));
    const len = Math.max(1, to - from);
    const tail = Math.min(n, i + 8);
    // «Неожиданность»: насколько голос громче, чем был за 12–3 секунды до пика.
    const pf = Math.max(0, i - 12);
    const pt = Math.max(pf + 1, i - 3);
    const before = (voiceSum[pt] - voiceSum[pf]) / (pt - pf);
    candidates.push({
      peak: i,
      spike,
      jump: smooth[i] - before,
      meanDiff: (diffSum[to] - diffSum[from]) / len,
      sustain: Math.max(0, (diffSum[tail] - diffSum[i]) / Math.max(1, tail - i)),
      start,
      end,
      activeFrac: (activeSum[to] - activeSum[from]) / len,
      voiceShare: (shareSum[to] - shareSum[from]) / len,
    });
  }
  return { candidates, sigma };
}

/**
 * Режим «все реакции»: до count моментов, где голос резко выше обычного (крик, смех, эмоция).
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
  const { candidates } = buildCandidates(profile, { clipLen, duration, preRoll });
  if (candidates.length === 0) return [];

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

/**
 * По чему искать лучшие моменты. Все критерии работают по голосу и сравнимы между видео,
 * потому что измеряются в «типичных разбросах» голоса этой записи.
 */
const CRITERIA = {
  mix: 'Сбалансированно',
  peak: 'Самый громкий всплеск',
  sustain: 'Долгая реакция',
  talk: 'Оживлённый разговор',
  surprise: 'Внезапность',
};

/**
 * Режим «лучшие»: оцениваем кандидатов одним числом, чтобы сравнивать их между собой
 * и между разными видео.
 *
 * criterion (по умолчанию 'mix'):
 *   mix       (0.6 * резкость подъёма + 0.4 * затяжность): крик, смех и эмоции вперемешку;
 *   peak      только резкость: самый громкий всплеск голоса;
 *   sustain   в основном затяжность: смех и долгая эмоциональная реакция;
 *   talk      плотная речь без пауз, где голос весь клип выше обычного: оживлённый разговор;
 *   surprise  скачок голоса после спокойного участка: внезапная реакция.
 * Поправка снижает оценку там, где речи мало или голос тонет в музыке.
 * Веса стартовые и выбраны по результатам исследования других сервисов, а не обучены
 * на разметке: настоящих формул никто из них не публикует.
 */
function rankCandidates(profile, { clipLen, duration, preRoll = 0.35, criterion = 'mix' }) {
  const { candidates, sigma } = buildCandidates(profile, { clipLen, duration, preRoll });
  const out = [];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  for (const c of candidates) {
    const spikeZ = clamp(c.spike / sigma, 0, 6);
    const sustainZ = clamp(c.sustain / sigma, 0, 6);
    const jumpZ = clamp(c.jump / sigma, 0, 6);
    const meanZ = clamp(c.meanDiff / sigma, 0, 4);
    const gate = (0.5 + 0.5 * c.activeFrac) * (1 + c.voiceShare / 40);
    let score;
    let tag;

    if (criterion === 'sustain') {
      if (c.spike < 2 || spikeZ < 1.5 || sustainZ < 1.2 || c.activeFrac < 0.6) continue;
      score = (0.25 * spikeZ + 0.75 * sustainZ) * gate;
      tag = 'долгая реакция';
    } else if (criterion === 'talk') {
      if (c.activeFrac < 0.85 || c.spike <= 0 || meanZ < 0.5) continue;
      score = (2 * c.activeFrac + meanZ) * gate;
      tag = 'оживлённый разговор';
    } else if (criterion === 'surprise') {
      if (c.spike < 3 || jumpZ < 2.5 || c.activeFrac < 0.5) continue;
      score = jumpZ * gate;
      tag = 'внезапный всплеск';
    } else {
      if (c.spike < 3 || spikeZ < 2 || c.activeFrac < 0.6) continue;
      if (criterion === 'peak') {
        score = spikeZ * gate;
        tag = 'громкий всплеск';
      } else {
        score = (0.6 * spikeZ + 0.4 * sustainZ) * gate;
        tag = 'громкая речь';
        if (sustainZ >= 2) tag = 'долгая реакция';
        else if (spikeZ >= 3.5) tag = 'резкий всплеск голоса';
      }
    }
    out.push({
      start: c.start,
      end: c.end,
      peak: c.peak,
      score: Math.round(score * 10) / 10,
      tag,
    });
  }
  return out;
}

/**
 * Выбирает лучшие count моментов из кандидатов (possibly нескольких видео, поле videoId).
 * Правила: от лучшего к худшему; клипы одного видео не пересекаются и их пики
 * не ближе minGap секунд; не больше perBucket клипов на каждые bucketSec секунд видео,
 * чтобы топ не состоял из одной горячей минуты. Если строгих не хватило, добираем без этой квоты.
 * Возвращает список по убыванию рейтинга с полем rank.
 */
function pickTop(entries, { count, minGap = 60, bucketSec = 900, perBucket = 2 }) {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const picked = [];
  const used = new Set();
  const perBucketCount = new Map();
  const bucketKey = (c) => `${c.videoId}:${Math.floor(c.peak / bucketSec)}`;
  const conflicts = (c) =>
    picked.some(
      (p) => p.videoId === c.videoId && ((c.start < p.end && c.end > p.start) || Math.abs(c.peak - p.peak) < minGap)
    );

  for (const strict of [true, false]) {
    for (const c of sorted) {
      if (picked.length >= count) break;
      if (used.has(c) || conflicts(c)) continue;
      if (strict && (perBucketCount.get(bucketKey(c)) || 0) >= perBucket) continue;
      picked.push(c);
      used.add(c);
      perBucketCount.set(bucketKey(c), (perBucketCount.get(bucketKey(c)) || 0) + 1);
    }
  }
  return picked.map((c, i) => ({ ...c, rank: i + 1 }));
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

module.exports = { CRITERIA, computeProfile, findHighlights, rankCandidates, pickTop, fixedSegments, rollingMedian, buildAnalysisGraph };
