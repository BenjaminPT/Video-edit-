'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_TRACKS = 4;
const FPS = 30; // значение по умолчанию; в проекте можно выбрать 24, 30 или 60
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

const CANVAS = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
};

const num = (v, min, max, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const f3 = (n) => String(Math.round(n * 1000) / 1000);

function hexColor(value, def) {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? '0x' + value.slice(1) : def;
}

/** Какие фильтры есть в ffmpeg: от них зависят функции монтажа. */
const capsCache = new Map();
function probeCapabilities({ job, ffmpegPath }) {
  if (!capsCache.has(ffmpegPath)) {
    const p = probeCapabilitiesNow({ job, ffmpegPath }).catch((e) => { capsCache.delete(ffmpegPath); throw e; });
    capsCache.set(ffmpegPath, p);
  }
  return capsCache.get(ffmpegPath);
}

// Видеокарта: пробуем закодировать один кадр, потому что кодек в списке ещё не значит, что он работает.
const HW_ENCODERS = ['h264_nvenc', 'h264_videotoolbox', 'h264_qsv', 'h264_amf'];
async function probeHardware({ job, ffmpegPath, encoders }) {
  for (const name of HW_ENCODERS) {
    if (!new RegExp(`\\s${name}\\s`).test(encoders)) continue;
    const { code } = await job.run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.2',
      '-c:v', name, '-f', 'null', '-',
    ]);
    if (code === 0) return name;
  }
  return null;
}

async function probeCapabilitiesNow({ job, ffmpegPath }) {
  let out = '';
  await job.run(ffmpegPath, ['-hide_banner', '-filters'], { onStdout: (d) => (out += d.toString()) });
  let enc = '';
  await job.run(ffmpegPath, ['-hide_banner', '-encoders'], { onStdout: (d) => (enc += d.toString()) });
  const has = (name) => new RegExp(`\\s${name}\\s`).test(out);
  const hw = await probeHardware({ job, ffmpegPath, encoders: enc });
  return {
    hwEncoder: hw,
    h265: /\slibx265\s/.test(enc),
    chromakey: has('chromakey'),
    despill: has('despill'),
    xfade: has('xfade'),
    acrossfade: has('acrossfade'),
    sidechain: has('sidechaincompress'),
    loudnorm: has('loudnorm'),
    drawtext: has('drawtext') && Boolean(findFont()),
  };
}

/** Шрифт для подписей: берём системный, свой в приложение не кладём. */
function findFont() {
  const candidates = [
    'C:/Windows/Fonts/arial.ttf',
    'C:/Windows/Fonts/segoeui.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ];
  return candidates.find((f) => fs.existsSync(f)) || null;
}

/** Путь внутри строки фильтра: слэши прямые, двоеточия экранированы. */
function filterPath(p) {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")}'`;
}

/** Размеры, звук и длительность файла одним вызовом ffprobe. */
async function probeFile({ job, ffprobePath, file }) {
  let out = '';
  const { code, stderr } = await job.run(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file],
    { onStdout: (d) => (out += d.toString()) }
  );
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (_) { /* ниже */ }
  if (code !== 0 || !parsed) throw new Error('Не удалось прочитать файл: ' + (stderr.trim().split('\n').pop() || file));
  const streams = parsed.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const duration = parsed.format ? parseFloat(parsed.format.duration) : NaN;
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
    width: video ? video.width : 0,
    height: video ? video.height : 0,
    hasVideo: Boolean(video),
    isImage: IMAGE_EXT.has(path.extname(file).toLowerCase()),
  };
}

function canvasFor(project, infos) {
  const [bw, bh] = baseCanvas(project, infos);
  const target = project.render && project.render.resolution !== 'source' ? Number(project.render.resolution) : 0;
  if (!target) return [bw, bh];
  const k = target / Math.min(bw, bh);
  return [even(bw * k), even(bh * k)];
}

function baseCanvas(project, infos) {
  if (CANVAS[project.aspect]) return CANVAS[project.aspect];
  const first = infos.find((i) => i.width > 0) || { width: 1920, height: 1080 };
  let w = first.width;
  let h = first.height;
  const k = Math.min(1, 1920 / Math.max(w, h));
  w *= k; h *= k;
  return [even(w), even(h)];
}

/** Проверка и приведение проекта к безопасному виду. Всё, что приходит из окна, не доверяем. */
function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Пустой проект');
  const clips = Array.isArray(raw.clips) ? raw.clips : [];
  if (clips.length === 0) throw new Error('Добавь хотя бы один клип');
  if (clips.length > 50) throw new Error('В проекте может быть не больше 50 клипов');

  const project = {
    aspect: ['original', ...Object.keys(CANVAS)].includes(raw.aspect) ? raw.aspect : 'original',
    fit: ['fill', 'fit', 'blur'].includes(raw.fit) ? raw.fit : 'fill',
    transition: num(raw.transition, 0, 1.5, 0),
    loudnorm: Boolean(raw.loudnorm),
    caption: null,
    music: null,
    render: {
      resolution: ['source', '480', '720', '1080', '1440', '2160'].includes(String(raw.render && raw.render.resolution)) ? String(raw.render.resolution) : 'source',
      fps: [24, 30, 60].includes(Number(raw.render && raw.render.fps)) ? Number(raw.render.fps) : 30,
      quality: ['draft', 'fast', 'balanced', 'high'].includes(raw.render && raw.render.quality) ? raw.render.quality : 'fast',
      codec: raw.render && raw.render.codec === 'h265' ? 'h265' : 'h264',
      hw: !raw.render || raw.render.hw !== false,
    },
    clips: [],
  };

  if (raw.caption && typeof raw.caption.text === 'string' && raw.caption.text.trim()) {
    project.caption = {
      text: raw.caption.text.slice(0, 200),
      position: ['top', 'center', 'bottom'].includes(raw.caption.position) ? raw.caption.position : 'bottom',
      size: num(raw.caption.size, 20, 140, 64),
    };
  }
  if (raw.music && typeof raw.music.file === 'string' && raw.music.file) {
    project.music = {
      file: raw.music.file,
      volume: num(raw.music.volume, 0, 2, 0.5),
      duck: raw.music.duck !== false,
    };
  }

  clips.forEach((c, i) => {
    if (!c || typeof c.file !== 'string' || !c.file) throw new Error(`Клип ${i + 1}: не указан файл`);
    const inP = num(c.in, 0, 1e6, 0);
    const outP = num(c.out, 0, 1e6, 0);
    if (!(outP > inP + 0.1)) throw new Error(`Клип ${i + 1}: конец должен быть позже начала`);
    const ch = c.chroma && c.chroma.enabled ? c.chroma : null;
    const bg = ch && ch.bg && ch.bg.type === 'file' && typeof ch.bg.file === 'string' && ch.bg.file ? ch.bg : null;
    const ovRaw = c.overlay && typeof c.overlay.file === 'string' && c.overlay.file ? c.overlay : null;
    const ovCh = ovRaw && ovRaw.chroma && ovRaw.chroma.enabled ? ovRaw.chroma : null;
    project.clips.push({
      overlay: ovRaw && {
        file: ovRaw.file,
        scale: num(ovRaw.scale, 5, 100, 30),
        posX: num(ovRaw.posX, 0, 1, 0.85),
        posY: num(ovRaw.posY, 0, 1, 0.15),
        opacity: num(ovRaw.opacity, 0.1, 1, 1),
        chroma: ovCh && {
          color: hexColor(ovCh.color, '0x00ff00'),
          similarity: num(ovCh.similarity, 0.01, 0.6, 0.15),
          blend: num(ovCh.blend, 0, 0.5, 0.1),
          despill: ovCh.despill !== false,
        },
      },
      file: c.file,
      in: inP,
      out: outP,
      volume: num(c.volume, 0, 2, 1),
      speed: num(c.speed, 0.5, 2, 1),
      fadeIn: num(c.fadeIn, 0, 3, 0),
      fadeOut: num(c.fadeOut, 0, 3, 0),
      posX: num(c.posX, 0, 1, 0.5),
      posY: num(c.posY, 0, 1, 0.5),
      chroma: ch && {
        color: hexColor(ch.color, '0x00ff00'),
        similarity: num(ch.similarity, 0.01, 0.6, 0.15),
        blend: num(ch.blend, 0, 0.5, 0.1),
        despill: ch.despill !== false,
        bg: bg ? { type: 'file', file: bg.file } : { type: 'color', color: hexColor(ch.bg && ch.bg.color, '0x000000') },
      },
    });
  });
  return project;
}

/**
 * Видеоцепочка одного клипа до кадра нужного размера.
 * inputLabel: метка исходного видео, bgLabel: метка фона для хромакея (или null).
 * Возвращает строки фильтров и метку результата.
 */
function videoChain({ n, inputLabel, bgInput, ovInput, clip, W, H, dur, fit, fps = FPS }) {
  const out = `v${n}`;
  const parts = [];
  let chain = `[${inputLabel}]setpts=(PTS-STARTPTS)/${f3(clip.speed)},fps=${fps}`;

  if (clip.chroma) {
    const c = clip.chroma;
    chain += `,chromakey=color=${c.color}:similarity=${f3(c.similarity)}:blend=${f3(c.blend)}`;
    if (c.despill) chain += `,despill=type=green`;
    // Вырезанный объект кладём на фон по центру: «заполнить» растягивает его на весь кадр.
    chain += fit === 'fill'
      ? `,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)*${f3(clip.posX)}:(ih-oh)*${f3(clip.posY)}`
      : `,scale=${W}:${H}:force_original_aspect_ratio=decrease`;
    chain += `,format=yuva420p[k${n}]`;
    parts.push(chain);
    parts.push(`[${bgInput}]fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[b${n}]`);
    parts.push(`[b${n}][k${n}]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto,setsar=1`);
  } else if (fit === 'fit') {
    parts.push(`${chain},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`);
  } else if (fit === 'blur') {
    parts.push(`${chain},split[s${n}a][s${n}b]`);
    parts.push(`[s${n}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:5[bl${n}]`);
    parts.push(`[s${n}b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg${n}]`);
    parts.push(`[bl${n}][fg${n}]overlay=(W-w)/2:(H-h)/2,setsar=1`);
  } else {
    parts.push(`${chain},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)*${f3(clip.posX)}:(ih-oh)*${f3(clip.posY)},setsar=1`);
  }

  // Накладка (второе видео или фото) кладётся поверх готового кадра.
  const ov = clip.overlay;
  if (ov && ovInput) {
    parts[parts.length - 1] += `[base${n}]`;
    let o = `[${ovInput}]setpts=PTS-STARTPTS,fps=${fps},format=rgba`;
    if (ov.chroma) {
      o += `,chromakey=color=${ov.chroma.color}:similarity=${f3(ov.chroma.similarity)}:blend=${f3(ov.chroma.blend)}`;
      if (ov.chroma.despill) o += ',despill=type=green';
    }
    o += `,scale=${even((W * ov.scale) / 100)}:-2,format=yuva420p`;
    if (ov.opacity < 1) o += `,colorchannelmixer=aa=${f3(ov.opacity)}`;
    parts.push(`${o}[ov${n}]`);
    parts.push(`[base${n}][ov${n}]overlay=(W-w)*${f3(ov.posX)}:(H-h)*${f3(ov.posY)}:shortest=1:format=auto,setsar=1`);
  }

  // Последняя строка в parts остаётся без метки: дописываем затухания и метку результата.
  let tail = ',format=yuv420p';
  if (clip.fadeIn > 0) tail += `,fade=t=in:st=0:d=${f3(Math.min(clip.fadeIn, dur))}`;
  if (clip.fadeOut > 0) {
    const d = Math.min(clip.fadeOut, dur);
    tail += `,fade=t=out:st=${f3(Math.max(0, dur - d))}:d=${f3(d)}`;
  }
  parts[parts.length - 1] += `${tail}[${out}]`;
  return { parts, label: out };
}

/** Входные параметры накладки: фото крутится, видео зацикливается. */
function overlayInputArgs(file, dur) {
  const isImg = IMAGE_EXT.has(path.extname(file).toLowerCase());
  return [...(isImg ? ['-loop', '1'] : ['-stream_loop', '-1']), '-t', f3(dur), '-i', file];
}

function atempoChain(speed) {
  return Math.abs(speed - 1) < 0.001 ? '' : `,atempo=${f3(speed)}`;
}

function audioChain({ n, i, tracks, clip, dur }) {
  const out = `a${n}`;
  const parts = [];
  const tail = `aresample=async=1:first_pts=0${atempoChain(clip.speed)},volume=${f3(clip.volume)}`;
  const fades =
    (clip.fadeIn > 0 ? `,afade=t=in:st=0:d=${f3(Math.min(clip.fadeIn, dur))}` : '') +
    (clip.fadeOut > 0 ? `,afade=t=out:st=${f3(Math.max(0, dur - Math.min(clip.fadeOut, dur)))}:d=${f3(Math.min(clip.fadeOut, dur))}` : '');
  const norm = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

  if (tracks <= 0) {
    parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${f3(dur)},asetpts=PTS-STARTPTS${fades}[${out}]`);
  } else if (tracks === 1) {
    parts.push(`[${i}:a:0]${norm},${tail}${fades},${norm}[${out}]`);
  } else {
    const ins = [];
    for (let t = 0; t < tracks; t++) {
      parts.push(`[${i}:a:${t}]${norm}[m${n}_${t}]`);
      ins.push(`[m${n}_${t}]`);
    }
    parts.push(`${ins.join('')}amix=inputs=${tracks}:duration=longest:dropout_transition=0,volume=${tracks},${tail}${fades},${norm}[${out}]`);
  }
  return { parts, label: out };
}

/**
 * Собирает аргументы ffmpeg для экспорта проекта.
 * infos: результат probeFile по каждому клипу (в том же порядке).
 * musicInfo: probeFile музыки или null. tmpDir: куда класть текст подписи.
 */
function buildExport({ project, infos, musicInfo, caps, tmpDir, outFile, useHw = false }) {
  const [W, H] = canvasFor(project, infos);
  const fps = project.render.fps;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const graph = [];
  const vLabels = [];
  const aLabels = [];
  const durs = [];
  let inputCount = 0;

  project.clips.forEach((clip, n) => {
    const info = infos[n];
    const srcLen = Math.min(clip.out, info.duration || clip.out) - clip.in;
    if (!(srcLen > 0.1)) throw new Error(`Клип ${n + 1}: отрезок выходит за пределы видео`);
    const dur = srcLen / clip.speed;
    durs.push(dur);

    const i = inputCount++;
    args.push('-ss', f3(clip.in), '-t', f3(srcLen), '-i', clip.file);

    let bgInput = null;
    if (clip.chroma) {
      if (!caps.chromakey) throw new Error('Эта сборка ffmpeg не умеет хромакей');
      const j = inputCount++;
      if (clip.chroma.bg.type === 'file') {
        const isImg = IMAGE_EXT.has(path.extname(clip.chroma.bg.file).toLowerCase());
        args.push(...(isImg ? ['-loop', '1'] : ['-stream_loop', '-1']), '-t', f3(dur), '-i', clip.chroma.bg.file);
      } else {
        args.push('-f', 'lavfi', '-i', `color=c=${clip.chroma.bg.color}:s=${W}x${H}:r=${fps}:d=${f3(dur)}`);
      }
      bgInput = `${j}:v`;
    }

    let ovInput = null;
    if (clip.overlay) {
      if (clip.overlay.chroma && !caps.chromakey) throw new Error('Эта сборка ffmpeg не умеет хромакей');
      const k = inputCount++;
      args.push(...overlayInputArgs(clip.overlay.file, dur));
      ovInput = `${k}:v`;
    }

    const v = videoChain({ n, inputLabel: `${i}:v:0`, bgInput, ovInput, clip, W, H, dur, fit: project.fit, fps });
    graph.push(...v.parts);
    vLabels.push(v.label);

    const tracks = info.audioStreams === 0 ? 0 : Math.min(info.audioStreams, MAX_TRACKS);
    const a = audioChain({ n, i, tracks, clip, dur });
    graph.push(...a.parts);
    aLabels.push(a.label);
  });

  // Склейка: резкая или с переходом-наплывом.
  let total = durs.reduce((s, d) => s + d, 0);
  let vOut;
  let aOut;
  const N = project.clips.length;
  if (N === 1) {
    vOut = vLabels[0];
    aOut = aLabels[0];
  } else {
    const t = project.transition > 0 && caps.xfade && caps.acrossfade ? Math.min(project.transition, Math.min(...durs) / 2) : 0;
    if (t > 0) {
      let acc = durs[0];
      let vPrev = vLabels[0];
      let aPrev = aLabels[0];
      for (let k = 1; k < N; k++) {
        const vNext = k === N - 1 ? 'vj' : `xv${k}`;
        const aNext = k === N - 1 ? 'aj' : `xa${k}`;
        graph.push(`[${vPrev}][${vLabels[k]}]xfade=transition=fade:duration=${f3(t)}:offset=${f3(acc - t)}[${vNext}]`);
        graph.push(`[${aPrev}][${aLabels[k]}]acrossfade=d=${f3(t)}[${aNext}]`);
        acc += durs[k] - t;
        vPrev = vNext;
        aPrev = aNext;
      }
      total = acc;
      vOut = 'vj';
      aOut = 'aj';
    } else {
      graph.push(`${vLabels.map((v, k) => `[${v}][${aLabels[k]}]`).join('')}concat=n=${N}:v=1:a=1[vj][aj]`);
      vOut = 'vj';
      aOut = 'aj';
    }
  }

  // Подпись поверх всего ролика.
  if (project.caption && caps.drawtext) {
    const textFile = path.join(tmpDir, 'caption.txt');
    fs.writeFileSync(textFile, project.caption.text, 'utf8');
    const size = Math.round((H * project.caption.size) / 1080);
    const y = { top: `h*0.08`, center: `(h-text_h)/2`, bottom: `h-text_h-h*0.08` }[project.caption.position];
    graph.push(
      `[${vOut}]drawtext=fontfile=${filterPath(findFont())}:textfile=${filterPath(textFile)}:expansion=none:` +
      `fontsize=${size}:fontcolor=white:borderw=${Math.max(2, Math.round(size / 18))}:bordercolor=black:x=(w-text_w)/2:y=${y}[vcap]`
    );
    vOut = 'vcap';
  }

  // Музыка поверх, с приглушением под голос.
  if (project.music && musicInfo) {
    const m = inputCount++;
    args.push('-stream_loop', '-1', '-i', project.music.file);
    graph.push(
      `[${m}:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=0:${f3(total)},asetpts=PTS-STARTPTS,` +
      `volume=${f3(project.music.volume)},afade=t=out:st=${f3(Math.max(0, total - 1.5))}:d=1.5[mus]`
    );
    if (project.music.duck && caps.sidechain) {
      graph.push(`[${aOut}]asplit=2[vo][sc]`);
      graph.push(`[mus][sc]sidechaincompress=threshold=0.03:ratio=10:attack=20:release=500[duck]`);
      graph.push(`[vo][duck]amix=inputs=2:duration=first:dropout_transition=0,volume=2[amx]`);
    } else {
      graph.push(`[${aOut}][mus]amix=inputs=2:duration=first:dropout_transition=0,volume=2[amx]`);
    }
    aOut = 'amx';
  }

  if (project.loudnorm && caps.loudnorm) {
    graph.push(`[${aOut}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aln]`);
    aOut = 'aln';
  }

  args.push(
    '-filter_complex', graph.join(';'),
    '-map', `[${vOut}]`, '-map', `[${aOut}]`,
    '-t', f3(total),
    ...encoderArgs(project.render, caps, useHw), '-r', String(fps),
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
    outFile
  );
  return { args, total, width: W, height: H };
}

const QUALITY = {
  draft: { preset: 'ultrafast', crf: 30, audio: '128k', hwq: 32 },
  fast: { preset: 'veryfast', crf: 24, audio: '160k', hwq: 26 },
  balanced: { preset: 'veryfast', crf: 20, audio: '192k', hwq: 22 },
  high: { preset: 'medium', crf: 17, audio: '256k', hwq: 18 },
};

/** Параметры кодирования видео и звука. useHw: пробуем видеокарту (только для H.264). */
function encoderArgs(render, caps, useHw) {
  const q = QUALITY[render.quality];
  const audio = ['-c:a', 'aac', '-b:a', q.audio, '-ar', '48000'];
  if (render.codec === 'h265' && caps.h265) {
    return [
      '-c:v', 'libx265', '-preset', q.preset === 'medium' ? 'medium' : 'veryfast', '-crf', String(q.crf + 4),
      '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', ...audio,
    ];
  }
  if (useHw && caps.hwEncoder) {
    const hw = {
      h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(q.hwq), '-b:v', '0'],
      h264_videotoolbox: ['-c:v', 'h264_videotoolbox', '-q:v', String(Math.max(30, 100 - q.hwq * 2)), '-allow_sw', '1'],
      h264_qsv: ['-c:v', 'h264_qsv', '-global_quality', String(q.hwq), '-preset', 'veryfast'],
      h264_amf: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(q.hwq), '-qp_p', String(q.hwq + 2)],
    }[caps.hwEncoder];
    return [...hw, '-pix_fmt', 'yuv420p', ...audio];
  }
  return ['-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), '-pix_fmt', 'yuv420p', '-threads', '0', ...audio];
}

async function probeAll({ job, ffprobePath, project }) {
  const infos = [];
  for (const clip of project.clips) {
    if (!fs.existsSync(clip.file)) throw new Error('Файл не найден: ' + path.basename(clip.file));
    const info = await probeFile({ job, ffprobePath, file: clip.file });
    if (!info.hasVideo) throw new Error('В файле нет видео: ' + path.basename(clip.file));
    infos.push(info);
  }
  let musicInfo = null;
  if (project.music) {
    if (!fs.existsSync(project.music.file)) throw new Error('Файл музыки не найден');
    musicInfo = await probeFile({ job, ffprobePath, file: project.music.file });
    if (musicInfo.audioStreams === 0) throw new Error('В файле музыки нет звука');
  }
  for (const clip of project.clips) {
    if (clip.overlay) {
      if (!fs.existsSync(clip.overlay.file)) throw new Error('Файл накладки не найден: ' + path.basename(clip.overlay.file));
      const oi = await probeFile({ job, ffprobePath, file: clip.overlay.file });
      if (!oi.hasVideo) throw new Error('В файле накладки нет картинки: ' + path.basename(clip.overlay.file));
    }
    if (clip.chroma && clip.chroma.bg.type === 'file' && !fs.existsSync(clip.chroma.bg.file)) {
      throw new Error('Файл фона не найден');
    }
  }
  return { infos, musicInfo };
}

/** Экспорт проекта в один mp4. onProgress(0..1). */
async function exportProject({ job, ffmpegPath, ffprobePath, rawProject, outFile, onProgress }) {
  const project = normalizeProject(rawProject);
  if (typeof outFile !== 'string' || !outFile) throw new Error('Не выбран файл для результата');
  const caps = await probeCapabilities({ job, ffmpegPath });
  const { infos, musicInfo } = await probeAll({ job, ffprobePath, project });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-'));
  try {
    const attempt = async (useHw) => {
      const built = buildExport({ project, infos, musicInfo, caps, tmpDir, outFile, useHw });
      let buf = '';
      const res = await job.run(ffmpegPath, built.args, {
        onStdout: (d) => {
          buf += d.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const m = /^out_time_us=(\d+)/.exec(line);
            if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / built.total));
          }
        },
      });
      return { ...res, built };
    };
    const wantHw = project.render.hw && Boolean(caps.hwEncoder) && project.render.codec === 'h264';
    let { code, stderr, built } = await attempt(wantHw);
    if (code !== 0 && wantHw && !job.cancelled) {
      // Видеокарта не справилась (бывает с большими кадрами): собираем обычным способом.
      ({ code, stderr, built } = await attempt(false));
    }
    if (code !== 0) {
      fs.rmSync(outFile, { force: true });
      throw new Error('Не удалось собрать видео: ' + (stderr.trim().split('\n').slice(-3).join(' | ') || 'код ' + code));
    }
    if (onProgress) onProgress(1);
    return { file: outFile, duration: built.total, width: built.width, height: built.height, encoder: wantHw && code === 0 ? caps.hwEncoder : 'x264' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Один кадр клипа в том виде, как он попадёт в ролик (формат, хромакей, рамка).
 * Возвращает PNG в виде data: URL.
 */
async function previewFrame({ job, ffmpegPath, ffprobePath, rawProject, index, at }) {
  const project = normalizeProject(rawProject);
  const idx = Math.min(Math.max(0, Number(index) || 0), project.clips.length - 1);
  const clip = project.clips[idx];
  const caps = await probeCapabilities({ job, ffmpegPath });
  const only = { ...project, clips: [clip], music: null, caption: null };
  const { infos } = await probeAll({ job, ffprobePath, project: only });
  const [W, H] = canvasFor(project, infos);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-'));
  const png = path.join(tmpDir, 'frame.png');
  try {
    const t = Math.min(Math.max(0, Number(at) || 0), Math.max(0, clip.out - clip.in - 0.05));
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', f3(clip.in + t), '-i', clip.file];
    let bgInput = null;
    if (clip.chroma) {
      if (!caps.chromakey) throw new Error('Эта сборка ffmpeg не умеет хромакей');
      if (clip.chroma.bg.type === 'file') {
        const isImg = IMAGE_EXT.has(path.extname(clip.chroma.bg.file).toLowerCase());
        args.push(...(isImg ? ['-loop', '1'] : []), '-t', '2', '-i', clip.chroma.bg.file);
      } else {
        args.push('-f', 'lavfi', '-i', `color=c=${clip.chroma.bg.color}:s=${W}x${H}:r=${project.render.fps}:d=2`);
      }
      bgInput = '1:v';
    }
    let ovInput = null;
    if (clip.overlay) {
      if (clip.overlay.chroma && !caps.chromakey) throw new Error('Эта сборка ffmpeg не умеет хромакей');
      args.push(...overlayInputArgs(clip.overlay.file, 2));
      ovInput = `${bgInput ? 2 : 1}:v`;
    }
    // В превью скорость не нужна: берём точный кадр.
    const v = videoChain({ n: 0, inputLabel: '0:v:0', bgInput, ovInput, clip: { ...clip, speed: 1, fadeIn: 0, fadeOut: 0 }, W, H, dur: 10, fit: project.fit, fps: project.render.fps });
    const graph = [...v.parts, `[${v.label}]scale=720:-2[out]`].join(';');
    args.push('-filter_complex', graph, '-map', '[out]', '-frames:v', '1', png);
    const { code, stderr } = await job.run(ffmpegPath, args);
    if (code !== 0 || !fs.existsSync(png)) {
      throw new Error('Не удалось показать кадр: ' + (stderr.trim().split('\n').pop() || 'код ' + code));
    }
    return 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { encoderArgs, exportProject, previewFrame, probeCapabilities, probeFile, normalizeProject, buildExport, canvasFor, CANVAS };
