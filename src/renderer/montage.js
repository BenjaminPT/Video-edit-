'use strict';

// Вкладка «Монтаж»: список клипов, редактор выбранного клипа и настройки всего ролика.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.clipper;

  const el = {
    viewCut: $('view-cut'), viewM: $('view-montage'),
    add: $('m-add'), fromCut: $('m-from-cut'), list: $('m-list'), empty: $('m-empty'),
    editor: $('m-editor'), project: $('m-project'), video: $('m-video'),
    inP: $('m-in'), outP: $('m-out'), inNow: $('m-in-now'), outNow: $('m-out-now'),
    sliders: $('m-sliders'),
    chroma: $('m-chroma'), chromaBox: $('m-chroma-box'), key: $('m-key'), despill: $('m-despill'),
    chromaSliders: $('m-chroma-sliders'), bgColor: $('m-bg-color'), bgColorWrap: $('m-bg-color-wrap'),
    bgFileWrap: $('m-bg-file-wrap'), bgName: $('m-bg-name'), bgPick: $('m-bg-pick'),
    frameBtn: $('m-frame-btn'), frame: $('m-frame'),
    fitField: $('m-fit-field'), projectSliders: $('m-project-sliders'),
    musicName: $('m-music-name'), musicPick: $('m-music-pick'), musicClear: $('m-music-clear'),
    musicBox: $('m-music-box'), musicSliders: $('m-music-sliders'), duck: $('m-duck'),
    caption: $('m-caption'), captionSliders: $('m-caption-sliders'), loud: $('m-loud'),
    exportBtn: $('m-export'), progress: $('m-progress'), pct: $('m-pct'), fill: $('m-fill'),
    status: $('m-status'), show: $('m-show'),
  };

  const m = {
    clips: [],
    sel: -1,
    aspect: 'original',
    fit: 'fill',
    transition: 0,
    caption: { text: '', position: 'bottom', size: 64 },
    music: null,
    loudnorm: false,
    caps: null,
    nextId: 1,
    busy: false,
    lastFile: null,
    cutCount: 0,
  };

  const pad = (n) => String(n).padStart(2, '0');
  const clock = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}.${Math.floor((s % 1) * 10)}`;
  const baseName = (p) => String(p).split(/[\\/]/).pop();
  const cur = () => m.clips[m.sel];

  function setStatus(text, kind = '') {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---- Вкладки ----

  function syncTabThumb() {
    document.querySelectorAll('.tabs').forEach((seg) => {
      const inputs = Array.from(seg.querySelectorAll('input'));
      seg.style.setProperty('--i', Math.max(0, inputs.findIndex((i) => i.checked)));
    });
  }
  function showTab(name) {
    const input = document.querySelector(`input[name="tab"][value="${name}"]`);
    input.checked = true;
    el.viewCut.hidden = name !== 'cut';
    el.viewM.hidden = name !== 'montage';
    if (name !== 'montage') el.video.pause();
    syncTabThumb();
    if (name === 'montage' && !m.caps) loadCaps();
  }
  document.querySelectorAll('input[name="tab"]').forEach((i) => i.addEventListener('change', () => showTab(i.value)));

  async function loadCaps() {
    const res = await api.montageCaps();
    m.caps = res.ok ? res.data : {};
    const c = m.caps;
    // Функции, которых нет в этой сборке ffmpeg, не показываем как рабочие.
    $('m-chroma').disabled = !c.chromakey;
    if (!c.chromakey) $('m-chroma').closest('fieldset').querySelector('.hint').textContent = 'В этой сборке ffmpeg хромакея нет';
    el.caption.disabled = !c.drawtext;
    if (!c.drawtext) el.caption.placeholder = 'Подписи недоступны: на компьютере не нашёлся шрифт';
    el.loud.disabled = !c.loudnorm;
  }

  // ---- Ползунки ----

  const syncers = [];
  /** Ползунок с подписью и значением; sync() подтягивает его к текущему состоянию. */
  function slider(host, { label, min, max, step, get, set, fmt }) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'field-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const out = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    const id = 'ms' + Math.random().toString(36).slice(2, 8);
    input.id = id;
    lab.htmlFor = id;
    row.append(lab, out);
    wrap.append(row, input);
    host.append(wrap);
    const sync = () => {
      const v = get();
      if (v === undefined) return;
      input.value = v;
      out.textContent = fmt(Number(v));
    };
    input.addEventListener('input', () => { set(Number(input.value)); out.textContent = fmt(Number(input.value)); changed(); });
    syncers.push(sync);
    return sync;
  }
  const pct = (v) => Math.round(v * 100) + '%';
  const secs = (v) => (v ? v.toFixed(1) + ' с' : 'нет');

  function buildSliders() {
    const c = () => cur();
    slider(el.sliders, { label: 'Громкость клипа', min: 0, max: 2, step: 0.05, fmt: pct, get: () => c() && c().volume, set: (v) => (c().volume = v) });
    slider(el.sliders, { label: 'Скорость', min: 0.5, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) + '×', get: () => c() && c().speed, set: (v) => (c().speed = v) });
    slider(el.sliders, { label: 'Плавное появление', min: 0, max: 3, step: 0.1, fmt: secs, get: () => c() && c().fadeIn, set: (v) => (c().fadeIn = v) });
    slider(el.sliders, { label: 'Плавное затухание', min: 0, max: 3, step: 0.1, fmt: secs, get: () => c() && c().fadeOut, set: (v) => (c().fadeOut = v) });
    slider(el.sliders, { label: 'Кадр по горизонтали (при обрезке краёв)', min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.34 ? 'слева' : v > 0.66 ? 'справа' : 'по центру'), get: () => c() && c().posX, set: (v) => (c().posX = v) });
    slider(el.sliders, { label: 'Кадр по вертикали (при обрезке краёв)', min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.34 ? 'сверху' : v > 0.66 ? 'снизу' : 'по центру'), get: () => c() && c().posY, set: (v) => (c().posY = v) });

    slider(el.chromaSliders, { label: 'Сколько цвета убрать', min: 0.02, max: 0.5, step: 0.01, fmt: (v) => v.toFixed(2), get: () => c() && c().chroma.similarity, set: (v) => (c().chroma.similarity = v) });
    slider(el.chromaSliders, { label: 'Мягкость краёв', min: 0, max: 0.5, step: 0.01, fmt: (v) => v.toFixed(2), get: () => c() && c().chroma.blend, set: (v) => (c().chroma.blend = v) });

    slider(el.projectSliders, { label: 'Наплыв между клипами', min: 0, max: 1.5, step: 0.1, fmt: secs, get: () => m.transition, set: (v) => (m.transition = v) });
    slider(el.musicSliders, { label: 'Громкость музыки', min: 0, max: 2, step: 0.05, fmt: pct, get: () => m.music && m.music.volume, set: (v) => (m.music.volume = v) });
    slider(el.captionSliders, { label: 'Размер подписи', min: 20, max: 140, step: 2, fmt: (v) => v + '', get: () => m.caption.size, set: (v) => (m.caption.size = v) });
  }

  // ---- Клипы ----

  function defaultClip(file, info) {
    return {
      id: m.nextId++, file, name: info.name, url: info.url, duration: info.duration, audioStreams: info.audioStreams,
      in: 0, out: Math.round(info.duration * 10) / 10 || 1,
      volume: 1, speed: 1, fadeIn: 0, fadeOut: 0, posX: 0.5, posY: 0.5,
      chroma: { enabled: false, color: '#00ff00', similarity: 0.15, blend: 0.1, despill: true, bg: { type: 'color', color: '#000000', file: '' } },
    };
  }

  async function addFiles(files) {
    setStatus('');
    for (const file of files) {
      const res = await api.montageInfo(file);
      if (!res.ok) { setStatus(`${baseName(file)}: ${res.error}`, 'error'); continue; }
      if (!res.data.hasVideo || res.data.isImage) { setStatus(`${baseName(file)}: это не видео`, 'error'); continue; }
      m.clips.push(defaultClip(file, res.data));
    }
    if (m.sel < 0 && m.clips.length) m.sel = 0;
    render();
    selectClip(m.sel < 0 ? -1 : m.sel);
  }

  function selectClip(i) {
    m.sel = i;
    el.frame.hidden = true;
    const c = cur();
    if (c) {
      el.video.src = c.url;
      el.video.onloadedmetadata = () => { el.video.currentTime = c.in; };
    } else {
      el.video.removeAttribute('src');
    }
    render();
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= m.clips.length) return;
    [m.clips[i], m.clips[j]] = [m.clips[j], m.clips[i]];
    if (m.sel === i) m.sel = j; else if (m.sel === j) m.sel = i;
    render();
  }

  function remove(i) {
    m.clips.splice(i, 1);
    if (m.clips.length === 0) { selectClip(-1); return; }
    selectClip(Math.min(m.sel > i ? m.sel - 1 : m.sel, m.clips.length - 1));
  }

  function iconButton(text, label, onClick, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.disabled = Boolean(disabled) || m.busy;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function render() {
    el.empty.hidden = m.clips.length > 0;
    el.editor.hidden = !cur();
    el.project.hidden = m.clips.length === 0;
    el.fromCut.disabled = m.cutCount === 0 || m.busy;

    el.list.replaceChildren(
      ...m.clips.map((c, i) => {
        const li = document.createElement('li');
        li.className = 'm-item' + (i === m.sel ? ' sel' : '');
        const idx = document.createElement('span'); idx.className = 'idx'; idx.textContent = pad(i + 1);
        const body = document.createElement('span'); body.className = 'body';
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.name; nm.title = c.file;
        const rg = document.createElement('span'); rg.className = 'rg';
        rg.textContent = `${clock(c.in)} – ${clock(c.out)} · ${((c.out - c.in) / c.speed).toFixed(1)} с${c.chroma.enabled ? ' · хромакей' : ''}`;
        body.append(nm, rg);
        li.append(idx, body,
          iconButton('↑', 'Выше', () => move(i, -1), i === 0),
          iconButton('↓', 'Ниже', () => move(i, 1), i === m.clips.length - 1),
          iconButton('✕', 'Убрать из монтажа', () => remove(i)));
        li.addEventListener('click', () => selectClip(i));
        return li;
      })
    );

    const c = cur();
    if (c) {
      el.inP.value = c.in;
      el.outP.value = c.out;
      el.inP.max = el.outP.max = c.duration;
      el.chroma.checked = c.chroma.enabled;
      el.chromaBox.hidden = !c.chroma.enabled;
      el.key.value = c.chroma.color;
      el.despill.checked = c.chroma.despill;
      el.bgColor.value = c.chroma.bg.color;
      const bgType = c.chroma.bg.type;
      document.querySelector(`input[name="m-bg"][value="${bgType}"]`).checked = true;
      el.bgColorWrap.hidden = bgType !== 'color';
      el.bgFileWrap.hidden = bgType !== 'file';
      el.bgName.textContent = c.chroma.bg.file ? baseName(c.chroma.bg.file) : 'Не выбран';
    }
    el.fitField.hidden = false;
    el.musicName.textContent = m.music ? m.music.name : 'Не выбрана';
    el.musicClear.hidden = !m.music;
    el.musicBox.hidden = !m.music;
    document.querySelectorAll('.seg').forEach((seg) => {
      const inputs = Array.from(seg.querySelectorAll('input'));
      seg.style.setProperty('--i', Math.max(0, inputs.findIndex((i) => i.checked)));
    });
    syncers.forEach((fn) => fn());
    updateExport();
  }

  function updateExport() {
    el.exportBtn.textContent = m.busy ? 'Отмена' : 'Собрать ролик';
    el.exportBtn.disabled = !m.busy && m.clips.length === 0;
  }

  // ---- Обновление кадра-предпросмотра, пока человек двигает настройки ----
  let frameTimer = null;
  function changed() {
    // Список обновляем сразу, кадр на экране перерисовываем с небольшой паузой.
    const c = cur();
    const items = el.list.children;
    if (c && items[m.sel]) {
      items[m.sel].querySelector('.rg').textContent =
        `${clock(c.in)} – ${clock(c.out)} · ${((c.out - c.in) / c.speed).toFixed(1)} с${c.chroma.enabled ? ' · хромакей' : ''}`;
    }
    if (!el.frame.hidden) {
      clearTimeout(frameTimer);
      frameTimer = setTimeout(showFrame, 450);
    }
  }

  function project() {
    return {
      aspect: m.aspect,
      fit: m.fit,
      transition: m.transition,
      loudnorm: m.loudnorm,
      caption: m.caption.text.trim() ? m.caption : null,
      music: m.music ? { file: m.music.file, volume: m.music.volume, duck: m.music.duck } : null,
      clips: m.clips.map((c) => ({
        file: c.file, in: c.in, out: c.out, volume: c.volume, speed: c.speed, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
        posX: c.posX, posY: c.posY,
        chroma: c.chroma.enabled ? { enabled: true, color: c.chroma.color, similarity: c.chroma.similarity, blend: c.chroma.blend, despill: c.chroma.despill, bg: c.chroma.bg } : null,
      })),
    };
  }

  async function showFrame() {
    const c = cur();
    if (!c) return;
    el.frameBtn.disabled = true;
    const at = Math.max(0, (el.video.currentTime || c.in) - c.in);
    const res = await api.montagePreview(project(), m.sel, at);
    el.frameBtn.disabled = false;
    if (res.ok) {
      el.frame.src = res.data;
      el.frame.hidden = false;
      setStatus('');
    } else if (!res.cancelled) {
      setStatus(res.error, 'error');
    }
  }
  el.frameBtn.addEventListener('click', showFrame);

  // ---- Поля и переключатели ----

  function numberField(input, key) {
    input.addEventListener('change', () => {
      const c = cur();
      if (!c) return;
      let v = Number(input.value);
      if (!Number.isFinite(v)) v = c[key];
      v = Math.min(Math.max(0, v), c.duration);
      if (key === 'in') v = Math.min(v, c.out - 0.2);
      else v = Math.max(v, c.in + 0.2);
      c[key] = Math.round(v * 10) / 10;
      input.value = c[key];
      if (key === 'in') el.video.currentTime = c.in;
      render();
      changed();
    });
  }
  numberField(el.inP, 'in');
  numberField(el.outP, 'out');
  el.inNow.addEventListener('click', () => { const c = cur(); if (c) { el.inP.value = el.video.currentTime.toFixed(1); el.inP.dispatchEvent(new Event('change')); } });
  el.outNow.addEventListener('click', () => { const c = cur(); if (c) { el.outP.value = el.video.currentTime.toFixed(1); el.outP.dispatchEvent(new Event('change')); } });

  // Плеер показывает только выбранный отрезок.
  el.video.addEventListener('timeupdate', () => {
    const c = cur();
    if (c && el.video.currentTime >= c.out) { el.video.pause(); el.video.currentTime = c.in; }
  });
  el.video.addEventListener('play', () => {
    const c = cur();
    if (c && (el.video.currentTime < c.in || el.video.currentTime >= c.out)) el.video.currentTime = c.in;
  });

  el.chroma.addEventListener('change', () => { const c = cur(); c.chroma.enabled = el.chroma.checked; render(); changed(); });
  el.key.addEventListener('input', () => { cur().chroma.color = el.key.value; changed(); });
  el.despill.addEventListener('change', () => { cur().chroma.despill = el.despill.checked; changed(); });
  el.bgColor.addEventListener('input', () => { cur().chroma.bg.color = el.bgColor.value; changed(); });
  document.querySelectorAll('input[name="m-bg"]').forEach((r) => r.addEventListener('change', () => {
    cur().chroma.bg.type = r.value;
    render();
    changed();
  }));
  el.bgPick.addEventListener('click', async () => {
    const res = await api.pickMedia('background', false);
    if (res.ok && res.data) { cur().chroma.bg.file = res.data; render(); changed(); }
  });

  document.querySelectorAll('input[name="m-aspect"]').forEach((r) => r.addEventListener('change', () => { m.aspect = r.value; render(); changed(); }));
  document.querySelectorAll('input[name="m-fit"]').forEach((r) => r.addEventListener('change', () => { m.fit = r.value; render(); changed(); }));
  document.querySelectorAll('input[name="m-cappos"]').forEach((r) => r.addEventListener('change', () => { m.caption.position = r.value; render(); }));
  el.caption.addEventListener('input', () => { m.caption.text = el.caption.value; });
  el.loud.addEventListener('change', () => { m.loudnorm = el.loud.checked; });
  el.duck.addEventListener('change', () => { if (m.music) m.music.duck = el.duck.checked; });

  el.musicPick.addEventListener('click', async () => {
    const res = await api.pickMedia('audio', false);
    if (res.ok && res.data) {
      m.music = { file: res.data, name: baseName(res.data), volume: 0.5, duck: el.duck.checked };
      render();
    }
  });
  el.musicClear.addEventListener('click', () => { m.music = null; render(); });

  el.add.addEventListener('click', async () => {
    const res = await api.pickMedia('video', true);
    if (res.ok && res.data) addFiles(res.data);
  });
  el.fromCut.addEventListener('click', () => addFiles(lastCut));

  // Из вкладки «Нарезка»
  let lastCut = [];
  document.addEventListener('clipper:cut-done', (e) => { lastCut = e.detail || []; m.cutCount = lastCut.length; render(); });
  document.addEventListener('clipper:to-montage', (e) => {
    lastCut = e.detail || [];
    showTab('montage');
    addFiles(lastCut);
  });

  // ---- Экспорт ----

  api.onMontageProgress(({ value }) => {
    if (!m.busy) return;
    el.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, value))})`;
    el.pct.textContent = Math.round(value * 100) + '%';
  });

  el.exportBtn.addEventListener('click', async () => {
    if (m.busy) { await api.montageCancel(); return; }
    const first = m.clips[0];
    const saveName = baseName(first.file).replace(/\.[^.]+$/, '') + '_montage.mp4';
    const dest = await api.pickSave(saveName);
    if (!dest.ok || !dest.data) return;

    m.busy = true;
    el.video.pause();
    el.show.hidden = true;
    el.progress.hidden = false;
    el.fill.style.transform = 'scaleX(0)';
    el.pct.textContent = '0%';
    setStatus('');
    render();

    const res = await api.montageExport(project(), dest.data);
    m.busy = false;
    el.progress.hidden = true;
    render();
    if (res.ok) {
      m.lastFile = res.data.file;
      el.show.hidden = false;
      setStatus(`Готово: ${res.data.width}×${res.data.height}, ${res.data.duration.toFixed(1)} с`, 'ok');
    } else {
      setStatus(res.cancelled ? 'Отменено' : res.error, res.cancelled ? '' : 'error');
    }
  });
  el.show.addEventListener('click', () => { if (m.lastFile) api.show(m.lastFile); });

  // Перетаскивание файлов на вкладку «Монтаж» добавляет их в монтаж, а не в нарезку.
  document.addEventListener('drop', (e) => {
    if (el.viewM.hidden) return;
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) addFiles(paths);
    e.stopImmediatePropagation();
  }, true);

  buildSliders();
  syncTabThumb();
  render();
})();
