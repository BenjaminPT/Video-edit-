'use strict';

const $ = (id) => document.getElementById(id);
const api = window.clipper;

const el = {
  drop: $('drop'), file: $('file'), fileName: $('file-name'), fileMeta: $('file-meta'),
  fileChange: $('file-change'), fileRemove: $('file-remove'), confirm: $('remove-confirm'),
  removeKeep: $('remove-keep'), removeTrash: $('remove-trash'), removeCancel: $('remove-cancel'),
  urlForm: $('url-form'), url: $('url'), urlGo: $('url-go'),
  modeHint: $('mode-hint'), countField: $('count-field'), count: $('count'), countOut: $('count-out'),
  fast: $('fast'), outPath: $('out-path'), outChange: $('out-change'),
  run: $('run'), progress: $('progress'), progressLabel: $('progress-label'), progressPct: $('progress-pct'),
  barWrap: document.querySelector('.bar'), barFill: $('bar-fill'), status: $('status'),
  results: $('results'), resultsTitle: $('results-title'), resultsList: $('results-list'),
  openFolder: $('open-folder'), copyTimes: $('copy-times'),
};

const state = {
  input: null,
  duration: 0,
  audioStreams: 1,
  outDir: '',
  busy: false, // идёт скачивание или нарезка
  analyzing: false, // идёт фоновый анализ звука
  token: 0, // номер текущего анализа: ответы устаревших анализов игнорируем
  last: null,
  downloaded: false,
};

const MODE_HINTS = {
  smart: 'Ищет реакции стримера: крики, смех, эмоции в голосе. Музыка и шум игры не считаются',
  fixed: 'Режет всё видео подряд на равные куски',
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
function audioText(n) {
  if (n === 0) return 'без звука';
  if (n === 1) return 'звук есть';
  return `${n} ${n < 5 ? 'дорожки' : 'дорожек'} звука`;
}

function getMode() { return document.querySelector('input[name="mode"]:checked').value; }
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
  el.outPath.textContent = state.outDir;
  el.outPath.title = state.outDir;

  // В режиме «по звуку» нарезать можно, когда анализ закончен.
  const waiting = state.analyzing && smart;
  el.run.textContent = state.busy ? 'Отмена' : waiting ? 'Слушаю звук…' : 'Нарезать';
  el.run.disabled = !state.busy && (!state.input || !state.outDir || waiting);

  el.urlGo.disabled = state.busy;
  el.url.disabled = state.busy;
  el.fileChange.disabled = state.busy;
  el.fileRemove.disabled = state.busy;
  el.outChange.disabled = state.busy;
}

/**
 * Анализ звука запускается сразу после появления видео: пока человек выбирает параметры,
 * приложение уже слушает. Когда параметры выбраны, моменты подбираются мгновенно.
 */
async function startAnalysis() {
  const file = state.input;
  const token = ++state.token;
  state.analyzing = true;
  refresh();
  showProgress({ value: 0, label: 'Слушаю звук' });

  const res = await api.analyze(file);
  if (token !== state.token) return; // видео сменили или убрали, пока шёл анализ

  state.analyzing = false;
  hideProgress();
  if (res.ok) {
    state.audioStreams = res.data.audioStreams;
    el.fileMeta.textContent = `${human(res.data.duration)} · ${audioText(res.data.audioStreams)}`;
    if (res.data.audioStreams === 0) {
      const fixed = document.querySelector('input[name="mode"][value="fixed"]');
      fixed.checked = true;
      setStatus('В видео нет звука: режим «По звуку» недоступен, клипы будут без звука', 'error');
    } else {
      setStatus('Звук проанализирован. Выбери параметры и нажми «Нарезать»');
    }
  } else if (!res.cancelled) {
    setStatus(res.error, 'error');
  }
  refresh();
}

// Остановить анализ, если он идёт (видео убрали или заменили).
function stopAnalysis() {
  if (!state.analyzing) return;
  state.token += 1;
  state.analyzing = false;
  hideProgress();
  api.cancel();
}

function setVideo({ file, duration, name, audioStreams = 1, downloaded = false }) {
  state.input = file;
  state.duration = duration;
  state.audioStreams = audioStreams;
  state.downloaded = downloaded;
  el.confirm.hidden = true;
  el.drop.hidden = true;
  el.file.hidden = false;
  el.fileName.textContent = name;
  el.fileName.title = file;
  el.fileMeta.textContent = `${human(duration)} · ${audioText(audioStreams)}`;
  el.results.hidden = true;
  setStatus('');
  refresh();
  startAnalysis();
}

async function loadFile(file) {
  const res = await api.probe(file);
  if (!res.ok) { setStatus(res.error, 'error'); return; }
  setVideo({ file, duration: res.data.duration, name: res.data.name, audioStreams: res.data.audioStreams, downloaded: res.data.downloaded });
}

// Убрать видео из приложения. Файл на диске трогаем только если его скачало приложение
// и человек выбрал «В корзину».
function clearVideo(message = '') {
  stopAnalysis();
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

// Прогресс чужого (отменённого) анализа не показываем.
api.onProgress((p) => {
  if (p.stage === 'analyze' && !state.analyzing && !state.busy) return;
  showProgress(p);
});

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

// Загрузка по ссылке: скачалось, дальше сразу анализ звука, потом параметры.
el.urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = el.url.value.trim();
  if (!url || state.busy) return;
  stopAnalysis();
  state.busy = true;
  refresh();
  el.run.disabled = false;
  setStatus('');
  showProgress({ value: null, label: 'Готовлю загрузчик' });
  const res = await api.download(url, state.outDir);
  state.busy = false;
  hideProgress();
  if (res.ok) {
    el.url.value = '';
    setVideo({
      file: res.data.file, duration: res.data.duration, name: res.data.name,
      audioStreams: res.data.audioStreams, downloaded: res.data.downloaded,
    });
  } else {
    setStatus(res.cancelled ? 'Отменено' : res.error, res.cancelled ? '' : 'error');
    if (state.input) startAnalysis(); // прежнее видео остаётся, дослушиваем его
    else refresh();
  }
});

// Нарезка и отмена
el.run.addEventListener('click', async () => {
  if (state.busy) { await api.cancel(); return; }
  if (state.analyzing) { // режим «подряд» анализа не ждёт
    state.token += 1;
    state.analyzing = false;
  }
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

const AUDIO_WARN = { partial: 'звук пропадает', none: 'нет звука' };

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
      li.style.setProperty('--i', Math.min(i, 12));
      li.append(
        cell('idx num', String(c.index).padStart(2, '0')),
        cell('time', `${clock(c.start)} – ${clock(c.end)}`),
        cell('warn', AUDIO_WARN[c.audio] || ''),
        cell('score', c.score ? `+${c.score} дБ` : '')
      );
      return li;
    })
  );
  el.results.hidden = false;
  const hasWarn = data.clips.some((c) => c.audio !== 'ok');
  setStatus(data.note || 'Клипы сохранены', data.note ? (hasWarn ? 'error' : '') : 'ok');
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

document.querySelectorAll('input[name="mode"], input[name="len"]').forEach((i) => i.addEventListener('change', refresh));
el.count.addEventListener('input', refresh);

(async function init() {
  const d = await api.defaults();
  if (d.ok) state.outDir = d.data.outDir;
  refresh();
})();
