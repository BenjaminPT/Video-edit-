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
const { computeProfile, findHighlights, rankCandidates, pickTop, fixedSegments } = require('../src/main/analyzer');
const { Semaphore } = require('../src/main/queue');
const { cutClips, checkAudio } = require('../src/main/cutter');
const { runPipeline, runBatch, cutExtra, probeMedia, analyzeVideo } = require('../src/main/pipeline');

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

function topCriterion(list, t, len) {
  return list.some((c) => c.peak >= t - 1 && c.peak <= t + len);
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

    // Две загрузки одновременно: оба поддельных файла называются v123.mp4, но не затирают друг друга
    const { downloadInto } = require('../src/main/downloader');
    const dlDir = path.join(tmp, 'dlC');
    process.env.FAKE_PRINT_PATH = '0';
    const both = await Promise.all([
      downloadInto({ job: new Job(), tools: toolset, url: 'https://www.twitch.tv/videos/3', outDir: dlDir, id: '1', onProgress() {} }),
      downloadInto({ job: new Job(), tools: toolset, url: 'https://www.twitch.tv/videos/4', outDir: dlDir, id: '2', onProgress() {} }),
    ]);
    delete process.env.FAKE_PRINT_PATH;
    assert.notStrictEqual(both[0].file, both[1].file, 'параллельные загрузки перезаписали друг друга');
    assert.deepStrictEqual(fs.readdirSync(dlDir).sort(), ['v123.mp4', 'v123_2.mp4'], 'во временных папках не должно остаться мусора: ' + fs.readdirSync(dlDir));
  }

  // --- режим «лучшие»: рейтинг, топ без повторов, несколько видео
  const ranked = rankCandidates(profile, { clipLen: 20, duration: media.duration });
  assert.ok(ranked.length >= 3 && ranked.every((c) => c.score > 0 && c.tag), 'у кандидатов должны быть оценка и подсказка');
  assert.ok(ranked.every((c) => !covers(c, 205.5)), 'заглушённое место не должно попадать в рейтинг');
  assert.ok(ranked.every((c) => c.peak < 68 || c.peak > 80), 'музыка без голоса не должна попадать в рейтинг');
  const entries = ranked.map((c) => ({ ...c, videoId: 0 }));
  const topPick = pickTop(entries, { count: 3 });
  assert.strictEqual(topPick.length, 3);
  assert.deepStrictEqual(topPick.map((t) => t.rank), [1, 2, 3]);
  assert.ok(topPick[0].score >= topPick[1].score && topPick[1].score >= topPick[2].score, 'топ должен идти по убыванию оценки');
  REACTIONS.forEach((t) => assert.ok(topPick.some((c) => covers(c, t + 3)), `реакция на ${t} с не попала в топ-3`));
  for (let i = 0; i < topPick.length; i++) {
    for (let j = i + 1; j < topPick.length; j++) {
      assert.ok(topPick[i].end <= topPick[j].start || topPick[j].end <= topPick[i].start, 'клипы топа пересекаются');
      assert.ok(Math.abs(topPick[i].peak - topPick[j].peak) >= 60, 'пики топа ближе минимального интервала');
    }
  }
  // Квота на «горячую минуту»: три клипа подряд из одних 15 минут уступают очереди остальным
  const crowd = [
    { videoId: 0, start: 0, end: 20, peak: 7, score: 9 }, { videoId: 0, start: 100, end: 120, peak: 107, score: 8 },
    { videoId: 0, start: 200, end: 220, peak: 207, score: 7 }, { videoId: 0, start: 2000, end: 2020, peak: 2007, score: 3 },
  ];
  assert.deepStrictEqual(pickTop(crowd, { count: 3 }).map((c) => c.peak), [7, 107, 2007], 'квота на 15 минут не сработала');
  assert.strictEqual(pickTop(crowd, { count: 4 }).length, 4, 'при нехватке строгих клипов квота ослабляется');

  // Критерии отбора: каждый даёт свой рейтинг и свою подсказку; тишина и музыка не проходят ни в одном
  const byCriterion = {};
  for (const criterion of ['mix', 'peak', 'sustain', 'talk', 'surprise']) {
    const list = rankCandidates(profile, { clipLen: 20, duration: media.duration, criterion });
    byCriterion[criterion] = list;
    console.log(`критерий ${criterion}: кандидатов ${list.length}, лучший ${list.length ? Math.max(...list.map((c) => c.score)) : '-'}`);
    assert.ok(list.every((c) => !covers(c, 205.5) && (c.peak < 68 || c.peak > 80)), `критерий ${criterion}: тишина или музыка попали в рейтинг`);
  }
  assert.ok(byCriterion.peak.length > 0 && byCriterion.peak.every((c) => c.tag === 'громкий всплеск'));
  assert.ok(byCriterion.surprise.length > 0, 'скачок после спокойного участка должен находиться');
  assert.ok(byCriterion.surprise.every((c) => c.tag === 'внезапный всплеск'));
  REACTIONS.forEach((t) => assert.ok(
    topCriterion(byCriterion.surprise, t, 6) , `внезапность: реакция на ${t} с не найдена`
  ));

  // «Другие моменты»: после топа остаются следующие по рейтингу, они не пересекаются с топом и их можно вырезать
  const withExtras = await runBatch({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    videos: [{ id: 'x', input: stream }],
    options: { outDir: path.join(tmp, 'outExtra'), mode: 'top', clipLen: 20, count: 1, fast: true, criterion: 'peak' },
    onProgress() {},
  });
  assert.strictEqual(withExtras.clips.length, 1);
  assert.ok(withExtras.extras.length >= 1, 'после топа должны остаться другие моменты');
  assert.ok(withExtras.extras.every((e) => e.rank > 1 && e.file === stream && e.tag), 'у других моментов есть номер, файл и подсказка');
  const topClip = withExtras.clips[0];
  assert.ok(withExtras.extras.every((e) => e.end <= topClip.start || e.start >= topClip.end), 'другие моменты не пересекаются с топом');
  const extraClip = await cutExtra({ job: new Job(), ffmpegPath: ffmpeg, folder: withExtras.folder, extra: withExtras.extras[0], fast: true });
  assert.ok(fs.existsSync(extraClip.file) && path.dirname(extraClip.file) === withExtras.folder);
  assert.ok(path.basename(extraClip.file).startsWith(String(withExtras.extras[0].rank).padStart(2, '0') + '_'));
  const tcLines = fs.readFileSync(path.join(withExtras.folder, 'timecodes.txt'), 'utf8').trim().split('\n');
  assert.strictEqual(tcLines.length, 2, 'вырезанный момент дописан в timecodes.txt');
  await assert.rejects(
    runBatch({ job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe, videos: [{ id: 'x', input: stream }], options: { outDir: tmp, mode: 'top', clipLen: 20, count: 3, criterion: 'nope' }, onProgress() {} }),
    /критерий/
  );

  const batchEvents = [];
  const batch = await runBatch({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    videos: [{ id: 'a', input: stream }, { id: 'b', input: stream }],
    options: { outDir: path.join(tmp, 'outTop'), mode: 'top', clipLen: 20, count: 4, fast: true },
    onProgress: (p) => batchEvents.push(p),
  });
  assert.strictEqual(batch.clips.length, 4, 'два одинаковых видео дают по три реакции: из шести берём четыре');
  assert.deepStrictEqual(batch.clips.map((c) => c.rank), [1, 2, 3, 4]);
  assert.ok(path.basename(batch.clips[0].file).startsWith('01_'), 'файлы топа нумеруются по рейтингу');
  assert.ok(batch.clips.every((c) => c.audio === 'ok' && c.tag && c.video === 'stream'));
  assert.strictEqual(path.dirname(batch.clips[0].file), batch.folder, 'клипы топа лежат в одной папке');
  assert.strictEqual(batch.analyses.length, 2);
  assert.ok(batchEvents.some((e) => e.stage === 'analyze' && /1 из 2/.test(e.label)), 'при нескольких видео прогресс анализа показывает номер');

  const mixed = await runBatch({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    videos: [{ id: 'c', input: twoTracks }, { id: 'd', input: silentFile }],
    options: { outDir: path.join(tmp, 'outMixed'), mode: 'fixed', clipLen: 20, count: 1, fast: true },
    onProgress() {},
  });
  assert.strictEqual(mixed.clips.length, 4, '30 с и 25 с по 20 с: у каждого полный клип и хвост');
  assert.deepStrictEqual(mixed.clips.map((c) => c.index), [1, 2, 3, 4]);
  const mixedSmart = await runBatch({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    videos: [{ id: 'e', input: stream }, { id: 'f', input: silentFile }],
    options: { outDir: path.join(tmp, 'outMixed2'), mode: 'smart', clipLen: 20, count: 3, fast: true },
    onProgress() {},
  });
  assert.strictEqual(mixedSmart.clips.length, 3);
  assert.match(mixedSmart.note, /пропущено/, 'видео без звука пропускается с пояснением, если есть другие');
  await assert.rejects(
    runBatch({ job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe, videos: [], options: { outDir: tmp, mode: 'top', clipLen: 20, count: 3 }, onProgress() {} }),
    /Не выбрано видео/
  );

  // --- очередь: не больше двух задач сразу, ожидающая задача выходит по отмене
  const sem = new Semaphore(2);
  let running = 0;
  let maxRunning = 0;
  const work = async () => {
    const release = await sem.acquire(new Job());
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 40));
    running -= 1;
    release();
  };
  await Promise.all([work(), work(), work(), work(), work()]);
  assert.strictEqual(maxRunning, 2, 'очередь должна пускать не больше двух задач сразу');
  const slotA = await sem.acquire(new Job());
  const slotB = await sem.acquire(new Job());
  const waitingJob = new Job();
  const waiting = sem.acquire(waitingJob);
  waitingJob.cancel();
  await assert.rejects(waiting, (e) => e.name === 'CancelledError');
  slotA(); slotB();
  assert.strictEqual(sem.active, 0);

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
