'use strict';

// Проверка монтажного движка: собираем настоящие ролики и смотрим на результат через ffprobe.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { Job } = require('../src/main/job');
const { exportProject, previewFrame, probeFile, probeCapabilities } = require('../src/main/montage');

function resolveTool(name) {
  try {
    if (name === 'ffmpeg') return require('ffmpeg-static');
    return require('ffprobe-static').path;
  } catch (_) {
    return name;
  }
}
const ffmpeg = process.env.FFMPEG || resolveTool('ffmpeg');
const ffprobe = process.env.FFPROBE || resolveTool('ffprobe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-montage-'));

function ff(args, what) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `не удалось создать ${what}: ${r.stderr}`);
}
const P = (n) => path.join(tmp, n);

async function info(file) {
  return probeFile({ job: new Job(), ffprobePath: ffprobe, file });
}

// mean_volume на отрезке файла
function meanVolume(file, from, len) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(len), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+)/.exec(r.stderr);
  return m ? parseFloat(m[1]) : -99;
}

function run(project, name) {
  const out = P(name);
  const progress = [];
  return exportProject({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe, rawProject: project, outFile: out,
    onProgress: (v) => progress.push(v),
  }).then((res) => ({ ...res, out, progress }));
}

(async () => {
  // Исходники
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', P('a.mp4')], 'клип A');
  ff(['-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', P('b_silent.mp4')], 'клип без звука');
  // Зелёный экран: зелёный фон и красный квадрат в центре
  ff(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'color=c=red:s=160x160:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
    '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', P('green.mp4')], 'зелёный экран');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-c:a', 'aac', P('music.m4a')], 'музыка');
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:d=1', '-frames:v', '1', P('bg.png')], 'фон');

  const caps = await probeCapabilities({ job: new Job(), ffmpegPath: ffmpeg });
  console.log('возможности ffmpeg:', JSON.stringify(caps));
  assert.ok(caps.chromakey && caps.xfade && caps.loudnorm, 'в ffmpeg нет нужных фильтров');

  const base = { file: P('a.mp4'), in: 0.5, out: 3.5 };

  // 1. Один клип, 9:16, заполнить
  let r = await run({ aspect: '9:16', fit: 'fill', clips: [{ ...base }] }, 'r1.mp4');
  let i = await info(r.out);
  assert.strictEqual(`${i.width}x${i.height}`, '1080x1920');
  assert.ok(Math.abs(i.duration - 3) < 0.15, 'длина 3 с, получилось ' + i.duration);
  assert.ok(i.audioStreams === 1);
  assert.ok(r.progress.length > 0 && r.progress[r.progress.length - 1] === 1, 'прогресс доходит до 100%');

  // 2. Вписать и размытый фон, 1:1 и 4:5
  r = await run({ aspect: '1:1', fit: 'fit', clips: [{ ...base }] }, 'r2.mp4');
  i = await info(r.out);
  assert.strictEqual(`${i.width}x${i.height}`, '1080x1080');
  r = await run({ aspect: '4:5', fit: 'blur', clips: [{ ...base }] }, 'r2b.mp4');
  i = await info(r.out);
  assert.strictEqual(`${i.width}x${i.height}`, '1080x1350');

  // 3. Скорость x2 укорачивает вдвое; клип без звука получает тишину
  r = await run({ aspect: 'original', clips: [{ ...base, speed: 2 }] }, 'r3.mp4');
  i = await info(r.out);
  assert.ok(Math.abs(i.duration - 1.5) < 0.2, 'скорость x2: ' + i.duration);
  assert.strictEqual(`${i.width}x${i.height}`, '1280x720', 'исходный размер сохраняется');

  // 4. Два клипа с переходом, один без звука, музыка с приглушением, нормализация, подпись
  r = await run({
    aspect: '16:9', fit: 'fit', transition: 0.5, loudnorm: true,
    caption: { text: 'Привет: 100% "тест"', position: 'bottom', size: 60 },
    music: { file: P('music.m4a'), volume: 0.6, duck: true },
    clips: [{ ...base }, { file: P('b_silent.mp4'), in: 0, out: 3, fadeIn: 0.3, fadeOut: 0.3 }],
  }, 'r4.mp4');
  i = await info(r.out);
  assert.ok(Math.abs(i.duration - 5.5) < 0.3, 'два клипа с переходом: 3+3-0.5, а получилось ' + i.duration);
  assert.ok(i.audioStreams === 1);
  assert.ok(meanVolume(r.out, 0, 2) > -60, 'звук на месте');

  // 5. Громкость клипа: 0 даёт тишину
  r = await run({ aspect: 'original', clips: [{ ...base, volume: 0 }] }, 'r5.mp4');
  assert.ok(meanVolume(r.out, 0, 2.5) < -60, 'громкость 0 = тишина');
  r = await run({ aspect: 'original', clips: [{ ...base, volume: 1 }] }, 'r5b.mp4');
  assert.ok(meanVolume(r.out, 0, 2.5) > -30, 'громкость 1 = звук есть');

  // 6. Хромакей: цветной фон и фон-картинка
  const green = { file: P('green.mp4'), in: 0, out: 3, chroma: { enabled: true, color: '#00ff00', similarity: 0.2, blend: 0.1, despill: true } };
  r = await run({ aspect: '16:9', fit: 'fit', clips: [{ ...green, chroma: { ...green.chroma, bg: { type: 'color', color: '#0000ff' } } }] }, 'r6.mp4');
  i = await info(r.out);
  assert.strictEqual(`${i.width}x${i.height}`, '1920x1080');
  const frameColors = (file, x, y) => {
    const rr = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer' });
    return Array.from(rr.stdout.subarray(0, 3));
  };
  const corner = frameColors(r.out, 20, 20);
  const center = frameColors(r.out, 960, 540);
  assert.ok(corner[2] > 150 && corner[1] < 100, 'зелёный фон заменён на синий: ' + corner);
  assert.ok(center[0] > 150 && center[1] < 100, 'красный объект остался: ' + center);

  r = await run({ aspect: '9:16', fit: 'fill', clips: [{ ...green, chroma: { ...green.chroma, bg: { type: 'file', file: P('bg.png') } } }] }, 'r6b.mp4');
  i = await info(r.out);
  assert.strictEqual(`${i.width}x${i.height}`, '1080x1920');

  // 7. Предпросмотр кадра
  const url = await previewFrame({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe, index: 0, at: 1,
    rawProject: { aspect: '9:16', fit: 'blur', clips: [{ ...base }] },
  });
  assert.ok(url.startsWith('data:image/png;base64,') && url.length > 1000, 'кадр предпросмотра');
  const url2 = await previewFrame({
    job: new Job(), ffmpegPath: ffmpeg, ffprobePath: ffprobe, index: 0, at: 0.5,
    rawProject: { aspect: '16:9', clips: [{ ...green, chroma: { ...green.chroma, bg: { type: 'color', color: '#ff00ff' } } }] },
  });
  assert.ok(url2.length > 1000, 'кадр предпросмотра с хромакеем');

  // 8. Ошибки понятны
  await assert.rejects(run({ clips: [] }, 'e1.mp4'), /хотя бы один клип/);
  await assert.rejects(run({ clips: [{ file: P('a.mp4'), in: 3, out: 2 }] }, 'e2.mp4'), /конец должен быть позже/);
  await assert.rejects(run({ clips: [{ file: P('nope.mp4'), in: 0, out: 2 }] }, 'e3.mp4'), /Файл не найден/);
  await assert.rejects(run({ clips: [{ ...base, in: 50, out: 60 }] }, 'e4.mp4'), /за пределы/);

  // 9. Отмена
  const job = new Job();
  const p = exportProject({ job, ffmpegPath: ffmpeg, ffprobePath: ffprobe, rawProject: { aspect: '9:16', clips: [{ ...base }] }, outFile: P('cancel.mp4') });
  setTimeout(() => job.cancel(), 30);
  await assert.rejects(p, (e) => e.name === 'CancelledError' || /Отмен|Не удалось/.test(e.message));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('OK: монтаж проверен');
})().catch((e) => { console.error(e); process.exit(1); });
