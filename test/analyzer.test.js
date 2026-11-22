'use strict';

// Проверка движка без Electron. Видео собираются из синтетического звука, где заранее
// известно, что в какую секунду происходит:
//   40, 100, 160 с  голосовые реакции (громко в диапазоне голоса)
//   70-78 с         громкие басы без голоса (музыка, взрывы): выбираться не должны
//   190-225 с       звук заглушён (как в записях Twitch), только один громкий хлопок на 205 с
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { Job } = require('../src/main/job');
const { computeProfile, findHighlights, fixedSegments } = require('../src/main/analyzer');
const { cutClips, checkAudio } = require('../src/main/cutter');
const { runPipeline, probeMedia, analyzeVideo } = require('../src/main/pipeline');

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
const TOTAL = 240;
const REACTIONS = [40, 100, 160];

function ff(args, what) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `не удалось создать ${what}: ${r.stderr}`);
}

function makeStream(file) {
  const lavfi = (src) => ['-f', 'lavfi', '-i', src];
  ff([
    ...lavfi(`color=c=black:s=160x90:r=10:d=${TOTAL}`),
    ...lavfi(`anoisesrc=d=${TOTAL}:c=pink:a=0.01:r=8000`),
    ...lavfi(`sine=f=300:d=${TOTAL}:r=8000`),
    ...lavfi(`sine=f=500:d=${TOTAL}:r=8000`),
    ...lavfi(`sine=f=60:d=${TOTAL}:r=8000`),
    ...lavfi(`sine=f=800:d=${TOTAL}:r=8000`),
    '-filter_complex', [
      "[1:a]volume='1-between(t,190,225)':eval=frame[n]",
      "[2:a]volume='0.24*(1-between(t,190,225))':eval=frame[bg]",
      "[3:a]volume='4*(" + REACTIONS.map((t) => `between(t,${t},${t + 6})`).join('+') + ")':eval=frame[burst]",
      "[4:a]volume='5*between(t,70,78)':eval=frame[bass]",
      "[5:a]volume='6*between(t,205,206)':eval=frame[bang]",
      '[n][bg][burst][bass][bang]amix=inputs=5:normalize=0[a]',
    ].join(';'),
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-c:a', 'aac', file,
  ], 'тестовый стрим');
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} далеко от ${expected}`);
}

const covers = (seg, t) => seg.start <= t && seg.end >= t;

(async () => {
  const stream = path.join(tmp, 'stream.mp4');
  makeStream(stream);
  const job = new Job();

  const media = await probeMedia({ job, ffprobePath: ffprobe, input: stream });
  near(media.duration, TOTAL, 1, 'длительность');
  assert.strictEqual(media.audioStreams, 1);

  // --- режим «подряд»
  assert.deepStrictEqual(fixedSegments(130, 60), [
    { start: 0, end: 60 },
    { start: 60, end: 120 },
    { start: 120, end: 130 },
  ]);
  assert.strictEqual(fixedSegments(61, 60).length, 1, 'хвост короче 3 с отбрасывается');

  // --- поиск реакций по голосу
  const profile = await computeProfile({ job, ffmpegPath: ffmpeg, input: stream, duration: media.duration, audioStreams: 1 });
  assert.ok(profile.voice[43] > profile.voice[20] + 15, 'реакция должна быть заметно громче обычного голоса');
  assert.ok(profile.total[74] > profile.total[20] + 15, 'басы должны быть громкими в общем звуке');
  assert.ok(profile.voice[74] < profile.voice[20] + 3, 'басы не должны попадать в голосовой диапазон');

  const top3 = findHighlights(profile, { clipLen: 20, count: 3, duration: media.duration });
  assert.strictEqual(top3.length, 3, 'должно найтись три момента, найдено ' + top3.length);
  REACTIONS.forEach((t, i) => assert.ok(covers(top3[i], t + 3), `клип ${i + 1} (${top3[i].start}-${top3[i].end}) не накрывает реакцию на ${t} с`));

  const many = findHighlights(profile, { clipLen: 20, count: 50, duration: media.duration });
  assert.ok(many.length >= 3, 'реакции должны находиться и при большом заказе');
  for (const seg of many) {
    assert.ok(!covers(seg, 205.5), `клип ${seg.start}-${seg.end} взят из заглушённого места ради одного хлопка`);
    assert.ok(seg.peak < 68 || seg.peak > 80, `клип с пиком ${seg.peak} взят из-за музыки без голоса`);
  }
  for (let i = 1; i < many.length; i++) assert.ok(many[i].start >= many[i - 1].end, 'клипы пересекаются');

  const flat = { total: new Float32Array(300).fill(-30), voice: new Float32Array(300).fill(-30) };
  assert.strictEqual(findHighlights(flat, { clipLen: 20, count: 5, duration: 300 }).length, 0, 'ровный звук: моментов нет');

  // --- нарезка и проверка звука
  const cut = await cutClips({ job, ffmpegPath: ffmpeg, input: stream, segments: top3, outDir: path.join(tmp, 'outA'), fast: false, audioStreams: 1 });
  assert.strictEqual(cut.clips.length, 3);
  for (const clip of cut.clips) {
    const m = await probeMedia({ job, ffprobePath: ffprobe, input: clip.file });
    near(m.duration, clip.end - clip.start, 1.5, 'длина клипа ' + clip.index);
    assert.strictEqual(m.audioStreams, 1, 'в клипе должна быть звуковая дорожка');
    assert.strictEqual(clip.audio, 'ok', `в клипе ${clip.index} пропал звук: ${clip.audio}`);
  }
  assert.ok(fs.existsSync(path.join(cut.folder, 'timecodes.txt')), 'нет timecodes.txt');

  // --- весь процесс; анализ один раз, параметры потом
  const events = [];
  const first = await runPipeline({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    options: { input: stream, outDir: path.join(tmp, 'outB'), mode: 'smart', clipLen: 30, count: 3, fast: true },
    onProgress: (p) => events.push(p),
  });
  assert.strictEqual(first.clips.length, 3);
  assert.ok(events.some((e) => e.stage === 'analyze'), 'первый запуск без кэша должен анализировать звук');
  first.clips.forEach((c) => assert.strictEqual(c.audio, 'ok', 'быстрая нарезка потеряла звук'));
  assert.ok(first.analysis && first.analysis.profile, 'анализ должен возвращаться для кэша');

  const events2 = [];
  const second = await runPipeline({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe, analysis: first.analysis,
    options: { input: stream, outDir: path.join(tmp, 'outC'), mode: 'smart', clipLen: 20, count: 100, fast: true },
    onProgress: (p) => events2.push(p),
  });
  assert.ok(!events2.some((e) => e.stage === 'analyze'), 'с готовым анализом звук заново слушать не нужно');
  assert.ok(second.clips.length >= 3, 'при заказе 100 клипов реакции всё равно находятся');

  // --- границы параметров
  const bad = (options, re) => assert.rejects(
    runPipeline({ job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe, options: { input: stream, outDir: tmp, mode: 'fixed', fast: true, count: 3, clipLen: 20, ...options }, onProgress() {} }), re);
  await bad({ clipLen: 45 }, /20, 30 или 60/);
  await bad({ count: 201 }, /от 1 до 200/);
  await bad({ mode: 'x' }, /режим/);

  // --- две дорожки: у первой тишина, голос на второй. Раньше брали только первую.
  const twoTracks = path.join(tmp, 'two-tracks.mp4');
  ff([
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10:d=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-f', 'lavfi', '-i', 'sine=f=440:r=44100',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-t', '30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', twoTracks,
  ], 'видео с двумя дорожками');
  const twoMedia = await probeMedia({ job, ffprobePath: ffprobe, input: twoTracks });
  assert.strictEqual(twoMedia.audioStreams, 2);
  const two = await runPipeline({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    options: { input: twoTracks, outDir: path.join(tmp, 'outT'), mode: 'fixed', clipLen: 20, count: 3, fast: true },
    onProgress() {},
  });
  two.clips.forEach((c) => assert.strictEqual(c.audio, 'ok', 'звук со второй дорожки потерялся'));
  const twoAnalysis = await analyzeVideo({ job, ffmpegPath: ffmpeg, ffprobePath: ffprobe, input: twoTracks });
  assert.ok(Math.max(...twoAnalysis.profile.voice) > -40, 'анализ должен слышать вторую дорожку');

  // --- звук обрывается на 12-й секунде: клип должен получить отметку
  const dropout = path.join(tmp, 'dropout.mp4');
  ff([
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10:d=60',
    '-f', 'lavfi', '-i', 'sine=f=440:d=12:r=44100',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', dropout,
  ], 'видео с пропадающим звуком');
  const dr = await runPipeline({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    options: { input: dropout, outDir: path.join(tmp, 'outD'), mode: 'fixed', clipLen: 60, count: 1, fast: false },
    onProgress() {},
  });
  assert.strictEqual(dr.clips.length, 1);
  assert.strictEqual(dr.clips[0].audio, 'partial', 'пропавший звук должен быть замечен');
  assert.match(dr.note, /звук пропадает/);

  // --- вообще без звука
  const silentFile = path.join(tmp, 'no-audio.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10:d=25', '-c:v', 'libx264', '-preset', 'ultrafast', silentFile], 'видео без звука');
  assert.strictEqual((await probeMedia({ job, ffprobePath: ffprobe, input: silentFile })).audioStreams, 0);
  await assert.rejects(
    runPipeline({ job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe, options: { input: silentFile, outDir: tmp, mode: 'smart', clipLen: 20, count: 3, fast: true }, onProgress() {} }),
    /нет звука/
  );
  const ns = await runPipeline({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    options: { input: silentFile, outDir: path.join(tmp, 'outN'), mode: 'fixed', clipLen: 20, count: 1, fast: true },
    onProgress() {},
  });
  assert.strictEqual(ns.clips[0].audio, 'none');
  assert.match(ns.note, /нет звука/);

  // --- загрузчик на поддельном yt-dlp (только Mac и Linux: на Windows нет sh)
  const { downloadVideo, assertHttpUrl } = require('../src/main/downloader');
  assert.throws(() => assertHttpUrl('file:///etc/passwd'), /http/);
  assert.throws(() => assertHttpUrl('не ссылка'), /ссылку/);
  if (process.platform !== 'win32') {
    const fake = path.join(tmp, 'fake-ytdlp.sh');
    fs.writeFileSync(fake, [
      '#!/bin/sh',
      'out=""',
      'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done',
      'dir=$(dirname "$out")',
      'echo data > "$dir/v123.mp4"',
      'echo "CLP  50.0%"',
      "printf 'TTL:\\320'", // первый байт буквы «П»
      'sleep 0.3',
      "printf '\\237 стрим\\n'", // второй байт приходит отдельным куском
      'if [ "$FAKE_PRINT_PATH" = "1" ]; then echo "$dir/v123.mp4"; fi',
    ].join('\n') + '\n', { mode: 0o755 });
    const toolset = { ytdlp: fake, dir: tmp };

    process.env.FAKE_PRINT_PATH = '1';
    const dlA = await downloadVideo({ job: new Job(), tools: toolset, url: 'https://www.twitch.tv/videos/1', outDir: path.join(tmp, 'dlA'), onProgress() {} });
    assert.strictEqual(path.basename(dlA.file), 'v123.mp4');
    assert.strictEqual(dlA.title, 'П стрим', 'название с кириллицей склеилось неверно: ' + dlA.title);

    process.env.FAKE_PRINT_PATH = '0'; // yt-dlp не напечатал путь: берём свежий видеофайл из папки
    const dlB = await downloadVideo({ job: new Job(), tools: toolset, url: 'https://www.twitch.tv/videos/2', outDir: path.join(tmp, 'dlB'), onProgress() {} });
    assert.strictEqual(path.basename(dlB.file), 'v123.mp4');
    delete process.env.FAKE_PRINT_PATH;
  }

  // --- отмена
  const cancelJob = new Job();
  const pending = computeProfile({ job: cancelJob, ffmpegPath: ffmpeg, input: stream, duration: media.duration, audioStreams: 1 });
  cancelJob.cancel();
  await assert.rejects(pending, (e) => e.name === 'CancelledError');

  console.log('OK: все проверки движка пройдены');
})()
  .catch((err) => {
    console.error('ПРОВАЛ:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
