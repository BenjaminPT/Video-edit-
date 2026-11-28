'use strict';

const $ = (id) => document.getElementById(id);
const api = window.clipper;

const el = {
  drop: $('drop'),
  urlForm: $('url-form'), urls: $('urls'), urlGo: $('url-go'),
  library: $('library'), libraryList: $('library-list'), libraryTitle: $('library-title'), selectAll: $('select-all'),
  modeHint: $('mode-hint'), countField: $('count-field'), count: $('count'), countOut: $('count-out'), countLabel: $('count-label'),
  fast: $('fast'), outPath: $('out-path'), outChange: $('out-change'),
  run: $('run'), progress: $('progress'), progressLabel: $('progress-label'), progressPct: $('progress-pct'),
  barWrap: document.querySelector('.progress .bar'), barFill: $('bar-fill'), status: $('status'),
  results: $('results'), resultsTitle: $('results-title'), resultsList: $('results-list'),
  criterionField: $('criterion-field'), criterion: $('criterion'), criterionHint: $('criterion-hint'),
  player: $('r-player'), extras: $('extras'), extrasList: $('extras-list'), extrasTitle: $('extras-title'),
  openFolder: $('open-folder'), copyTimes: $('copy-times'),
};

/**
 * Видео в библиотеке: { id, file, name, duration, audioStreams, downloaded, selected,
 *   phase: 'queued' | 'downloading' | 'ready' | 'error', label, value, analysis: 'none' | 'running' | 'done',
 *   error, confirming }
 */
const state = {
  items: [],
  nextId: 1,
  outDir: '',
  busy: false, // идёт нарезка
  last: null,
};

const MODE_HINTS = {
  top: 'Сам выбирает самые яркие моменты со всех выбранных видео: крик, смех, эмоции в голосе. Лучшие идут первыми',
  smart: 'Берёт все заметные реакции стримера из каждого видео. Музыка и шум игры не считаются',
  fixed: 'Режет каждое видео подряд на равные куски',
};
const CRITERION_HINTS = {
  mix: 'Крик, смех и эмоции вперемешку: подходит почти всегда',
  peak: 'Самые громкие моменты: резкие крики и вскрики',
  sustain: 'Долгие реакции: смех и эмоции, которые держатся несколько секунд',
  talk: 'Оживлённые разговоры: голос весь клип выше обычного, без пауз',
  surprise: 'Внезапные реакции: голос резко подскакивает после спокойного участка',
};
const COUNT = {
  top: { label: 'Сколько лучших клипов', min: 3, max: 100, value: 10 },
  smart: { label: 'Клипов из каждого видео', min: 3, max: 100, value: 15 },
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
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

const getMode = () => document.querySelector('input[name="mode"]:checked').value;
const getLen = () => Number(document.querySelector('input[name="len"]:checked').value);
const find = (id) => state.items.find((i) => i.id === id);
const ready = (i) => i.phase === 'ready';

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

function syncSegments() {
  document.querySelectorAll('.seg').forEach((seg) => {
    const inputs = Array.from(seg.querySelectorAll('input'));
    seg.style.setProperty('--i', Math.max(0, inputs.findIndex((i) => i.checked)));
  });
}

function selectedItems() { return state.items.filter((i) => i.selected && ready(i)); }

function refresh() {
  syncSegments();
  const mode = getMode();
  el.modeHint.textContent = MODE_HINTS[mode];
  el.countField.hidden = mode === 'fixed';
  el.criterionField.hidden = mode !== 'top';
  el.criterionHint.textContent = CRITERION_HINTS[el.criterion.value];
  el.countOut.textContent = el.count.value;
  el.outPath.textContent = state.outDir;
  el.outPath.title = state.outDir;

  const picked = selectedItems();
  const listening = mode !== 'fixed' && picked.some((i) => i.analysis === 'running' && i.audioStreams > 0);
  el.run.textContent = state.busy ? 'Отмена' : listening ? 'Слушаю звук…' : picked.length > 1 ? `Нарезать (${picked.length})` : 'Нарезать';
  el.run.disabled = !state.busy && (picked.length === 0 || !state.outDir || listening);

  el.outChange.disabled = state.busy;
  el.urlGo.disabled = !state.outDir;

  el.library.hidden = state.items.length === 0;
  const n = state.items.length;
  el.libraryTitle.textContent = `${n} ${plural(n, 'видео', 'видео', 'видео')}, выбрано ${picked.length}`;
  const selectable = state.items.filter(ready);
  el.selectAll.checked = selectable.length > 0 && selectable.every((i) => i.selected);
  el.selectAll.disabled = selectable.length === 0 || state.busy;
  state.items.forEach(renderItem);
}

// ---- Библиотека ----

const itemNodes = new Map();

function button(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ghost ' + cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function metaText(item) {
  if (item.phase === 'queued') return item.label || 'В очереди';
  if (item.phase === 'downloading') return item.label || 'Скачиваю';
  if (item.phase === 'error') return item.error || 'Ошибка';
  const base = `${human(item.duration)} · ${audioText(item.audioStreams)}`;
  if (item.analysis === 'running') return `${base} · ${item.label || 'Слушаю звук'}`;
  if (item.analysis === 'done' && item.audioStreams > 0) return `${base} · звук проанализирован`;
  return base;
}

function renderItem(item) {
  let li = itemNodes.get(item.id);
  if (!li) {
    li = document.createElement('li');
    li.className = 'item';
    itemNodes.set(item.id, li);
    el.libraryList.append(li);
  }

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'item-check';
  check.checked = item.selected && ready(item);
  check.disabled = !ready(item) || state.busy;
  check.setAttribute('aria-label', `Выбрать: ${item.name}`);
  check.addEventListener('change', () => { item.selected = check.checked; refresh(); });

  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = item.name;
  name.title = item.file || item.url || '';

  const meta = document.createElement('span');
  meta.className = 'item-meta' + (item.phase === 'error' ? ' error' : '');
  meta.textContent = item.confirming ? 'Это видео скачало приложение. Что сделать с файлом?' : metaText(item);

  const body = document.createElement('div');
  body.className = 'item-body';
  body.append(name, meta);

  const working = item.phase === 'queued' || item.phase === 'downloading' || (ready(item) && item.analysis === 'running');
  if (working && !item.confirming) {
    const bar = document.createElement('div');
    const known = typeof item.value === 'number';
    bar.className = 'item-bar' + (known ? '' : ' busy');
    const fill = document.createElement('i');
    if (known) fill.style.transform = `scaleX(${Math.max(0, Math.min(1, item.value))})`;
    bar.append(fill);
    body.append(bar);
  }

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  if (item.confirming) {
    actions.append(
      button('Оставить на диске', '', () => removeItem(item, false)),
      button('В корзину', 'danger', () => removeItem(item, true)),
      button('Отмена', '', () => { item.confirming = false; refresh(); })
    );
  } else if (item.phase === 'queued' || item.phase === 'downloading') {
    actions.append(button('Отмена', '', () => { api.cancelTask(item.id); }));
  } else if (item.phase === 'error') {
    actions.append(button('Убрать', '', () => removeItem(item, false)));
  } else {
    const rm = button('Убрать', '', () => askRemove(item));
    rm.disabled = state.busy;
    actions.append(rm);
  }

  li.replaceChildren(check, body, actions);
}

function askRemove(item) {
  if (state.busy) return;
  if (item.downloaded) { item.confirming = true; refresh(); } else removeItem(item, false);
}

async function removeItem(item, trash) {
  if (trash) {
    const res = await api.trash(item.file);
    if (!res.ok) { setStatus(res.error, 'error'); return; }
  }
  api.cancelTask(item.id);
  state.items = state.items.filter((i) => i !== item);
  const li = itemNodes.get(item.id);
  if (li) li.remove();
  itemNodes.delete(item.id);
  setStatus(trash ? 'Файл отправлен в корзину' : item.downloaded ? 'Видео убрано из приложения. Файл остался на диске' : 'Видео убрано из приложения. Файл на диске не тронут');
  refresh();
}

el.selectAll.addEventListener('change', () => {
  state.items.filter(ready).forEach((i) => { i.selected = el.selectAll.checked; });
  refresh();
});

// Анализ звука запускается сразу, как видео появилось; несколько видео встают в очередь.
async function startAnalysis(item) {
  if (item.audioStreams === 0) { item.analysis = 'done'; return; }
  item.analysis = 'running';
  item.label = 'В очереди на анализ';
  item.value = null;
  refresh();
  const res = await api.analyze(item.id, item.file);
  if (!find(item.id)) return;
  item.analysis = res.ok ? 'done' : 'none';
  item.value = undefined;
  item.label = '';
  if (res.ok) {
    item.audioStreams = res.data.audioStreams;
  } else if (!res.cancelled) {
    setStatus(`${item.name}: ${res.error}`, 'error');
  }
  refresh();
}

function addReady(data, existing) {
  const item = existing || {
    id: String(state.nextId++),
  };
  Object.assign(item, {
    file: data.file, name: data.name, duration: data.duration, audioStreams: data.audioStreams,
    downloaded: Boolean(data.downloaded), phase: 'ready', selected: true, analysis: 'none',
    label: '', value: undefined, error: '', confirming: false,
  });
  if (!existing) state.items.push(item);
  refresh();
  startAnalysis(item);
  return item;
}

async function loadFile(file) {
  if (state.items.some((i) => i.file === file)) return; // уже в списке
  const res = await api.probe(file);
  if (!res.ok) { setStatus(`${file.split(/[\\/]/).pop()}: ${res.error}`, 'error'); return; }
  addReady({ file, duration: res.data.duration, name: res.data.name, audioStreams: res.data.audioStreams, downloaded: res.data.downloaded });
}

async function loadFiles(files) {
  setStatus('');
  for (const f of files) await loadFile(f);
}

// Прогресс загрузок и анализа приходит с номером видео, прогресс нарезки без него.
api.onProgress((p) => {
  if (p.id !== undefined) {
    const item = find(String(p.id));
    if (!item) return;
    item.value = typeof p.value === 'number' ? p.value : null;
    item.label = p.label || item.label;
    if (p.stage === 'download') item.phase = /очереди/i.test(p.label || '') ? 'queued' : 'downloading';
    renderItem(item);
    return;
  }
  if (state.busy) showProgress(p);
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

// ---- Выбор и перетаскивание ----

async function pick() {
  const res = await api.pickVideos();
  if (res.ok && res.data) loadFiles(res.data);
}
el.drop.addEventListener('click', pick);
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
});

['dragenter', 'dragover'].forEach((type) =>
  document.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.add('over'); })
);
['dragleave', 'drop'].forEach((type) =>
  document.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'dragleave' && e.relatedTarget) return;
    el.drop.classList.remove('over');
  })
);
document.addEventListener('drop', (e) => {
  const dropped = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
  const paths = dropped.map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) loadFiles(paths);
});

el.outChange.addEventListener('click', async () => {
  const res = await api.pickFolder();
  if (res.ok && res.data) { state.outDir = res.data; refresh(); }
});

// ---- Загрузка по ссылкам: каждая идёт отдельной задачей, до трёх одновременно ----

function parseUrls(text) {
  const found = text.split(/[\s,]+/).filter((s) => /^https?:\/\//i.test(s));
  return Array.from(new Set(found));
}

async function downloadOne(item) {
  const res = await api.download(item.id, item.url, state.outDir);
  if (!find(item.id)) return;
  if (res.ok) {
    addReady(res.data, item);
  } else if (res.cancelled) {
    state.items = state.items.filter((i) => i !== item);
    const li = itemNodes.get(item.id);
    if (li) li.remove();
    itemNodes.delete(item.id);
    refresh();
  } else {
    item.phase = 'error';
    item.error = res.error;
    item.value = undefined;
    refresh();
  }
}

el.urlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const urls = parseUrls(el.urls.value);
  if (!urls.length) {
    setStatus(el.urls.value.trim() ? 'Нужны ссылки, которые начинаются с http:// или https://' : '', el.urls.value.trim() ? 'error' : '');
    return;
  }
  setStatus('');
  el.urls.value = '';
  for (const url of urls) {
    const item = {
      id: String(state.nextId++), url, name: url, phase: 'queued', label: 'В очереди', value: null,
      selected: true, analysis: 'none', audioStreams: 1, duration: 0, downloaded: true, error: '',
    };
    state.items.push(item);
    downloadOne(item);
  }
  refresh();
});

// ---- Нарезка ----

el.run.addEventListener('click', async () => {
  if (state.busy) { await api.cancel(); return; }
  const picked = selectedItems();
  if (!picked.length) return;

  state.busy = true;
  refresh();
  el.run.disabled = false;
  el.results.hidden = true;
  setStatus('');
  showProgress({ value: 0, label: 'Начинаю' });

  const mode = getMode();
  const res = await api.run(
    picked.map((i) => ({ id: i.id, file: i.file })),
    { outDir: state.outDir, mode, criterion: el.criterion.value, clipLen: getLen(), count: Number(el.count.value), fast: el.fast.checked }
  );

  state.busy = false;
  hideProgress();
  refresh();

  if (!res.ok) {
    setStatus(res.cancelled ? 'Отменено' : res.error, res.cancelled ? '' : 'error');
    return;
  }
  // Анализ после нарезки лежит в кэше: помечаем видео как проанализированные.
  picked.forEach((i) => { if (i.audioStreams > 0 && mode !== 'fixed') i.analysis = 'done'; });
  refresh();
  renderResults(res.data, picked.length > 1);
});

const AUDIO_WARN = { partial: 'звук пропадает', none: 'нет звука' };

function renderResults(data, multi) {
  state.last = data;
  state.multi = multi;
  document.dispatchEvent(new CustomEvent('clipper:cut-done', { detail: data.clips.map((c) => c.file) }));
  if (!data.clips.length) {
    setStatus(data.note || 'Клипов нет');
    return;
  }
  const n = data.clips.length;
  el.resultsTitle.textContent = `Готово: ${n} ${plural(n, 'клип', 'клипа', 'клипов')}`;
  el.resultsList.replaceChildren(
    ...data.clips.map((c, i) => {
      const li = document.createElement('li');
      li.style.setProperty('--i', Math.min(i, 12));
      li.append(
        cell('idx num', String(c.index).padStart(2, '0')),
        cell('time', `${clock(c.start)} – ${clock(c.end)}`),
        cell('vid', multi && c.video ? c.video : ''),
        cell('tag', c.tag || ''),
        cell('warn', AUDIO_WARN[c.audio] || ''),
        cell('score', c.score ? `${c.score}` : '')
      );
      li.append(rowActions(li, c.url, null, { start: 0 }, [button('Смотреть', '', () => play(li, c.url, 0, null))]));
      return li;
    })
  );
  renderExtras(data);
  el.results.hidden = false;
  const hasWarn = data.clips.some((c) => c.audio !== 'ok');
  setStatus(data.note || 'Клипы сохранены', data.note ? (hasWarn ? 'error' : '') : 'ok');
}

// ---- Просмотр клипов и «других моментов» прямо в приложении ----

let playTimer = null;
function play(li, url, from, to) {
  document.querySelectorAll('.results-list li.playing').forEach((n) => n.classList.remove('playing'));
  li.classList.add('playing');
  el.player.hidden = false;
  el.player.onloadedmetadata = () => {
    el.player.currentTime = from;
    el.player.play().catch(() => {});
  };
  el.player.ontimeupdate = () => {
    if (to !== null && el.player.currentTime >= to) { el.player.pause(); el.player.ontimeupdate = null; }
  };
  if (el.player.getAttribute('src') === url) el.player.onloadedmetadata();
  else el.player.src = url;
  el.player.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function rowActions(li, url, _x, _y, buttons) {
  const box = document.createElement('div');
  box.className = 'row-actions';
  box.append(...buttons);
  return box;
}

function renderExtras(data) {
  const extras = data.extras || [];
  el.extras.hidden = extras.length === 0;
  el.extrasList.replaceChildren(
    ...extras.map((e, i) => {
      const li = document.createElement('li');
      li.style.setProperty('--i', Math.min(i, 12));
      li.append(
        cell('idx num', String(e.rank).padStart(2, '0')),
        cell('time', `${clock(e.start)} – ${clock(e.end)}`),
        cell('vid', state.multi ? e.video || '' : ''),
        cell('tag', e.tag || ''),
        cell('score', e.score ? `${e.score}` : '')
      );
      const cut = button('Вырезать', '', async () => {
        cut.disabled = true;
        cut.textContent = 'Режу…';
        const res = await api.cutExtra(data.folder, e, el.fast.checked);
        if (!res.ok) {
          cut.disabled = false;
          cut.textContent = 'Вырезать';
          setStatus(res.error, 'error');
          return;
        }
        // Вырезанный момент переезжает из «других» в список клипов.
        data.clips.push({ ...res.data, video: e.video });
        data.clips.sort((x, y) => (x.rank || x.index) - (y.rank || y.index));
        data.extras = data.extras.filter((x) => x !== e);
        renderResults(data, state.multi);
        setStatus(`Клип ${String(e.rank).padStart(2, '0')} вырезан в папку`, 'ok');
      });
      li.append(rowActions(li, e.url, null, null, [button('Смотреть', '', () => play(li, e.url, e.start, e.end)), cut]));
      return li;
    })
  );
}

function cell(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

$('to-montage').addEventListener('click', () => {
  if (!state.last) return;
  document.dispatchEvent(new CustomEvent('clipper:to-montage', { detail: state.last.clips.map((c) => c.file) }));
});

el.openFolder.addEventListener('click', () => {
  if (state.last && state.last.folder) api.show(state.last.folder);
});

el.copyTimes.addEventListener('click', async () => {
  if (!state.last) return;
  const text = state.last.clips
    .map((c) => `${c.video ? c.video + ' ' : ''}${clock(c.start)} - ${clock(c.end)}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Таймкоды скопированы', 'ok');
  } catch (_) {
    setStatus('Не удалось скопировать', 'error');
  }
});

// Смена режима меняет диапазон ползунка: для «Лучших» это 3–30, для «Всех реакций» 3–100.
let lastCountMode = 'top';
function applyCountMode() {
  const mode = getMode();
  if (mode === 'fixed' || mode === lastCountMode) return;
  const c = COUNT[mode];
  el.count.min = c.min;
  el.count.max = c.max;
  el.count.value = c.value;
  el.countLabel.textContent = c.label;
  lastCountMode = mode;
}
document.querySelectorAll('input[name="mode"]').forEach((i) => i.addEventListener('change', () => { applyCountMode(); refresh(); }));
document.querySelectorAll('input[name="len"]').forEach((i) => i.addEventListener('change', refresh));
el.count.addEventListener('input', refresh);
el.criterion.addEventListener('change', refresh);

(async function init() {
  const d = await api.defaults();
  if (d.ok) state.outDir = d.data.outDir;
  el.countLabel.textContent = COUNT.top.label;
  refresh();
})();
