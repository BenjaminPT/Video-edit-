'use strict';

// Проверка движка без Electron: синтетическое видео со звуком,
// в котором известны три громких момента.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { Job } = require('../src/main/job');
const { computeLoudness, findHighlights, fixedSegments } = require('../src/main/analyzer');
const { cutClips } = require('../src/main/cutter');
const { runPipeline, probeDuration } = require('../src/main/pipeline');

function resolveTool(name) {
  try {
    if (name === 'ffmpeg') return require('ffmpeg-static');
    return require('ffprobe-static').path;
  } catch (_) {
    return name; // на машине разработчика может быть системный ffmpeg
  }
}
const ffmpeg = process.env.FFMPEG || resolveTool('ffmpeg');
const ffprobe = process.env.FFPROBE || resolveTool('ffprobe');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-test-'));
const source = path.join(tmp, 'stream.mp4');
const LOUD_AT = [40, 100, 160]; // секунды, где "кричат"
const TOTAL = 200;

function makeSource() {
  // Тихий фон (шум -38 дБ) и три громких всплеска по 6 секунд.
  const loud = LOUD_AT.map((t) => `between(t,${t},${t + 6})`).join('+');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=160x90:r=10:d=${TOTAL}`,
    '-f', 'lavfi', '-i', `anoisesrc=d=${TOTAL}:c=pink:a=0.02:r=8000`,
    '-f', 'lavfi', '-i', `sine=f=440:d=${TOTAL}:r=8000`,
    '-filter_complex', `[2:a]volume='0.6*(${loud})':eval=frame[s];[1:a][s]amix=inputs=2:normalize=0[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-c:a', 'aac', '-shortest', source,
  ];
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'не удалось создать тестовое видео: ' + r.stderr);
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} далеко от ${expected}`);
}

(async () => {
  makeSource();
  const job = new Job();

  const duration = await probeDuration({ job, ffprobePath: ffprobe, input: source });
  near(duration, TOTAL, 1, 'длительность');

  // fixedSegments
  const fixed = fixedSegments(130, 60);
  assert.deepStrictEqual(fixed, [
    { start: 0, end: 60 },
    { start: 60, end: 120 },
    { start: 120, end: 130 },
  ]);
  assert.strictEqual(fixedSegments(61, 60).length, 1, 'хвост короче 3 с отбрасывается');

  // Поиск пиков
  const db = await computeLoudness({ job, ffmpegPath: ffmpeg, input: source, duration });
  const found = findHighlights(db, { clipLen: 20, count: 3, duration });
  assert.strictEqual(found.length, 3, 'должно найтись три момента, найдено ' + found.length);
  found.forEach((seg, i) => {
    assert.ok(seg.start <= LOUD_AT[i] + 6 && seg.end >= LOUD_AT[i], `клип ${i + 1} (${seg.start}-${seg.end}) не накрывает всплеск на ${LOUD_AT[i]} с`);
    assert.ok(seg.end - seg.start <= 20 + 1e-9, 'клип длиннее заказанного');
  });
  for (let i = 1; i < found.length; i++) assert.ok(found[i].start >= found[i - 1].end, 'клипы пересекаются');

  // Ровный звук: ничего не находим
  const flat = new Float32Array(300).fill(-30);
  assert.strictEqual(findHighlights(flat, { clipLen: 20, count: 5, duration: 300 }).length, 0);

  // Нарезка (с перекодированием) и проверка длин
  const outA = path.join(tmp, 'outA');
  const cut = await cutClips({ job, ffmpegPath: ffmpeg, input: source, segments: found, outDir: outA, fast: false });
  assert.strictEqual(cut.clips.length, 3);
  for (const clip of cut.clips) {
    const d = await probeDuration({ job, ffprobePath: ffprobe, input: clip.file });
    near(d, clip.end - clip.start, 1.5, 'длина клипа ' + clip.index);
  }
  assert.ok(fs.existsSync(path.join(cut.folder, 'timecodes.txt')), 'нет timecodes.txt');

  // Весь процесс, режим "подряд" на 60 секунд, быстрая нарезка
  const events = [];
  const full = await runPipeline({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    options: { input: source, outDir: path.join(tmp, 'outB'), mode: 'fixed', clipLen: 60, count: 10, fast: true },
    onProgress: (p) => events.push(p),
  });
  assert.strictEqual(full.clips.length, 4, '200 с / 60 = 4 клипа (3 полных и хвост 20 с)');
  assert.ok(events.some((e) => e.stage === 'cut'), 'не было прогресса нарезки');

  // Режим "по звуку" целиком
  const smart = await runPipeline({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    options: { input: source, outDir: path.join(tmp, 'outC'), mode: 'smart', clipLen: 30, count: 3, fast: true },
    onProgress: () => {},
  });
  assert.strictEqual(smart.clips.length, 3);

  // Проверка входных данных
  await assert.rejects(
    runPipeline({ job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe, options: { input: source, outDir: tmp, mode: 'fixed', clipLen: 45, count: 3 }, onProgress() {} }),
    /20, 30 или 60/
  );

  // Отмена
  const cancelJob = new Job();
  const pending = computeLoudness({ job: cancelJob, ffmpegPath: ffmpeg, input: source, duration });
  cancelJob.cancel();
  await assert.rejects(pending, (e) => e.name === 'CancelledError');

  console.log('OK: все проверки движка пройдены');
})()
  .catch((err) => {
    console.error('ПРОВАЛ:', err.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
