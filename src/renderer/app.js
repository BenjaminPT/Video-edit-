'use strict';

const $ = (id) => document.getElementById(id);
const api = window.clipper;

const el = {
  drop: $('drop'), file: $('file'), fileName: $('file-name'), fileMeta: $('file-meta'),
  fileChange: $('file-change'), fileRemove: $('file-remove'), confirm: $('remove-confirm'),
  removeKeep: $('remove-keep'), removeTrash: $('remove-trash'), removeCancel: $('remove-cancel'),
  orientHint: $('orient-hint'), fastHint: $('fast-hint'), urlForm: $('url-form'), url: $('url'), urlGo: $('url-go'),
  modeHint: $('mode-hint'), countField: $('count-field'), count: $('count'), countOut: $('count-out'),
  fast: $('fast'), outPath: $('out-path'), outChange: $('out-change'),
  run: $('run'), progress: $('progress'), progressLabel: $('progress-label'), progressPct: $('progress-pct'),
  barWrap: document.querySelector('.bar'), barFill: $('bar-fill'), status: $('status'),
  results: $('results'), resultsTitle: $('results-title'), resultsList: $('results-list'),
  openFolder: $('open-folder'), copyTimes: $('copy-times'),
};

const state = { input: null, duration: 0, outDir: '', busy: false, last: null, downloaded: false };

const MODE_HINTS = {
  smart: 'Ищет крики, смех и всплески громкости, режет клип вокруг каждого',
  fixed: 'Режет всё видео подряд на равные куски',
};

const ORIENT_HINTS = {
  horizontal: 'Кадр остаётся как в исходном видео',
  vertical: 'Из центра кадра вырезается полоса 9:16, края слева и справа обрезаются. Клипы 1080×1920',
};
const FAST_HINTS = {
  on: 'Без перекодирования: почти мгновенно, но начало клипа может сдвинуться на пару секунд',
  vertical: 'Недоступно для вертикального формата: кадр нужно перекодировать',
};

const pad = (n) => String(n).padStart(2, '0');
function clock(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}:${pad(m)}` : `${m}`) + `:${pad(s % 60)}`;
}
function human(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} ч ${m} мин`;
  return m ? `${m} мин ${s % 60} с` : `${s} с`;
}

function getMode() { return document.querySelector('input[name="mode"]:checked').value; }
function getOrient() { return document.querySelector('input[name="orient"]:checked').value; }
function getLen() { return Number(document.querySelector('input[name="len"]:checked').value); }

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

// Ползунок переключателя двигается через transform.
function syncSegments() {
  document.querySelectorAll('.seg').forEach((seg) => {
    const inputs = Array.from(seg.querySelectorAll('input'));
    seg.style.setProperty('--i', Math.max(0, inputs.findIndex((i) => i.checked)));
  });
}

function refresh() {
  syncSegments();
  const smart = getMode() === 'smart';
  el.modeHint.textContent = MODE_HINTS[getMode()];
  el.countField.hidden = !smart;
  el.countOut.textContent = el.count.value;
  const vertical = getOrient() === 'vertical';
  el.orientHint.textContent = ORIENT_HINTS[getOrient()];
  el.fast.disabled = vertical;
  el.fast.closest('.check').classList.toggle('disabled', vertical);
  el.fastHint.textContent = vertical ? FAST_HINTS.vertical : FAST_HINTS.on;
  el.outPath.textContent = state.outDir;
  el.outPath.title = state.outDir;
  el.run.disabled = state.busy || !state.input || !state.outDir;
  el.run.textContent = state.busy ? 'Отмена' : 'Нарезать';
  el.run.disabled = !state.busy && (!state.input || !state.outDir);
  el.urlGo.disabled = state.busy;
  el.url.disabled = state.busy;
  el.fileChange.disabled = state.busy;
  el.fileRemove.disabled = state.busy;
  document.querySelectorAll('input[name="orient"]').forEach((i) => (i.disabled = state.busy));
  el.outChange.disabled = state.busy;
}

function setVideo({ file, duration, name, downloaded = false }) {
  state.input = file;
  state.duration = duration;
  state.downloaded = downloaded;
  el.confirm.hidden = true;
  el.drop.hidden = true;
  el.file.hidden = false;
  el.fileName.textContent = name;
  el.fileName.title = file;
  el.fileMeta.textContent = human(duration);
  el.results.hidden = true;
  setStatus('');
  refresh();
}

async function loadFile(file) {
  const res = await api.probe(file);
  if (!res.ok) { setStatus(res.error, 'error'); return; }
  setVideo({ file, duration: res.data.duration, name: res.data.name, downloaded: res.data.downloaded });
}

// Убрать видео из приложения. Файл на диске трогаем только если его скачало приложение
// и человек выбрал «В корзину».
function clearVideo(message = '') {
  state.input = null;
  state.duration = 0;
  state.downloaded = false;
  state.last = null;
  el.confirm.hidden = true;
  el.file.hidden = true;
  el.drop.hidden = false;
  el.results.hidden = true;
  setStatus(message);
  refresh();
}

el.fileRemove.addEventListener('click', () => {
  if (state.busy || !state.input) return;
  if (state.downloaded) {
    el.confirm.hidden = false;
    el.removeKeep.focus();
  } else {
    clearVideo('Видео убрано из приложения. Файл на диске не тронут');
  }
});
el.removeCancel.addEventListener('click', () => { el.confirm.hidden = true; el.fileRemove.focus(); });
el.removeKeep.addEventListener('click', () => clearVideo('Видео убрано из приложения. Файл остался на диске'));
el.removeTrash.addEventListener('click', async () => {
  const res = await api.trash(state.input);
  if (res.ok) clearVideo('Файл отправлен в корзину');
  else setStatus(res.error, 'error');
});

function showProgress({ value, label }) {
  el.progress.hidden = false;
  el.progressLabel.textContent = label || '';
  const known = typeof value === 'number';
  el.barWrap.classList.toggle('busy', !known);
  if (known) {
    el.barFill.style.transform = `scaleX(${Math.max(0, Math.min(1, value))})`;
    el.progressPct.textContent = Math.round(value * 100) + '%';
  } else {
    el.progressPct.textContent = '';
  }
}

function hideProgress() {
  el.progress.hidden = true;
  el.barFill.style.transform = 'scaleX(0)';
}

api.onProgress(showProgress);

// Выбор и перетаскивание файла
async function pick() {
  const file = await api.pickVideo();
  if (!file.ok || !file.data) return;
  loadFile(file.data);
}

el.drop.addEventListener('click', pick);
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
});
el.fileChange.addEventListener('click', pick);

['dragenter', 'dragover'].forEach((type) =>
  document.addEventListener(type, (e) => {
    e.preventDefault();
    if (!state.busy) el.drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((type) =>
  document.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'dragleave' && e.relatedTarget) return;
    el.drop.classList.remove('over');
  })
);
document.addEventListener('drop', (e) => {
  if (state.busy) return;
  const dropped = e.dataTransfer && e.dataTransfer.files[0];
  if (!dropped) return;
  const file = api.pathForFile(dropped);
  if (file) loadFile(file);
});

el.outChange.addEventListener('click', async () => {
  const res = await api.pickFolder();
  if (res.ok && res.data) { state.outDir = res.data; refresh(); }
});

// Загрузка по ссылке
el.urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = el.url.value.trim();
  if (!url || state.busy) return;
  state.busy = true;
  el.run.textContent = 'Отмена';
  refresh();
  el.run.disabled = false;
  setStatus('');
  showProgress({ value: null, label: 'Готовлю загрузчик' });
  const res = await api.download(url, state.outDir);
  state.busy = false;
  hideProgress();
  if (res.ok) {
    setVideo({ file: res.data.file, duration: res.data.duration, name: res.data.name, downloaded: res.data.downloaded });
    el.url.value = '';
  } else if (!res.cancelled) {
    setStatus(res.error, 'error');
  } else {
    setStatus('Отменено');
  }
  refresh();
});

// Нарезка и отмена
el.run.addEventListener('click', async () => {
  if (state.busy) { await api.cancel(); return; }
  state.busy = true;
  refresh();
  el.run.disabled = false;
  el.results.hidden = true;
  setStatus('');
  showProgress({ value: 0, label: 'Начинаю' });

  const res = await api.run({
    input: state.input,
    outDir: state.outDir,
    mode: getMode(),
    clipLen: getLen(),
    orientation: getOrient(),
    count: Number(el.count.value),
    fast: el.fast.checked,
  });

  state.busy = false;
  hideProgress();
  refresh();

  if (!res.ok) {
    setStatus(res.cancelled ? 'Отменено' : res.error, res.cancelled ? '' : 'error');
    return;
  }
  renderResults(res.data);
});

function renderResults(data) {
  state.last = data;
  if (!data.clips.length) {
    setStatus(data.note || 'Клипов нет');
    return;
  }
  el.resultsTitle.textContent = `Готово: ${data.clips.length} ${plural(data.clips.length)}`;
  el.resultsList.replaceChildren(
    ...data.clips.map((c, i) => {
      const li = document.createElement('li');
      li.style.setProperty('--i', i);
      li.append(
        cell('idx num', String(c.index).padStart(2, '0')),
        cell('time', `${clock(c.start)} – ${clock(c.end)}`),
        cell('score', c.score ? `+${c.score} дБ` : '')
      );
      return li;
    })
  );
  el.results.hidden = false;
  setStatus(data.note || 'Клипы сохранены', data.note ? '' : 'ok');
}

function plural(n) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return 'клип';
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return 'клипа';
  return 'клипов';
}

function cell(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

el.openFolder.addEventListener('click', () => {
  if (state.last && state.last.folder) api.show(state.last.folder);
});

el.copyTimes.addEventListener('click', async () => {
  if (!state.last) return;
  const text = state.last.clips.map((c) => `${clock(c.start)} - ${clock(c.end)}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Таймкоды скопированы', 'ok');
  } catch (_) {
    setStatus('Не удалось скопировать', 'error');
  }
});

document.querySelectorAll('input[name="mode"], input[name="len"], input[name="orient"]').forEach((i) => i.addEventListener('change', refresh));
el.count.addEventListener('input', refresh);

(async function init() {
  const d = await api.defaults();
  if (d.ok) state.outDir = d.data.outDir;
  refresh();
})();
