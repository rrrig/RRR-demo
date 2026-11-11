// ИГНИС ПРО — совместная работа над проектами: Дмитрий, Claude и ChatGPT.
// Данные — в закрытом репозитории GitHub; копия и очередь изменений — на телефоне.
import * as M from './model.js';
import { createClient, isNetworkError, isTemporaryError } from './github.js';
import { buildChanges, preview } from './ops.js';
import * as C from './cache.js';
import { makeZip } from './zip.js';
import { splitBlob, assembleParts, groupParts, needsParts } from './bigfile.js';

const VERSION = '0.14.0';
const SETTINGS_KEY = 'ignis-pro-settings';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'scad', 'py', 'js', 'gcode', 'nc', 'svg', 'dxf', 'tap', 'ini', 'yml', 'yaml', 'xml', 'html'];
const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'];
const extOf = p => (p.split('/').pop().split('.').pop() || '').toLowerCase();
const fmtSize = n => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(0) + ' КБ' : (n / 1048576).toFixed(1).replace('.', ',') + ' МБ';
const fmtDate = d => { if (!d) return ''; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd}.${m}.${y}`; };
const fmtTime = iso => { const d = new Date(iso); if (!iso || Number.isNaN(d.getTime())) return ''; const now = new Date(); const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + t; };
const pluralWord = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c; };
const plural = (n, a, b, c) => n + ' ' + pluralWord(n, a, b, c);
// Имя файла для репозитория: только [a-z0-9._-], первым — буква или цифра (как требует tools/validate.mjs).
const repoName = n => { const s = M.safeFileName(n).replace(/^[._-]+/, ''); return s && !s.startsWith('.') ? s : 'file' + (s || ''); };
const whoClass = a => (/claude/i.test(a) ? 'claude' : /chatgpt|gpt/i.test(a) ? 'gpt' : /бот/i.test(a) ? '' : 'me');
const chip = (text, cls = '') => `<span class="chip ${cls}">${esc(text)}</span>`;
const statusCls = s => ({ 'Разрешено к выдаче': 'gold', 'На проверке': 'amber', 'Архив': '', 'Готово': 'green', 'В работе': 'amber', 'Открыта': '', 'Сдан': 'green', 'Пауза': 'amber', 'Идея': '' }[s] ?? '');

// ---------------- Состояние ----------------
// Хранилище проектов утверждено 11.11.2026: закрытый репозиторий rrrig/RRR.
const DEFAULTS = { owner: 'rrrig', repo: 'RRR', token: '', me: 'Дмитрий', claudeUrl: '', chatgptUrl: '' };
const S = {
  settings: loadSettings(), client: null, head: null, entries: new Map(), projects: new Map(),
  pulls: [], pullInfo: new Map(), outbox: [], offline: false, busy: false, syncedAt: null, error: null, chatOpen: null, chat: null,
};
function loadSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { s = { ...DEFAULTS }; }
  // Прежнее значение по умолчанию: репозитория rrrig/ignis-projects не существует.
  if (s.owner === 'rrrig' && s.repo === 'ignis-projects') s.repo = DEFAULTS.repo;
  return s;
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); }
const me = () => S.settings.me || 'Дмитрий';
function makeClient() { const { owner, repo, token } = S.settings; S.client = token ? createClient({ owner, repo, token }) : null; }

// ---------------- Уведомления ----------------
let toastTimer;
function toast(text, err = false) {
  const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 2600);
}
function banner() {
  const b = $('banner'); const pending = S.outbox.length;
  let text = '', err = false;
  if (S.offline) text = S.syncedAt ? `Нет связи с GitHub. Показана копия на телефоне от ${fmtTime(S.syncedAt)}. Изменения сохранятся на телефоне и отправятся, когда связь появится.` : 'Нет связи с GitHub, а копии на телефоне ещё нет. Проекты появятся, когда связь восстановится.';
  else if (S.error) { text = S.error; err = true; }
  if (pending) text += (text ? ' ' : '') + `Ждут отправки: ${pending}.`;
  b.textContent = text; b.hidden = !text; b.className = 'banner' + (err ? ' err' : '');
}
const setBusy = v => { S.busy = v; $('sync').classList.toggle('spin', v); };

// ---------------- Тексты файлов (кэш по sha) ----------------
async function blobText(sha) {
  const c = await C.get('blobs', sha).catch(() => undefined);
  if (typeof c === 'string') return c;
  if (c instanceof ArrayBuffer) return new TextDecoder().decode(c);
  if (S.offline || !S.client) throw new Error('Файл не сохранён на телефоне');
  const t = await S.client.blobText(sha);
  C.put('blobs', sha, t).catch(() => {});
  return t;
}
// mustStore: для «Сохранить на телефон» — ошибка записи в IndexedDB считается неудачей.
async function blobBytes(sha, mustStore = false) {
  const c = await C.get('blobs', sha).catch(() => undefined);
  if (c instanceof ArrayBuffer) return c;
  if (typeof c === 'string') return new TextEncoder().encode(c).buffer;
  if (S.offline || !S.client) throw new Error('Файл не сохранён на телефоне. Откройте его при связи или нажмите «Сохранить для работы без связи».');
  const b = await S.client.blobBytes(sha);
  const stored = await C.put('blobs', sha, b).then(() => true, () => false);
  if (mustStore && !stored) throw new Error('Не удалось сохранить файл на телефоне (возможно, не хватает места)');
  return b;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// Массовые операции (копия на телефон, ZIP): одновременно только одна, не больше 2 запросов
// к GitHub; закрытие шторки останавливает операцию.
let bulk = null;
function startBulk(label) {
  if (bulk) { toast(`Уже выполняется: ${bulk.label}. Дождитесь окончания или закройте окно.`, true); return null; }
  bulk = { label, cancelled: false }; return bulk;
}
function endBulk(b) { if (bulk === b) bulk = null; }
async function bulkPool(items, b, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => { while (i < items.length && !b.cancelled) { const k = i++; await fn(items[k], k); } }));
}

// ---------------- Загрузка ----------------
// Загрузка последней версии. Одновременно идёт не больше одной; просьбы во время загрузки
// объединяются в одну повторную.
let loading = null, loadAgain = false;
function load() {
  if (loading) { loadAgain = true; return loading; }
  loading = (async () => {
    do { loadAgain = false; await loadOnce(); } while (loadAgain);
  })().finally(() => { loading = null; });
  return loading;
}
async function loadOnce() {
  if (!S.client) { route(); return; }
  setBusy(true);
  try {
    let state;
    try {
      const head = await S.client.head();
      // Та же версия — дерево файлов уже есть, повторно не скачиваем.
      const tree = head.commit === S.head?.commit && S.entries.size ? [...S.entries.entries()].map(([path, e]) => ({ path, ...e })) : await S.client.tree(head.tree);
      state = { head, tree: tree.map(e => ({ path: e.path, sha: e.sha, size: e.size })), at: new Date().toISOString() };
      await C.put('kv', 'state', state).catch(() => {});
      S.offline = false; S.error = null;
    } catch (e) {
      S.offline = isNetworkError(e);
      S.error = S.offline ? null : e.message;
      state = await C.get('kv', 'state').catch(() => null);
      if (!state) { if (!S.offline) throw e; return; }
    }
    const changed = state.head.commit !== S.head?.commit;
    S.head = state.head; S.syncedAt = state.at;
    S.entries = new Map(state.tree.map(e => [e.path, { sha: e.sha, size: e.size }]));
    if (changed || !S.projects.size) await buildProjects();
    S.outbox = await C.all('outbox').catch(() => []);
    if (!S.offline && !S.error) { flushOutbox(); loadPulls(); }
  } catch (e) {
    S.error = e.message;
  } finally {
    setBusy(false); banner(); route();
  }
}
// Без связи — раз в 30 секунд пробуем снова (событие «online» на iPhone приходит не всегда).
setInterval(() => { if (S.offline && S.client && document.visibilityState === 'visible') load(); }, 30000);

async function buildProjects() {
  const groups = new Map();
  for (const [path, e] of S.entries) {
    const m = /^projects\/([^/]+)\/(.+)$/.exec(path); if (!m) continue;
    if (!groups.has(m[1])) groups.set(m[1], { slug: m[1], json: {}, chat: [], files: [] });
    const g = groups.get(m[1]);
    if (M.PROJECT_FILES.includes(m[2])) g.json[m[2]] = e;
    else if (m[2].startsWith('chat/') && m[2].endsWith('.json')) g.chat.push({ path, ...e });
    else if (m[2].startsWith('files/')) g.files.push({ path, ...e, kind: m[2].split('/')[1] });
  }
  const projects = new Map();
  await pool([...groups.values()], 6, async g => {
    const files = {};
    for (const name of M.PROJECT_FILES) {
      const e = g.json[name]; if (!e) continue;
      try { files[name] = JSON.parse(await blobText(e.sha)); } catch (err) { files[name] = err instanceof SyntaxError ? new Error('ошибка JSON: ' + err.message) : new Error(err.message); }
    }
    const old = S.projects.get(g.slug);
    projects.set(g.slug, { slug: g.slug, files, errors: M.validateProject(g.slug, files), chatEntries: g.chat.sort((a, b) => a.path.localeCompare(b.path)), fileEntries: g.files, chat: old?.chat || null });
  });
  S.projects = projects;
  if (S.chatOpen && projects.has(S.chatOpen)) await loadChat(S.chatOpen);
}

async function loadChat(slug) {
  const p = S.projects.get(slug); if (!p) return;
  const known = new Map((p.chat || []).map(m => [m._sha, m]));
  const msgs = await pool(p.chatEntries, 6, async e => {
    if (known.has(e.sha)) return known.get(e.sha);
    try { const m = JSON.parse(await blobText(e.sha)); m._sha = e.sha; m._path = e.path; return m; }
    catch (err) { return { _sha: e.sha, _path: e.path, author: '?', date: '', text: 'Сообщение не прочитано: ' + err.message, _bad: true }; }
  });
  p.chat = msgs.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a._path.localeCompare(b._path));
}

async function loadPulls() {
  try {
    const pulls = await S.client.pulls();
    S.pulls = pulls;
    await pool(pulls, 4, async pr => {
      const cached = S.pullInfo.get(pr.number);
      if (cached && cached.sha === pr.head.sha) return;
      const files = await S.client.pullFiles(pr.number);
      const slugs = new Set(), chat = [];
      for (const f of files) {
        const m = /^projects\/([^/]+)\//.exec(f.filename); if (m) slugs.add(m[1]);
        if (/^projects\/[^/]+\/chat\/[^/]+\.json$/.test(f.filename) && f.status === 'added' && f.patch) {
          try { const text = f.patch.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1)).join('\n'); const msg = JSON.parse(text); msg._pr = pr.number; msg._slug = m[1]; chat.push(msg); } catch {}
        }
      }
      S.pullInfo.set(pr.number, { sha: pr.head.sha, files, slugs: [...slugs], chat, check: await S.client.checks(pr.head.sha) });
    });
    const b = $('inboxBadge'); b.textContent = pulls.length; b.hidden = !pulls.length;
  } catch (e) { /* предложения не критичны */ }
  if (/^#\/(inbox|p\/)/.test(location.hash) || location.hash === '' || location.hash === '#/') route();
}

// ---------------- Изменения ----------------
async function run(slug, op, label) {
  op.slug = slug; op.label = label; op.at = new Date().toISOString(); op.author = me();
  if (S.offline || !S.client) { await queue(op); toast('Сохранено на телефоне — отправится при связи'); route(); return true; }
  setBusy(true);
  try { await send(op); toast('Сохранено'); setBusy(false); await load(); return true; }
  catch (e) {
    if (isNetworkError(e)) { await queue(op); S.offline = true; toast('Нет связи — изменение сохранено на телефоне'); banner(); route(); return true; }
    toast('Не сохранено: ' + e.message, true); return false;
  } finally { setBusy(false); }
}
async function queue(op) { await C.put('outbox', null, op); S.outbox = await C.all('outbox'); banner(); }
async function send(op) {
  const shas = {};
  const blobSha = async u => {
    if (shas[u.key]) return shas[u.key];
    const bytes = await C.get('uploads', u.key);
    if (!bytes) throw new Error('Файл для отправки не найден на телефоне');
    return (shas[u.key] = await S.client.createBlob(new Uint8Array(bytes)));
  };
  await S.client.mutate(`[${op.author || me()}] ${op.label}`, ({ read, files }) => buildChanges(op.slug, op, read, blobSha, files));
  for (const u of op.uploads || []) {
    const bytes = await C.get('uploads', u.key).catch(() => null);
    if (bytes && shas[u.key]) await C.put('blobs', shas[u.key], bytes).catch(() => {});
    await C.del('uploads', u.key).catch(() => {});
  }
}
let flushing = false;
async function flushOutbox() {
  if (flushing || !S.client) return;
  flushing = true; let sent = 0, marked = 0;
  try {
    const ops = await C.all('outbox');
    for (const op of ops) {
      try { await send(op); await C.del('outbox', op.seq); sent++; }
      catch (e) {
        // Связь, токен, лимит — попробуем позже; иначе изменение уже нельзя применить (например, запись удалили).
        if (isTemporaryError(e)) { if (isNetworkError(e)) S.offline = true; break; }
        op.error = e.message; marked++; await C.put('outbox', null, op);
      }
    }
    S.outbox = await C.all('outbox');
    if (sent) toast(`Отправлено с телефона: ${plural(sent, 'изменение', 'изменения', 'изменений')}`);
  } finally { flushing = false; banner(); }
  if (sent) await load(); else if (marked) route();
}
function pendingFor(slug) { return S.outbox.filter(o => o.slug === slug); }
function viewFiles(p) {
  const ops = pendingFor(p.slug).filter(o => !['chat', 'writeFile', 'deleteFile'].includes(o.type));
  return ops.length ? preview(p.files, ops).files : p.files;
}

// Сохранение выбранного файла на телефоне перед отправкой
// Файл больше 50 МБ автоматически делится на части по 20 МБ (bigfile.js); uploads — по одной на часть.
async function stageFile(file, kind, slug, id) {
  const name = (id ? id + '-' : '') + repoName(file.name);
  return stageAt(file, `projects/${slug}/files/${kind}/${name}`);
}
// Большой файл: части + манифест <path>.parts.json (по нему файл собирается и проверяется).
async function stageAt(file, path) {
  if (needsParts(file.size)) {
    const uploads = [];
    toast(`Готовлю «${file.name}» (${fmtSize(file.size)}) частями по 20 МБ…`);
    const ref = await splitBlob(file, path, file.name, async (part, bytes) => {
      const key = M.newId('u'); await C.put('uploads', key, bytes); uploads.push({ path: part.path, key });
    });
    const mkey = M.newId('u');
    await C.put('uploads', mkey, new TextEncoder().encode(JSON.stringify(M.toManifest(ref), null, 2) + '\n').buffer);
    uploads.push({ path: M.manifestPath(path), key: mkey });
    return { ref, uploads };
  }
  const bytes = await file.arrayBuffer();
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = M.newId('u');
  await C.put('uploads', key, bytes);
  return { ref: { path, name: file.name, size: file.size, sha256 }, uploads: [{ path, key }] };
}

// ---------------- Шторка-форма ----------------
let sheetSubmit = null;
function sheet(title, body, onSubmit, okText = 'Готово') {
  $('sheetTitle').textContent = title; $('sheetBody').innerHTML = body; $('sheetOk').textContent = okText;
  $('sheetOk').hidden = !onSubmit; sheetSubmit = onSubmit; $('sheet').hidden = false;
  const first = $('sheetBody').querySelector('input:not([type=file]),textarea,select');
  if (first && !('ontouchstart' in window)) first.focus();
}
function closeSheet() { if (bulk) bulk.cancelled = true; $('sheet').hidden = true; $('sheetBody').innerHTML = ''; sheetSubmit = null; }
$('sheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
$('sheetForm').addEventListener('submit', async e => {
  e.preventDefault(); if (!sheetSubmit || $('sheetOk').disabled) return;
  const form = new FormData($('sheetForm'));
  // Содержимое файла сохраняем как есть, остальные поля — без пробелов по краям.
  const v = Object.fromEntries([...form.entries()].filter(([, x]) => typeof x === 'string').map(([k, x]) => [k, k === 'content' ? x : x.trim()]));
  $('sheetOk').disabled = true;
  try { const ok = await sheetSubmit(v, form); if (ok !== false) closeSheet(); }
  catch (err) { toast(err.message, true); }
  finally { $('sheetOk').disabled = false; }
});
const field = (label, html) => `<label class="field"><span>${label}</span>${html}</label>`;
const input = (name, label, value = '', attrs = '') => field(label, `<input name="${name}" value="${esc(value)}" ${attrs}>`);
const area = (name, label, value = '', attrs = '') => field(label, `<textarea name="${name}" ${attrs}>${esc(value)}</textarea>`);
const select = (name, label, options, value) => field(label, `<select name="${name}">${options.map(o => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`);
const people = () => [...new Set([me(), ...M.AUTHORS])];

// ---------------- Навигация ----------------
function setBar(title, sub = '', back = null) {
  $('title').textContent = title; $('subtitle').textContent = sub;
  $('back').hidden = !back; $('back').onclick = back ? () => (location.hash = back) : null;
  document.title = title + ' · ИГНИС ПРО';
}
function setNav(name) { for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.dataset.nav === name); }
let chatPoll, rendered = '';
function route() {
  const h = location.hash || '#/';
  const v = $('view');
  if (!S.settings.token && !/^#\/(settings|migrate)/.test(h)) { location.hash = '#/settings'; return; }
  const same = h === rendered, y = window.scrollY;
  if (same) {
    // Тот же открытый чат — обновляем только сообщения, чтобы не сбить набор текста и клавиатуру.
    if (S.chat && S.projects.has(S.chat.slug) && document.contains(S.chat.el)) { try { return S.chat.refresh(); } catch (e) { console.error(e); } }
    // Экраны, которые сами загружают данные, и экраны с начатым вводом фоновое обновление не трогает.
    if (/^#\/(inbox\/\d|log|migrate|p\/[^/]+\/log)/.test(h)) return;
    const a = document.activeElement;
    if (a && v.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  }
  clearInterval(chatPoll); S.chatOpen = null; S.chat = null; rendered = h;
  document.body.classList.remove('typing', 'in-chat');
  let m;
  try {
    if ((m = /^#\/p\/([^/]+)(?:\/([a-z]+))?/.exec(h))) { setNav('projects'); return projectView(decodeURIComponent(m[1]), m[2] || 'chat', v); }
    if ((m = /^#\/inbox\/(\d+)/.exec(h))) { setNav('inbox'); return pullView(+m[1], v); }
    if (h.startsWith('#/inbox')) { setNav('inbox'); return inboxView(v); }
    if (h.startsWith('#/log')) { setNav('log'); return logView(v); }
    if (h.startsWith('#/migrate')) { setNav('settings'); return migrateView(v); }
    if (h.startsWith('#/settings')) { setNav('settings'); return settingsView(v); }
    setNav('projects'); return projectsView(v);
  } catch (e) { console.error(e); v.innerHTML = `<div class="errors">Ошибка экрана: ${esc(e.message)}</div>`; }
  finally { if (same && !S.chat) window.scrollTo(0, y); }
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); rendered = ''; route(); });
$('sync').onclick = () => { S.head = null; S.pullInfo.clear(); load(); };
window.addEventListener('online', () => load());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.client) load(); });

// ---------------- Список проектов ----------------
// ---- Связи проектов: parent (входит в проект) и related (связанные) ----
const projList = () => [...S.projects.values()].map(p => ({ p, pj: viewFiles(p)['project.json'] })).filter(x => x.pj && !(x.pj instanceof Error));
const projById = id => projList().find(x => x.pj.id === id) || null;
const byName = (a, b) => a.pj.name.localeCompare(b.pj.name, 'ru');
// id проекта и всех его подпроектов (на любую глубину) — их нельзя выбрать родителем.
function withDescendants(id) {
  const out = new Set([id]); let grew = true;
  while (grew) { grew = false; for (const x of projList()) if (x.pj.parent && out.has(x.pj.parent) && !out.has(x.pj.id)) { out.add(x.pj.id); grew = true; } }
  return out;
}
const childrenOf = id => projList().filter(x => x.pj.parent === id).sort(byName);
// Связанные в обе стороны: указанные в этом проекте и проекты, указавшие этот.
const relatedOf = pj => projList().filter(x => x.pj.id !== pj.id && ((pj.related || []).includes(x.pj.id) || (x.pj.related || []).includes(pj.id))).sort(byName);
const projLink = x => `<a class="row" href="#/p/${encodeURIComponent(x.p.slug)}"><div class="grow"><div class="t">${esc(x.pj.name)}</div><div class="chips">${chip(x.pj.status, statusCls(x.pj.status))}</div></div><span class="chev">›</span></a>`;
// Поля формы проекта: «Входит в проект» и «Связанные проекты».
function linkFields(pj) {
  const others = projList().filter(x => x.pj.id !== pj?.id).sort(byName);
  const banned = pj ? withDescendants(pj.id) : new Set();
  return field('Входит в проект', `<select name="parent"><option value="">— самостоятельный проект —</option>${others.filter(x => !banned.has(x.pj.id)).map(x => `<option value="${esc(x.pj.id)}"${pj?.parent === x.pj.id ? ' selected' : ''}>${esc(x.pj.name)}</option>`).join('')}</select>`)
    + (others.length ? `<div class="field"><span>Связанные проекты</span><div class="checks">${others.map(x => {
      // Связь, заданная в другом проекте, видна отмеченной; снять её можно только там.
      const theirs = pj && (x.pj.related || []).includes(pj.id) && !(pj.related || []).includes(x.pj.id);
      return `<label class="check"><input type="checkbox" name="related" value="${esc(x.pj.id)}"${(pj?.related || []).includes(x.pj.id) || theirs ? ' checked' : ''}${theirs ? ' disabled' : ''}><span>${esc(x.pj.name)}${theirs ? '<small>связь указана в том проекте</small>' : ''}</span></label>`;
    }).join('')}</div></div>` : '');
}

function projectsView(v) {
  setBar('Проекты', S.settings.repo ? `${S.settings.owner}/${S.settings.repo}` : '');
  const q0 = sessionStorage.getItem('q') || '';
  v.innerHTML = `
    ${S.projects.size > 4 || q0 ? `<input class="search" id="q" type="search" placeholder="Поиск проекта" value="${esc(q0)}" autocomplete="off">` : ''}
    <div id="plist"></div>
    <button class="add" id="newProject">Новый проект</button>`;
  const renderList = () => {
    const q = (sessionStorage.getItem('q') || '').toLowerCase().trim();
    const list = [...S.projects.values()].map(p => ({ p, f: viewFiles(p) }))
      .filter(({ f }) => f['project.json'] && !(f['project.json'] instanceof Error))
      .filter(({ f }) => !q || [f['project.json'].name, f['project.json'].customer].join(' ').toLowerCase().includes(q))
      .sort((a, b) => (b.f['project.json'].updated || '').localeCompare(a.f['project.json'].updated || '') || a.f['project.json'].name.localeCompare(b.f['project.json'].name, 'ru'));
    const broken = [...S.projects.values()].filter(p => !p.files['project.json'] || p.files['project.json'] instanceof Error);
    const pendingNew = S.outbox.filter(o => o.type === 'create');
    const prCount = slug => S.pulls.filter(pr => S.pullInfo.get(pr.number)?.slugs.includes(slug)).length;
    // Без поиска — деревом: подпроекты под своим проектом (с отступом); при поиске — плоским списком.
    let ordered = list.map(x => ({ ...x, depth: 0 }));
    if (!q) {
      const ids = new Set(list.map(x => x.f['project.json'].id)), kids = new Map();
      for (const x of list) { const par = x.f['project.json'].parent; if (par && ids.has(par)) { if (!kids.has(par)) kids.set(par, []); kids.get(par).push(x); } }
      const out = [], seen = new Set();
      const walk = (x, depth) => { const id = x.f['project.json'].id; if (seen.has(id)) return; seen.add(id); out.push({ ...x, depth }); for (const k of kids.get(id) || []) walk(k, depth + 1); };
      for (const x of list) { const par = x.f['project.json'].parent; if (!par || !ids.has(par)) walk(x, 0); }
      for (const x of list) walk(x, 0);   // на случай цикла в данных — показать всё
      ordered = out;
    }
    const rows = ordered.map(({ p, f, depth }) => {
      const pj = f['project.json'], open = (f['tasks.json']?.tasks || []).filter(t => t.status !== 'Готово').length;
      const total = f['cost.json']?.items ? M.costTotals(f['cost.json']).total : 0, prs = prCount(p.slug);
      const nKids = list.filter(x => x.f['project.json'].parent === pj.id).length;
      return `<a class="row${depth ? ' sub' : ''}" data-st="${esc(pj.status)}" href="#/p/${encodeURIComponent(p.slug)}"${depth ? ` style="padding-left:${14 + 18 * Math.min(depth, 4)}px"` : ''}>
        <div class="grow"><div class="t">${depth ? '<span class="muted">↳ </span>' : ''}${esc(pj.name)}</div>
        <div class="s">${[pj.customer ? esc(pj.customer) : '', plural((f['documents.json']?.documents || []).length, 'документ', 'документа', 'документов'), open ? plural(open, 'открытая задача', 'открытые задачи', 'открытых задач') : 'нет открытых задач', total ? M.rub(total) : ''].filter(Boolean).join(' · ')}</div>
        <div class="chips">${chip(pj.status, statusCls(pj.status))}${nKids ? chip(plural(nKids, 'подпроект', 'подпроекта', 'подпроектов')) : ''}${prs ? chip(plural(prs, 'предложение', 'предложения', 'предложений'), 'amber') : ''}${p.errors.length ? chip('ошибки в данных', 'red') : ''}${pendingFor(p.slug).length ? chip('⏳ ждёт отправки', 'amber') : ''}</div></div>
        <span class="chev">›</span></a>`;
    }).join('') + pendingNew.map(o => `<div class="row"><div class="grow"><div class="t">${esc(o.files['project.json'].name)}</div><div class="chips">${chip(o.error ? '⚠ ' + o.error : '⏳ создаётся — отправится при связи', o.error ? 'red' : 'amber')}</div></div></div>`).join('');
    $('plist').innerHTML = `
      ${rows ? `<div class="card">${rows}</div>` : `<div class="card"><div class="empty">${S.busy && !S.projects.size ? 'Загрузка проектов…' : q ? 'Ничего не найдено.' : S.offline && !S.syncedAt ? 'Здесь появятся проекты из репозитория.' : 'Проектов пока нет. Создайте первый — и позовите Claude и ChatGPT в его чат.'}</div></div>`}
      ${broken.length ? `<div class="errors" style="margin-top:12px">Не прочитаны папки: ${broken.map(p => esc(p.slug)).join(', ')}. Посмотрите предложения или попросите ИИ исправить.</div>` : ''}`;
  };
  renderList();
  if ($('q')) $('q').oninput = e => { sessionStorage.setItem('q', e.target.value); renderList(); };
  $('newProject').onclick = () => sheet('Новый проект',
    input('name', 'Название', '', 'required placeholder="Например, Звезда на ёлку 6 м"') + input('customer', 'Заказчик') + area('description', 'Описание и исходные данные', '', 'placeholder="Размеры, материалы, сроки, требования…"') + linkFields(null),
    async (val, form) => {
      if (!val.name) throw new Error('Укажите название');
      const names = [...S.projects.values()].map(p => p.files['project.json']?.name?.toLowerCase());
      if (names.includes(val.name.toLowerCase())) throw new Error('Проект с таким названием уже есть');
      const taken = new Set([...S.projects.keys(), ...S.outbox.map(o => o.slug)]);
      const slug = M.slugify(val.name, taken);
      const files = M.emptyProject({ name: val.name, customer: val.customer, description: val.description, author: me() });
      if (val.parent) files['project.json'].parent = val.parent;
      const rel = form.getAll('related'); if (rel.length) files['project.json'].related = rel;
      const ok = await run(slug, { type: 'create', files }, `Новый проект «${val.name}»`);
      if (ok && !S.offline) location.hash = `#/p/${slug}/chat`;
      return ok;
    }, 'Создать');
}

// ---------------- Проект ----------------
const TABS = [['chat', 'Чат'], ['over', 'Обзор'], ['docs', 'Документы'], ['files', 'Файлы'], ['tasks', 'Задачи'], ['cost', 'Смета'], ['src', 'Источники'], ['log', 'Журнал']];
function projectView(slug, tab, v) {
  const p = S.projects.get(slug);
  if (!p) { setBar('Проект', '', '#/'); v.innerHTML = `<div class="card"><div class="empty">${S.busy ? 'Загрузка…' : 'Проект не найден. Возможно, он ещё создаётся или удалён.'}</div></div>`; return; }
  const f = viewFiles(p);
  projectBar(p, f);
  v.innerHTML = `<nav class="seg">${TABS.map(([k, t]) => `<a href="#/p/${encodeURIComponent(slug)}/${k}" class="${k === tab ? 'on' : ''}">${t}</a>`).join('')}</nav><div id="tab"></div>`;
  // Активная вкладка — по центру полосы (без прокрутки всей страницы).
  const seg = v.querySelector('.seg'), active = seg.querySelector('.on');
  if (active) seg.scrollLeft = active.offsetLeft - (seg.clientWidth - active.offsetWidth) / 2;
  const el = $('tab');
  const views = { chat: chatTab, over: overTab, docs: docsTab, files: filesTab, tasks: tasksTab, cost: costTab, src: sourcesTab, log: logTab };
  (views[tab] || chatTab)(p, f, el);
}
function projectBar(p, f) {
  const pj = f['project.json'] instanceof Error ? null : f['project.json'];
  setBar(pj?.name || p.slug, pj ? pj.status + (pj.customer ? ' · ' + pj.customer : '') : 'ошибка данных', '#/');
}

// ---- Чат ----
// Текст сообщения → HTML: ссылки, @упоминания, #номер предложения. Экранируем по частям,
// чтобы «&#39;» и «&quot;» из экранирования не превращались в ссылки.
function linkify(text) {
  return String(text ?? '').split(/(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/).map((part, i) => {
    if (i % 2) return `<a href="${esc(part)}" target="_blank" rel="noopener">${esc(part)}</a>`;
    return esc(part).replace(/(^|[\s(])(@[\wа-яё]+)/gi, '$1<b class="mention">$2</b>').replace(/(^|[\s(])#(\d+)\b/g, '$1<a href="#/inbox/$2">#$2</a>');
  }).join('');
}
const drafts = new Map(); // черновик сообщения для каждого проекта
function chatTab(p, f, el) {
  S.chatOpen = p.slug;
  document.body.classList.add('in-chat');
  let pj = f['project.json'];
  let replyTo = null, attachments = [], byId = new Map(), lastCount = -1;
  el.innerHTML = `<div class="chat" id="chatList"></div>
    <form class="composer" id="composer">
      <div id="replyBox" class="replybox" hidden></div>
      <div class="quick"><a class="call claude" id="callClaude" href="${esc(callUrl('claude', p, pj))}" target="_blank" rel="noopener">▶ Claude</a><a class="call gpt" id="callGpt" href="${esc(callUrl('chatgpt', p, pj))}" target="_blank" rel="noopener">▶ ChatGPT</a><button type="button" data-at="@Claude ">@Claude</button><button type="button" data-at="@ChatGPT ">@ChatGPT</button><button type="button" data-at="@все ">@все</button><button type="button" id="manual">Задание</button></div>
      <div class="line">
        <label class="clip" aria-label="Приложить файлы">📎<input type="file" id="attach" multiple hidden></label>
        <textarea id="msg" rows="1" placeholder="Сообщение…" enterkeyhint="enter"></textarea>
        <button class="send" id="sendBtn" aria-label="Отправить">↑</button>
      </div>
      <div id="attList" class="attlist" hidden></div>
    </form>`;
  const list = $('chatList'), ta = $('msg'), composer = $('composer');
  const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  const toBottom = () => window.scrollTo(0, document.documentElement.scrollHeight);
  // Отступ под сообщениями = высота панели ввода (она растёт вместе с текстом и списком вложений).
  const fit = () => { list.style.paddingBottom = Math.max(0, window.innerHeight - composer.getBoundingClientRect().top) + 12 + 'px'; };
  const renderList = () => {
    const msgs = [...(p.chat || []).map(m => ({ ...m })),
      ...S.pulls.flatMap(pr => (S.pullInfo.get(pr.number)?.chat || []).filter(m => m._slug === p.slug)),
      ...pendingFor(p.slug).filter(o => o.type === 'chat').map(o => ({ ...o.message, _pending: true, _err: o.error }))];
    msgs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    byId = new Map(msgs.map(m => [m.id, m]));
    const stick = lastCount < 0 || nearBottom();
    let day = '';
    list.innerHTML = p.chat === null && !msgs.length ? '<div class="empty">Загрузка сообщений…</div>' : msgs.length ? msgs.map(m => {
      const cls = whoClass(m.author), mine = m.author === me();
      const reply = m.replyTo && byId.get(m.replyTo);
      const d = (m.date || '').slice(0, 10), sep = d && d !== day ? `<div class="day">${dayLabel(m.date)}</div>` : '';
      if (d) day = d;
      return `${sep}<div class="msg ${mine ? 'mine' : ''} ${cls}">
        ${mine ? '' : `<div class="who">${esc(m.author)}</div>`}
        <div class="bubble">${reply ? `<div class="quote">${esc(reply.author)}: ${esc((reply.text || '').slice(0, 90))}${(reply.text || '').length > 90 ? '…' : ''}</div>` : ''}
        <div class="text">${linkify(m.text || '')}</div>
        ${(m.files || []).map(x => `<button type="button" class="att" data-open="${esc(x.path)}" data-name="${esc(x.name)}">📎 ${esc(x.name)} · ${fmtSize(x.size || 0)}</button>`).join('')}
        <div class="meta">${m._pending ? (m._err ? '⚠ ' + esc(m._err) : '⏳ ждёт отправки') : m._pr ? `в предложении <a href="#/inbox/${m._pr}">#${m._pr}</a>` : fmtClock(m.date)}${mine || m._pending || m._bad ? '' : ` · <button type="button" class="lnk" data-reply="${esc(m.id)}">ответить</button>`}</div></div></div>`;
    }).join('') : `<div class="intro"><b>Чат проекта «${esc(pj?.name || p.slug)}»</b><br>Здесь работаем втроём. Напишите задачу и позовите <b>@Claude</b>, <b>@ChatGPT</b> или <b>@все</b>. Файлы прикладываются скрепкой.</div>`;
    fit();
    if (stick || msgs.length > lastCount && msgs.at(-1)?.author === me()) toBottom();
    lastCount = msgs.length;
  };
  const showAttachments = () => {
    $('attList').hidden = !attachments.length;
    $('attList').innerHTML = attachments.map((x, i) => `<span class="attchip">📎 ${esc(x.name)} · ${fmtSize(x.size)}<button type="button" class="lnk" data-unattach="${i}" aria-label="Убрать">✕</button></span>`).join('');
    fit();
  };
  const setReply = id => {
    replyTo = id; const m = id && byId.get(id);
    $('replyBox').hidden = !m;
    $('replyBox').innerHTML = m ? `<span>Ответ для <b>${esc(m.author)}</b>: ${esc((m.text || '').slice(0, 60))}${(m.text || '').length > 60 ? '…' : ''}</span><button type="button" class="lnk" id="noReply" aria-label="Не отвечать">✕</button>` : '';
    if (m) $('noReply').onclick = () => setReply(null);
    fit();
  };
  list.onclick = e => {
    const o = e.target.closest('[data-open]'); if (o) return openFile(o.dataset.open, o.dataset.name);
    const r = e.target.closest('[data-reply]'); if (r) { setReply(r.dataset.reply); ta.focus(); }
  };
  ta.value = drafts.get(p.slug) || '';
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; fit(); };
  ta.oninput = () => { drafts.set(p.slug, ta.value); grow(); };
  // Во время набора нижняя панель вкладок прячется, а поле ввода поднимается над клавиатурой.
  ta.onfocus = () => { document.body.classList.add('typing'); keyboardOffset(); setTimeout(fit, 220); };
  ta.onblur = () => setTimeout(() => { if (document.activeElement !== ta) { document.body.classList.remove('typing'); document.body.style.removeProperty('--kb'); setTimeout(fit, 220); } }, 150);
  for (const b of el.querySelectorAll('[data-at]')) b.onclick = () => { ta.value = (ta.value && !/\s$/.test(ta.value) ? ta.value + ' ' : ta.value) + b.dataset.at; drafts.set(p.slug, ta.value); grow(); ta.focus(); };
  $('attach').onchange = () => { attachments.push(...$('attach').files); $('attach').value = ''; showAttachments(); };
  $('attList').onclick = e => { const x = e.target.closest('[data-unattach]'); if (x) { attachments.splice(+x.dataset.unattach, 1); showAttachments(); } };
  $('manual').onclick = () => manualHelp(p, pj);
  for (const [id, who] of [['callClaude', 'claude'], ['callGpt', 'chatgpt']]) $(id).onclick = () => callAi(who, p, pj);
  composer.onsubmit = async e => {
    e.preventDefault();
    const text = ta.value.trim(); if ((!text && !attachments.length) || $('sendBtn').disabled) return;
    $('sendBtn').disabled = true;
    // Поле очищаем сразу (сообщение видно в ленте как «ждёт отправки»); при ошибке текст возвращается.
    const files0 = attachments, reply0 = replyTo;
    ta.value = ''; drafts.delete(p.slug); attachments = []; showAttachments(); setReply(null); grow();
    let ok = false;
    try {
      const files = [], uploads = [];
      const id = M.newId('m');
      for (const file of files0) { const st = await stageFile(file, 'chat', p.slug, id); files.push(st.ref); uploads.push(...st.uploads); }
      const msg = M.newChatMessage({ author: me(), text: text || 'Файлы', files, mentions: M.mentionsIn(text), replyTo: reply0 || undefined });
      msg.id = id;
      ok = await run(p.slug, { type: 'chat', message: msg, uploads }, `Сообщение в чате «${pj?.name || p.slug}»`);
    } catch (err) { toast(err.message, true); }
    finally {
      $('sendBtn').disabled = false;
      if (!ok && !ta.value) { ta.value = text; drafts.set(p.slug, text); attachments = files0; showAttachments(); setReply(reply0); grow(); }
    }
  };
  S.chat = { slug: p.slug, el: composer, refresh: () => {
    const np = S.projects.get(p.slug); if (np !== p) { p = np; }
    pj = viewFiles(p)['project.json']; projectBar(p, viewFiles(p));
    renderList();
    if (p.chat === null || p.chat.length !== p.chatEntries.length) loadChat(p.slug).then(() => { if (S.chat?.el === composer) renderList(); });
  } };
  if (window.ResizeObserver) new ResizeObserver(fit).observe(composer);
  renderList(); grow();
  if (p.chat === null || p.chat.length !== p.chatEntries.length) loadChat(p.slug).then(() => { if (S.chat?.el === composer) renderList(); });
  chatPoll = setInterval(async () => {
    if (document.visibilityState !== 'visible' || S.busy || S.offline || !S.client) return;
    try { const h = await S.client.head(); if (h.commit !== S.head?.commit) await load(); } catch {}
  }, 20000);
}
const fmtClock = iso => { const d = new Date(iso); return !iso || Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };
function dayLabel(iso) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  const k = x => x.toDateString(), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  if (k(d) === k(now)) return 'Сегодня';
  if (k(d) === k(y)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
// Высота экранной клавиатуры iPhone: поле ввода ставим прямо над ней.
function keyboardOffset() {
  const vv = window.visualViewport; if (!vv) return;
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.body.style.setProperty('--kb', kb + 'px');
}
window.visualViewport?.addEventListener('resize', () => { if (document.body.classList.contains('typing')) keyboardOffset(); });
// ---- Позвать ИИ ----
// Бота нет (правила GitHub), поэтому кнопка открывает приложение Claude или ChatGPT и кладёт
// в буфер готовую команду: в сохранённом рабочем чате — короткое «чат …», в новом чате — полное
// задание (ИИ там не знает контекста). Ссылка открывается сразу по нажатию, без ожидания буфера.
const AI = {
  claude: { name: 'Claude', key: 'claudeUrl', fresh: q => 'https://claude.ai/new?q=' + encodeURIComponent(q), ok: /^https:\/\/claude\.ai\/(chat|code|project)\/[^\s]+$/ },
  chatgpt: { name: 'ChatGPT', key: 'chatgptUrl', fresh: q => 'https://chatgpt.com/?q=' + encodeURIComponent(q), ok: /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/(c\/|g\/[^/\s]+\/c\/)[^\s]+$/ }
};
function callText(p, pj, full) {
  const name = pj?.name || p.slug;
  return full ? taskPrompt(p, pj) : `чат — проект «${name}» (projects/${p.slug}/): прочитай новые сообщения и ответь в чате приложения.`;
}
function callUrl(who, p, pj) {
  const a = AI[who], saved = S.settings[a.key];
  return saved && a.ok.test(saved) ? saved : a.fresh(callText(p, pj, true));
}
// Копирование синхронно (execCommand) — успевает до ухода со страницы на iOS; Clipboard API — запасной.
function copyNow(text) {
  let ok = false;
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    ok = document.execCommand('copy'); t.remove();
  } catch { ok = false; }
  if (!ok && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  return ok;
}
function callAi(who, p, pj) {
  const a = AI[who], saved = S.settings[a.key] && a.ok.test(S.settings[a.key]);
  const ok = copyNow(callText(p, pj, !saved));
  toast(ok ? (saved ? `Команда скопирована — вставьте в чат ${a.name} и отправьте` : `Задание скопировано — вставьте в ${a.name} и отправьте`)
    : `Не удалось скопировать: вернитесь и нажмите «Задание» → «Скопировать»`, !ok);
}
function taskPrompt(p, pj) {
  const repo = `${S.settings.owner}/${S.settings.repo}`;
  return `Работаем над проектом «${pj?.name || p.slug}» в GitHub-репозитории ${repo}, папка projects/${p.slug}/. Прочитай AGENTS.md и последние сообщения в projects/${p.slug}/chat/. Ответь в чат проекта по правилам AGENTS.md (новый файл сообщения), а изменения файлов проекта оформи как предложение (pull request).`;
}
function manualHelp(p, pj) {
  const prompt = taskPrompt(p, pj);
  sheet('Позвать ИИ вручную', `<p class="muted">Если автоматический ответ не настроен или нет ответа — скопируйте задание и вставьте его в приложение Claude или ChatGPT. Оба ИИ работают с одним и тем же репозиторием и видят сообщения друг друга.</p>
    <pre class="prompt" id="prompt">${esc(prompt)}</pre>
    <div class="btns full"><button type="button" class="btn primary" id="copyPrompt">Скопировать</button></div>
    <div class="btns full" style="margin-top:8px"><a class="btn" href="https://claude.ai/new" target="_blank" rel="noopener">Открыть Claude</a><a class="btn" href="https://chatgpt.com/" target="_blank" rel="noopener">Открыть ChatGPT</a></div>`);
  $('copyPrompt').onclick = async () => { try { await navigator.clipboard.writeText(prompt); toast('Задание скопировано'); } catch { toast('Выделите текст и скопируйте вручную', true); } };
}

// ---- Открытие файлов ----
// Где сейчас лежит путь: сначала самые новые изменения из очереди на телефоне (они ещё не
// отправлены, но уже действуют), затем принятая версия. Замена или удаление файла в очереди
// скрывает его прежнее представление (целый файл, части, манифест).
function findEntry(path) {
  const L = M.wholeOf(path) || path;
  for (let i = S.outbox.length - 1; i >= 0; i--) {
    const o = S.outbox[i];
    for (const u of o.uploads || []) if (u.path === path) return { key: u.key };
    if ((o.replace || []).includes(L) || (o.type === 'deleteFile' && o.path === L)) return null;
  }
  const e = S.entries.get(path); return e ? { sha: e.sha, size: e.size } : null;
}
const hasFile = path => !!(findEntry(path) || findEntry(M.manifestPath(path)));
async function partBytes(path) {
  const e = findEntry(path);
  if (!e) return null;
  return e.key ? C.get('uploads', e.key) : blobBytes(e.sha);
}
// ArrayBuffer для обычного файла; Blob, собранный из частей, — для большого.
async function fileBytes(path) {
  const e = findEntry(path);
  if (e) return e.key ? C.get('uploads', e.key) : blobBytes(e.sha);
  const mBytes = await partBytes(M.manifestPath(path));
  if (!mBytes) throw new Error('Файл ещё не принят в проект или удалён');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(mBytes)); } catch { throw new Error('Описание частей файла повреждено'); }
  return assembleParts(manifest, partBytes, (i, n) => { const pg = $('pgF'); if (pg) pg.style.width = (100 * i / n) + '%'; });
}
const mime = ext => ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dxf: 'image/vnd.dxf', stl: 'model/stl', step: 'model/step', stp: 'model/step' }[ext] || 'application/octet-stream');
async function openFile(path, name, { slug = null, editable = false } = {}) {
  name = name || path.split('/').pop();
  sheet(name, '<div class="empty">Загрузка файла…</div><div class="progress"><i id="pgF" style="width:0"></i></div>');
  let bytes;
  try { bytes = await fileBytes(path); } catch (e) { $('sheetBody').innerHTML = `<div class="errors">${esc(e.message)}</div>`; return; }
  const size = bytes instanceof Blob ? bytes.size : bytes.byteLength;
  const ext = extOf(name), blob = new Blob([bytes], { type: mime(ext) }), url = URL.createObjectURL(blob);
  const file = new File([blob], name, { type: blob.type });
  const isText = !(bytes instanceof Blob) && TEXT_EXT.includes(ext) && size < 2 * 1024 * 1024;
  let preview = '';
  if (IMG_EXT.includes(ext) || ext === 'svg') preview = `<img class="preview" src="${url}" alt="">`;
  else if (isText) preview = editable ? area('content', 'Содержимое', new TextDecoder().decode(bytes), 'style="min-height:45vh;font:13px ui-monospace,Menlo,monospace"') : `<pre class="prompt" style="max-height:50vh;overflow:auto">${esc(new TextDecoder().decode(bytes))}</pre>`;
  else if (ext === 'pdf') preview = `<p class="muted">PDF · ${fmtSize(size)}. Откройте для просмотра или сохраните в «Файлы».</p>`;
  else preview = `<p class="muted">${esc(ext.toUpperCase() || 'Файл')} · ${fmtSize(size)}${bytes instanceof Blob ? ' · собран из частей, контрольные суммы совпали' : ''}. Сохраните в «Файлы» или откройте в подходящем приложении (САПР, просмотрщик).</p>`;
  const canShare = navigator.canShare?.({ files: [file] });
  $('sheetBody').innerHTML = `${preview}
    <div class="btns full" style="margin-top:12px">
      ${canShare ? '<button type="button" class="btn primary" id="shareF">Поделиться / в Файлы</button>' : ''}
      <a class="btn ${canShare ? '' : 'primary'}" href="${url}" download="${esc(name)}">Скачать</a>
      <a class="btn" href="${url}" target="_blank" rel="noopener">Открыть</a>
    </div>
    ${editable ? `<div class="btns full" style="margin-top:8px"><label class="btn">Заменить файл<input type="file" id="replaceF" hidden></label><button type="button" class="btn danger" id="delF">Удалить</button></div>` : ''}`;
  if (canShare) $('shareF').onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
  if (editable && slug) {
    $('sheetOk').hidden = !isText; $('sheetOk').textContent = 'Сохранить';
    sheetSubmit = async v => {
      const bytesNew = new TextEncoder().encode(v.content ?? ''); const key = M.newId('u');
      await C.put('uploads', key, bytesNew.buffer);
      return run(slug, { type: 'writeFile', uploads: [{ path, key }], replace: [path] }, `Изменён файл ${name}`);
    };
    $('replaceF').onchange = async e => {
      const fl = e.target.files[0]; if (!fl) return;
      let st; try { st = await stageAt(fl, path); } catch (err) { return toast(err.message, true); }
      if (await run(slug, { type: 'writeFile', uploads: st.uploads, replace: [path] }, `Заменён файл ${name}`)) closeSheet();
    };
    $('delF').onclick = async () => { if (confirm(`Удалить файл «${name}» из проекта? Он останется в истории GitHub.`) && await run(slug, { type: 'deleteFile', path }, `Удалён файл ${name}`)) closeSheet(); };
  }
}

// ---- Обзор ----
function linksBlock(pj) {
  if (!pj || pj instanceof Error) return '';
  const parent = pj.parent ? projById(pj.parent) : null, kids = childrenOf(pj.id), rel = relatedOf(pj);
  return (pj.parent ? `<h2>Входит в проект</h2><div class="card">${parent ? projLink(parent) : `<div class="empty">Проект ${esc(pj.parent)} не найден</div>`}</div>` : '')
    + (kids.length ? `<h2>Подпроекты</h2><div class="card">${kids.map(projLink).join('')}</div>` : '')
    + (rel.length ? `<h2>Связанные проекты</h2><div class="card">${rel.map(projLink).join('')}</div>` : '');
}
function overTab(p, f, el) {
  const pj = f['project.json'];
  const docs = f['documents.json']?.documents || [], tasks = f['tasks.json']?.tasks || [], decisions = f['tasks.json']?.decisions || [];
  const t = f['cost.json']?.items ? M.costTotals(f['cost.json']) : null;
  const prs = S.pulls.filter(pr => S.pullInfo.get(pr.number)?.slugs.includes(p.slug));
  const approved = docs.filter(d => (d.revisions || []).some(r => r.status === M.APPROVED)).length;
  const openTasks = tasks.filter(x => x.status !== 'Готово').length, enc = encodeURIComponent(p.slug);
  el.innerHTML = `
    ${p.errors.length ? `<div class="errors"><b>Ошибки в данных проекта</b> — исправьте или попросите ИИ:<ul>${p.errors.slice(0, 12).map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    ${pj && !(pj instanceof Error) ? `<div class="stamp">
      <div class="stamp-name"><h1>${esc(pj.name)}</h1><span class="mark" aria-hidden="true"></span></div>
      <div class="stamp-cells">
        <div><span>Заказчик</span><b>${esc(pj.customer || 'не указан')}</b></div>
        <div><span>Статус</span><b>${chip(pj.status, statusCls(pj.status))}</b></div>
        <div><span>Создан</span><b>${fmtDate(pj.created)}</b></div>
        <div><span>Изменён</span><b>${fmtDate(pj.updated)}</b></div>
      </div></div>` : ''}
    <div class="tiles">
      <a class="tile" href="#/p/${enc}/docs"><div class="v">${docs.length}</div><div class="l">${pluralWord(docs.length, 'документ', 'документа', 'документов')} · к выдаче ${approved}</div></a>
      <a class="tile" href="#/p/${enc}/tasks"><div class="v">${openTasks}</div><div class="l">${pluralWord(openTasks, 'открытая задача', 'открытые задачи', 'открытых задач')} из ${tasks.length}</div></a>
      <a class="tile" href="#/p/${enc}/cost"><div class="v money">${t ? M.rub(t.total) : '—'}</div><div class="l">себестоимость без НДС</div></a>
      <a class="tile" href="#/p/${enc}/files"><div class="v">${groupParts(p.fileEntries).length}</div><div class="l">${pluralWord(groupParts(p.fileEntries).length, 'файл', 'файла', 'файлов')}</div></a>
    </div>
    <h2>Описание</h2><div class="card pad body">${esc(pj?.description || 'Нет описания.')}</div>
    ${linksBlock(pj)}
    ${prs.length ? `<h2>Предложения ИИ</h2><div class="card">${prs.map(pr => prRow(pr)).join('')}</div>` : ''}
    ${decisions.length ? `<h2>Последние решения</h2><div class="card">${decisions.slice(-3).reverse().map(d => `<div class="row"><div class="grow"><div class="t">${esc(d.title)}</div><div class="s">${fmtDate(d.date)} · ${esc(d.author)}</div></div></div>`).join('')}</div>` : ''}
    <div class="btns full" style="margin-top:14px"><button class="btn" id="editP">Изменить проект</button><button class="btn" id="zip">Скачать ZIP</button></div>
    <div class="btns full" style="margin-top:8px"><button class="btn" id="offline">Сохранить для работы без связи</button></div>`;
  $('editP').onclick = () => sheet('Проект', input('name', 'Название', pj.name, 'required') + select('status', 'Статус', M.PROJECT_STATUSES, pj.status) + input('customer', 'Заказчик', pj.customer) + area('description', 'Описание', pj.description, 'style="min-height:160px"') + linkFields(pj),
    (v, form) => {
      if (!v.name) throw new Error('Укажите название');
      const rel = form.getAll('related');
      if (v.parent && withDescendants(pj.id).has(v.parent)) throw new Error('Нельзя вложить проект в его собственный подпроект');
      return run(p.slug, { type: 'set', file: 'project.json', fields: { name: v.name, status: v.status, customer: v.customer, description: v.description, parent: v.parent || null, related: rel.length ? rel : null } }, `Изменён проект «${v.name}»`);
    });
  $('zip').onclick = () => zipProject(p, pj);
  $('offline').onclick = () => cacheProject(p);
}
async function projectPaths(p) { return [...S.entries.keys()].filter(k => k.startsWith(`projects/${p.slug}/`)); }
async function cacheProject(p) {
  if (S.offline) return toast('Нет связи', true);
  const b = startBulk('сохранение проекта на телефон'); if (!b) return;
  try {
  const paths = await projectPaths(p); let done = 0, failed = 0;
  sheet('Сохранение на телефон', `<p>Загружаю ${plural(paths.length, 'файл', 'файла', 'файлов')}…</p><div class="progress"><i id="pg" style="width:0"></i></div>`);
  await C.persist();
  await bulkPool(paths, b, async path => { try { await blobBytes(S.entries.get(path).sha, true); } catch { failed++; } done++; const pg = $('pg'); if (pg) pg.style.width = (100 * done / paths.length) + '%'; });
  if (b.cancelled) return;
  $('sheetBody').innerHTML = `<p>${failed ? `Сохранено ${done - failed}, не удалось ${failed}.` : 'Готово. Проект можно открывать, скачивать и менять без связи. Изменения отправятся автоматически, когда связь появится.'}</p>`;
  } finally { endBulk(b); }
}
// Содержимое файла для ZIP: части большого файла собираются в один файл с исходным именем пути.
async function zipBytes(g) {
  if (!g.parts) return new Uint8Array(await blobBytes(S.entries.get(g.path).sha));
  const data = await fileBytes(g.path);
  return new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
}
const sizeOf = paths => paths.reduce((n, x) => n + (S.entries.get(x)?.size || 0), 0);
async function zipProject(p, pj) {
  const paths0 = await projectPaths(p), total = sizeOf(paths0);
  if (total > ZIP_WARN && !confirm(`Архив проекта займёт около ${fmtSize(total)}. На телефоне это может не поместиться в память. Надёжнее скачать на компьютере. Продолжить?`)) return;
  const b = startBulk('сборка ZIP проекта'); if (!b) return;
  try {
  const paths = groupParts(paths0.map(path => ({ path })));
  sheet('Архив проекта', `<p>Собираю ${plural(paths.length, 'файл', 'файла', 'файлов')}…</p><div class="progress"><i id="pg" style="width:0"></i></div>`);
  let done = 0; const missing = [];
  const files = [];
  await bulkPool(paths, b, async g => {
    try { files.push({ name: g.path.slice(`projects/${p.slug}/`.length), bytes: await zipBytes(g) }); }
    catch { missing.push(g.path); }
    finally { done++; const pg = $('pg'); if (pg) pg.style.width = (100 * done / paths.length) + '%'; }
  });
  if (b.cancelled) return;
  files.sort((x, y) => x.name.localeCompare(y.name));
  const name = M.safeFileName((pj?.name || p.slug) + '.zip');
  const blob = makeZip(files), url = URL.createObjectURL(blob), file = new File([blob], name, { type: 'application/zip' });
  const canShare = navigator.canShare?.({ files: [file] });
  $('sheetBody').innerHTML = `<p>Архив готов: ${fmtSize(blob.size)}${missing.length ? `. Не вошли (нет связи): ${missing.length}` : ''}.</p>
    <div class="btns full">${canShare ? '<button type="button" class="btn primary" id="shareZ">Сохранить в Файлы</button>' : ''}<a class="btn ${canShare ? '' : 'primary'}" href="${url}" download="${esc(name)}">Скачать</a></div>`;
  if (canShare) $('shareZ').onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
  } finally { endBulk(b); }
}

// ---- Весь архив: копия на телефоне и ZIP ----
// Для устойчивости: если GitHub или кто-то из ИИ недоступен, все проекты остаются на телефоне,
// а ZIP можно сохранить в «Файлы», на компьютер или внешний диск.
const allPaths = () => [...S.entries.keys()].filter(k => k.startsWith('projects/'));
function offlineSummary() {
  const st = S.offlineAll;
  const total = allPaths().reduce((n, p) => n + (S.entries.get(p)?.size || 0), 0);
  const base = `${plural(allPaths().length, 'файл', 'файла', 'файлов')}, ${fmtSize(total)} в хранилище`;
  return st ? `${base}; на телефон сохранено ${fmtTime(st.at)}${st.failed ? `, не удалось: ${st.failed}` : ''}` : `${base}; полная копия ещё не сохранялась`;
}
async function cacheAll() {
  if (S.offline || !S.client) return toast('Нет связи с GitHub', true);
  const b = startBulk('сохранение всех проектов на телефон'); if (!b) return;
  try {
  const paths = allPaths(); let done = 0, failed = 0;
  sheet('Все проекты на телефон', `<p>Загружаю ${plural(paths.length, 'файл', 'файла', 'файлов')}. Не закрывайте приложение.</p><div class="progress"><i id="pg" style="width:0"></i></div>`);
  await C.persist();
  // Не больше 2 запросов одновременно — бережная нагрузка на GitHub. Файл считается сохранённым,
  // только если запись в память телефона подтверждена.
  await bulkPool(paths, b, async path => { try { await blobBytes(S.entries.get(path).sha, true); } catch { failed++; } done++; const pg = $('pg'); if (pg) pg.style.width = (100 * done / paths.length) + '%'; });
  if (b.cancelled) return;
  S.offlineAll = { at: new Date().toISOString(), failed, commit: S.head?.commit };
  await C.put('kv', 'offlineAll', S.offlineAll).catch(() => {});
  $('sheetBody').innerHTML = `<p>${failed ? `Сохранено ${done - failed}, не удалось ${failed}. Повторите при хорошей связи.` : 'Готово. Все проекты открываются и скачиваются без связи с GitHub. Изменения копятся в очереди и отправятся, когда доступ появится.'}</p>`;
  } finally { endBulk(b); }
}
const ZIP_WARN = 300 * 1048576;
async function zipAll() {
  const paths0 = allPaths(), total = sizeOf(paths0);
  const paths = groupParts(paths0.map(path => ({ path })));
  if (total > ZIP_WARN && !confirm(`Архив займёт около ${fmtSize(total)}. На телефоне это может не поместиться в память. Надёжнее скачать полную копию на компьютере (GitHub Desktop). Продолжить?`)) return;
  const b = startBulk('сборка ZIP всего архива'); if (!b) return;
  try {
  sheet('Весь архив', `<p>Собираю ${plural(paths.length, 'файл', 'файла', 'файлов')}…</p><div class="progress"><i id="pg" style="width:0"></i></div>`);
  let done = 0; const missing = [];
  const files = [];
  await bulkPool(paths, b, async g => {
    try { files.push({ name: g.path, bytes: await zipBytes(g) }); }
    catch { missing.push(g.path); }
    finally { done++; const pg = $('pg'); if (pg) pg.style.width = (100 * done / paths.length) + '%'; }
  });
  if (b.cancelled) return;
  files.sort((x, y) => x.name.localeCompare(y.name));
  const name = `IGNIS-PRO-arhiv-${new Date().toISOString().slice(0, 10)}.zip`;
  const blob = makeZip(files), url = URL.createObjectURL(blob), file = new File([blob], name, { type: 'application/zip' });
  const canShare = navigator.canShare?.({ files: [file] });
  $('sheetBody').innerHTML = `<p>Архив готов: ${fmtSize(blob.size)}, ${plural(files.length, 'файл', 'файла', 'файлов')}${missing.length ? `. Не вошли (нет связи и нет копии на телефоне): ${missing.length}` : ''}.</p>
    <div class="btns full">${canShare ? '<button type="button" class="btn primary" id="shareZ">Сохранить в Файлы</button>' : ''}<a class="btn ${canShare ? '' : 'primary'}" href="${url}" download="${esc(name)}">Скачать</a></div>`;
  if (canShare) $('shareZ').onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
  } finally { endBulk(b); }
}

// ---- Документы ----
function nextRev(doc) {
  const nums = (doc.revisions || []).map(r => +(/(\d+)\s*$/.exec(r.rev)?.[1] || 0));
  const n = Math.max(0, ...nums) + 1; return 'R' + String(n).padStart(2, '0');
}
function docsTab(p, f, el) {
  const docs = f['documents.json']?.documents || [];
  el.innerHTML = `<div class="card">${docs.length ? docs.map(d => `
    <div class="row"><div class="grow"><div class="t">${esc(d.name)}</div><div class="chips">${chip(d.format)}${chip(plural((d.revisions || []).length, 'редакция', 'редакции', 'редакций'))}</div></div><button class="btn small" data-editdoc="${d.id}" aria-label="Переименовать">✎</button><button class="btn small" data-addrev="${d.id}">+ Ред.</button></div>
    ${(d.revisions || []).slice().reverse().map(r => `<div class="rev"><div class="r">${esc(r.rev)}</div><div class="grow">
      <div class="chips" style="margin-top:0">${chip(r.status, statusCls(r.status))}${chip(r.author, whoClass(r.author))}<span class="muted">${fmtDate(r.date)}</span></div>
      ${r.note ? `<div class="s" style="margin-top:4px">${esc(r.note)}</div>` : ''}
      <div class="btns" style="margin-top:8px">${r.file ? `<button class="btn small" data-open="${esc(r.file.path)}" data-name="${esc(r.file.name)}">📄 ${esc(r.file.name)} · ${fmtSize(r.file.size)}</button>` : '<span class="muted">без файла</span>'}<button class="btn small" data-status="${d.id}|${r.id}">Статус</button></div>
    </div></div>`).join('')}`).join('') : '<div class="empty">Документов нет. Зарегистрируйте чертёж, модель или расчёт.</div>'}</div>
    <button class="add" id="addDoc">Новый документ</button>
    <p class="muted" style="margin:10px 4px">Одна редакция — один неизменяемый файл. Чтобы изменить содержимое, создайте новую редакцию. «Разрешено к выдаче» ставит только ${esc(me())}; это отметка, а не замена инженерной проверки.</p>`;
  el.onclick = async e => {
    const o = e.target.closest('[data-open]'); if (o) return openFile(o.dataset.open, o.dataset.name);
    const ed = e.target.closest('[data-editdoc]');
    if (ed) {
      const d = docs.find(x => x.id === ed.dataset.editdoc);
      return sheet('Документ', input('name', 'Название', d.name, 'required') + select('format', 'Формат', M.DOC_FORMATS, d.format), v => {
        if (!v.name) throw new Error('Укажите название');
        return run(p.slug, { type: 'upsert', file: 'documents.json', list: 'documents', item: { id: d.id, name: v.name, format: v.format } }, `Документ «${d.name}» → «${v.name}»`);
      });
    }
    const a = e.target.closest('[data-addrev]'); if (a) return revSheet(p, docs.find(d => d.id === a.dataset.addrev));
    const s = e.target.closest('[data-status]'); if (s) {
      const [docId, revId] = s.dataset.status.split('|'); const d = docs.find(x => x.id === docId), r = d.revisions.find(x => x.id === revId);
      return sheet(`${d.name} · ${r.rev}`, select('status', 'Статус', M.REV_STATUSES, r.status) + `<p class="note">«Разрешено к выдаче» может быть только у одной редакции: прежняя разрешённая перейдёт в «Архив».</p>`,
        v => { if (v.status === M.APPROVED && !confirm(`Разрешить к выдаче ${d.name} ${r.rev}? Это ваша отметка, она не заменяет инженерную проверку.`)) return false; return run(p.slug, { type: 'status', docId, revId, status: v.status }, `${d.name} ${r.rev}: статус «${v.status}»`); });
    }
  };
  $('addDoc').onclick = () => sheet('Новый документ', input('name', 'Название', '', 'required placeholder="Комплект КМ, Звезда — развёртка…"') + select('format', 'Формат', M.DOC_FORMATS, 'PDF') + input('rev', 'Первая редакция', 'R01') + field('Файл', '<input type="file" name="file">') + area('note', 'Примечание'),
    async (v, form) => {
      if (!v.name) throw new Error('Укажите название');
      const rid = M.newId('r'), item = { id: rid, rev: v.rev || 'R01', status: 'Не проверено', date: M.today(), author: me() };
      if (v.note) item.note = v.note;
      const fl = form.get('file'); const uploads = [];
      if (fl && fl.size) { const s = await stageFile(fl, 'docs', p.slug, rid); item.file = s.ref; uploads.push(...s.uploads); }
      return run(p.slug, { type: 'upsert', file: 'documents.json', list: 'documents', item: { id: M.newId('d'), name: v.name, format: v.format, revisions: [item] }, uploads }, `Новый документ «${v.name}» ${item.rev}`);
    }, 'Создать');
}
function revSheet(p, d) {
  sheet(`${d.name}: новая редакция`, input('rev', 'Редакция', nextRev(d)) + field('Файл', '<input type="file" name="file">') + area('note', 'Что изменено'),
    async (v, form) => {
      if (!v.rev) throw new Error('Укажите редакцию');
      const rid = M.newId('r'), item = { id: rid, rev: v.rev, status: 'Не проверено', date: M.today(), author: me() };
      if (v.note) item.note = v.note;
      const fl = form.get('file'); const uploads = [];
      if (fl && fl.size) { const s = await stageFile(fl, 'docs', p.slug, rid); item.file = s.ref; uploads.push(...s.uploads); }
      return run(p.slug, { type: 'revision', docId: d.id, item, uploads }, `${d.name}: редакция ${v.rev}`);
    }, 'Добавить');
}

// ---- Файлы ----
const KIND_NAMES = { work: 'Рабочие файлы', docs: 'Файлы документов', sources: 'Источники', chat: 'Из чата' };
function filesTab(p, f, el) {
  const pend = pendingFor(p.slug).flatMap(o => (o.uploads || []).map(u => ({ path: u.path, pending: true, kind: u.path.split('/')[3] })));
  // Части большого файла показываются одним файлом.
  // Принятые файлы, которые ещё не заменены и не удалены изменениями из очереди, + ожидающие отправки.
  const all = groupParts([...p.fileEntries.filter(x => findEntry(x.path)?.sha), ...pend.filter((x, i, arr) => findEntry(x.path)?.key && arr.findIndex(y => y.path === x.path) === i)])
    .map(g => g.parts ? { ...g.item, path: g.path, big: true, size: g.parts.reduce((n, x) => n + (x.size || 0), 0), pending: [...g.parts, g.manifest].some(x => x?.pending) } : g.item);
  const names = new Map();
  // Имя файла и откуда он: документ, источник или сообщение чата.
  for (const d of f['documents.json']?.documents || []) for (const r of d.revisions || []) if (r.file) names.set(r.file.path, { name: r.file.name, ctx: `${d.name}, ${r.rev}` });
  for (const s of f['sources.json']?.sources || []) if (s.file) names.set(s.file.path, { name: s.file.name, ctx: s.title });
  for (const m of p.chat || []) for (const x of m.files || []) names.set(x.path, { name: x.name, ctx: `${m.author}, ${fmtTime(m.date)}` });
  el.innerHTML = Object.keys(KIND_NAMES).map(kind => {
    const items = all.filter(x => x.kind === kind); if (!items.length && kind !== 'work') return '';
    return `<h2>${KIND_NAMES[kind]}</h2><div class="card">${items.length ? items.map(x => `<button class="row" data-open="${esc(x.path)}" data-kind="${kind}"${x.big ? ' data-big="1"' : ''}>
      <span class="ficon">${IMG_EXT.includes(extOf(x.path)) ? '🖼' : TEXT_EXT.includes(extOf(x.path)) ? '📝' : ['stl', 'step', 'stp', 'sldprt', 'obj', '3mf'].includes(extOf(x.path)) ? '🧊' : '📄'}</span>
      <div class="grow"><div class="t">${esc(names.get(x.path)?.name || x.path.split('/').pop())}</div><div class="s">${[names.get(x.path)?.ctx ? esc(names.get(x.path).ctx) : '', x.pending ? '⏳ ждёт отправки' : fmtSize(x.size || 0), kind === 'work' ? 'можно изменить' : ''].filter(Boolean).join(' · ')}</div></div><span class="chev">›</span></button>`).join('') : '<div class="empty">Пусто. Здесь лежат расчёты, черновики, программы для ЧПУ — всё, над чем работаем.</div>'}</div>`;
  }).join('') + `
    <div class="btns full" style="margin-top:12px"><label class="btn primary">Загрузить файлы<input type="file" id="upWork" multiple hidden></label><button class="btn" id="newText">Новый текстовый файл</button></div>
    <div class="btns full" style="margin-top:8px"><button class="btn" id="zip2">Скачать всё (ZIP)</button><button class="btn" id="off2">Сохранить без связи</button></div>`;
  el.onclick = e => { const o = e.target.closest('[data-open]'); if (o) openFile(o.dataset.open, names.get(o.dataset.open)?.name || null, { slug: p.slug, editable: o.dataset.kind === 'work' && !o.dataset.big }); };
  $('upWork').onchange = async e => {
    const files = [...e.target.files]; if (!files.length) return;
    try {
      const uploads = [], replace = [];
      for (const fl of files) {
        const path = `projects/${p.slug}/files/work/${repoName(fl.name)}`;
        if (hasFile(path) && !confirm(`Файл ${fl.name} уже есть. Заменить?`)) continue;
        const s = await stageAt(fl, path); uploads.push(...s.uploads); replace.push(path);
      }
      if (replace.length) await run(p.slug, { type: 'writeFile', uploads, replace }, `Загружено файлов: ${replace.length}`);
    } catch (err) { toast(err.message, true); }
  };
  $('newText').onclick = () => sheet('Новый файл', input('name', 'Имя файла', '', 'required placeholder="raschet.txt, programma.nc, zametki.md"') + area('content', 'Содержимое', '', 'style="min-height:40vh;font:13px ui-monospace,Menlo,monospace"'),
    async v => {
      if (!v.name) throw new Error('Укажите имя файла');
      const path = `projects/${p.slug}/files/work/${M.safeFileName(v.name.includes('.') ? v.name : v.name + '.txt')}`;
      if (S.entries.has(path)) throw new Error('Такой файл уже есть');
      const key = M.newId('u'); await C.put('uploads', key, new TextEncoder().encode(v.content || '').buffer);
      return run(p.slug, { type: 'writeFile', uploads: [{ path, key }] }, `Новый файл ${path.split('/').pop()}`);
    }, 'Создать');
  $('zip2').onclick = () => zipProject(p, f['project.json']);
  $('off2').onclick = () => cacheProject(p);
}

// ---- Задачи и решения ----
function tasksTab(p, f, el) {
  const t = f['tasks.json'] || { tasks: [], decisions: [] };
  const showAll = sessionStorage.getItem('allTasks') === '1';
  const tasks = t.tasks.filter(x => showAll || x.status !== 'Готово');
  el.innerHTML = `
    <div class="line" style="display:flex;justify-content:space-between;align-items:center;margin:0 4px 8px"><h2 style="margin:0">Задачи</h2><button class="btn small" id="toggleAll">${showAll ? 'Только открытые' : 'Показать все'}</button></div>
    <div class="card">${tasks.length ? tasks.map(x => `<button class="row" data-task="${x.id}"><div class="grow"><div class="t" style="${x.status === 'Готово' ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(x.title)}</div>
      <div class="chips">${chip(x.assignee, whoClass(x.assignee))}${chip(x.status, statusCls(x.status))}${x.due ? `<span class="muted">до ${fmtDate(x.due)}</span>` : ''}</div></div><span class="chev">›</span></button>`).join('') : '<div class="empty">Открытых задач нет.</div>'}</div>
    <button class="add" id="addTask">Новая задача</button>
    <h2>Принятые решения</h2>
    <div class="card">${t.decisions.length ? t.decisions.slice().reverse().map(d => `<button class="row" data-dec="${d.id}"><div class="grow"><div class="t">${esc(d.title)}</div>${d.text ? `<div class="s">${esc(d.text.slice(0, 160))}${d.text.length > 160 ? '…' : ''}</div>` : ''}<div class="chips">${chip(d.author, whoClass(d.author))}<span class="muted">${fmtDate(d.date)}</span></div></div></button>`).join('') : '<div class="empty">Решения фиксируются здесь: что выбрали и почему.</div>'}</div>
    <button class="add" id="addDec">Записать решение</button>`;
  $('toggleAll').onclick = () => { sessionStorage.setItem('allTasks', showAll ? '0' : '1'); tasksTab(p, f, el); };
  const taskForm = x => area('title', 'Задача', x?.title, 'required rows="2" style="min-height:70px"') + `<div class="two">${select('assignee', 'Кто делает', people().includes(x?.assignee) || !x ? people() : [...people(), x.assignee], x?.assignee || me())}${select('status', 'Статус', M.TASK_STATUSES, x?.status || 'Открыта')}</div>` + input('due', 'Срок', x?.due || '', 'type="date"') + area('note', 'Подробности', x?.note);
  const saveTask = (x, v) => {
    v.title = v.title.replace(/\s*\n\s*/g, ' ');
    if (!v.title) throw new Error('Опишите задачу');
    if (v.due && !M.validDate(v.due)) throw new Error('Срок: выберите дату');
    // Пустые «Срок» и «Подробности» передаём как null — при сохранении поле удаляется из задачи.
    const item = { id: x?.id || M.newId('t'), title: v.title, assignee: v.assignee, status: v.status, created: x?.created || M.today(), author: x?.author || me(), due: v.due || null, note: v.note || null };
    return run(p.slug, { type: 'upsert', file: 'tasks.json', list: 'tasks', item }, `${x ? 'Изменена' : 'Новая'} задача «${v.title}»`).then(async ok => {
      if (ok && !x && (v.assignee === 'Claude' || v.assignee === 'ChatGPT') && confirm(`Отправить задачу в чат проекта с обращением к ${v.assignee}?`)) {
        const msg = M.newChatMessage({ author: me(), text: `@${v.assignee} новая задача: ${v.title}${v.note ? '\n' + v.note : ''}${v.due ? '\nСрок: ' + fmtDate(v.due) : ''}`, mentions: [v.assignee] });
        await run(p.slug, { type: 'chat', message: msg }, `Задача для ${v.assignee} в чате`);
      }
      return ok;
    });
  };
  $('addTask').onclick = () => sheet('Новая задача', taskForm(null), v => saveTask(null, v), 'Создать');
  $('addDec').onclick = () => sheet('Решение', input('title', 'Что решили', '', 'required') + area('text', 'Почему, варианты, расчёт'),
    v => { if (!v.title) throw new Error('Опишите решение'); const item = { id: M.newId('k'), title: v.title, date: M.today(), author: me() }; if (v.text) item.text = v.text; return run(p.slug, { type: 'upsert', file: 'tasks.json', list: 'decisions', item }, `Решение: ${v.title}`); }, 'Записать');
  el.onclick = e => {
    const b = e.target.closest('[data-task]'); if (b) { const x = t.tasks.find(y => y.id === b.dataset.task); sheet('Задача', taskForm(x) + '<button type="button" class="btn danger" id="delT" style="width:100%">Удалить задачу</button>', v => saveTask(x, v), 'Сохранить'); $('delT').onclick = async () => { if (confirm('Удалить задачу?') && await run(p.slug, { type: 'remove', file: 'tasks.json', list: 'tasks', id: x.id }, `Удалена задача «${x.title}»`)) closeSheet(); }; return; }
    const d = e.target.closest('[data-dec]'); if (d) { const x = t.decisions.find(y => y.id === d.dataset.dec); sheet(fmtDate(x.date) + ' · ' + x.author, `<div class="card pad"><b>${esc(x.title)}</b><div class="body" style="margin-top:8px">${linkify(x.text || '')}</div></div>`); }
  };
}

// ---- Смета ----
function costTab(p, f, el) {
  const cost = f['cost.json'] || { items: [], overheadPct: 0, marginPct: 0 };
  const t = M.costTotals(cost);
  el.innerHTML = `
    <div class="card">
      ${M.COST_GROUPS.filter(g => t.groups[g]).map(g => `<div class="sum"><span>${g}</span><span class="num">${M.rub(t.groups[g])}</span></div>`).join('')}
      <div class="sum"><span>Прямые затраты</span><span class="num">${M.rub(t.direct)}</span></div>
      <div class="sum"><span>Накладные ${cost.overheadPct}%</span><span class="num">${M.rub(t.overhead)}</span></div>
      <div class="sum total"><span>Себестоимость</span><span class="num">${M.rub(t.total)}</span></div>
      <div class="sum"><span>Наценка ${cost.marginPct}%</span><span class="num">${M.rub(t.margin)}</span></div>
      <div class="sum price" style="padding-bottom:14px"><span>Цена без НДС</span><span class="num">${M.rub(t.price)}</span></div>
    </div>
    <div class="btns full" style="margin-top:8px"><button class="btn" id="pct">Изменить проценты</button><button class="btn" id="csv">Выгрузить CSV</button></div>
    ${M.COST_GROUPS.map(g => { const items = cost.items.filter(i => i.group === g); return items.length ? `<h2>${g}</h2><div class="card">${items.map(i => `<button class="row" data-item="${i.id}"><div class="grow"><div class="t">${esc(i.name)}</div><div class="s">${String(i.qty).replace('.', ',')} ${esc(i.unit)} × ${M.rub(M.kop(i.price))}${i.note ? ' · ' + esc(i.note) : ''}</div></div><span class="num">${M.rub(M.lineKop(i))}</span></button>`).join('')}</div>` : ''; }).join('')}
    ${cost.items.length ? '' : '<div class="card" style="margin-top:12px"><div class="empty">Смета пуста. Добавьте материалы, покупное, работы (нормо-часы).</div></div>'}
    <button class="add" id="addItem">Строка сметы</button>`;
  const itemForm = i => select('group', 'Раздел', M.COST_GROUPS, i?.group || 'Материалы') + input('name', 'Наименование', i?.name, 'required placeholder="Труба профильная 40×20×2"') +
    `<div class="two">${input('qty', 'Количество', i?.qty ?? '', 'inputmode="decimal" required')}${input('unit', 'Ед. изм.', i?.unit || 'шт', 'list="units"')}</div><datalist id="units"><option>шт<option>кг<option>т<option>м<option>м²<option>м³<option>л<option>ч<option>компл</datalist>` +
    input('price', 'Цена за единицу, ₽ без НДС', i?.price ?? '', 'inputmode="decimal" required') + input('note', 'Примечание / источник цены', i?.note);
  const num = (s, label) => { const n = Number(String(s).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < 0) throw new Error(label + ': введите число'); return n; };
  const saveItem = (i, v) => { if (!v.name) throw new Error('Укажите наименование'); const item = { id: i?.id || M.newId('c'), group: v.group, name: v.name, unit: v.unit || 'шт', qty: num(v.qty, 'Количество'), price: num(v.price, 'Цена'), note: v.note || null }; return run(p.slug, { type: 'upsert', file: 'cost.json', list: 'items', item }, `Смета: ${v.name}`); };
  $('addItem').onclick = () => sheet('Строка сметы', itemForm(null), v => saveItem(null, v), 'Добавить');
  $('pct').onclick = () => sheet('Накладные и наценка', input('overheadPct', 'Накладные расходы, %', cost.overheadPct, 'inputmode="decimal"') + input('marginPct', 'Наценка, %', cost.marginPct, 'inputmode="decimal"'),
    v => run(p.slug, { type: 'set', file: 'cost.json', fields: { overheadPct: num(v.overheadPct || 0, 'Накладные'), marginPct: num(v.marginPct || 0, 'Наценка') } }, 'Смета: проценты'));
  $('csv').onclick = () => {
    const rows = [['Раздел', 'Наименование', 'Кол-во', 'Ед.', 'Цена, ₽', 'Сумма, ₽', 'Примечание'], ...cost.items.map(i => [i.group, i.name, i.qty, i.unit, i.price, (M.lineKop(i) / 100).toFixed(2), i.note || '']), [], ['', 'Прямые затраты', '', '', '', (t.direct / 100).toFixed(2)], ['', `Накладные ${cost.overheadPct}%`, '', '', '', (t.overhead / 100).toFixed(2)], ['', 'Себестоимость', '', '', '', (t.total / 100).toFixed(2)], ['', `Наценка ${cost.marginPct}%`, '', '', '', (t.margin / 100).toFixed(2)], ['', 'Цена без НДС', '', '', '', (t.price / 100).toFixed(2)]];
    const csv = '﻿' + rows.map(r => r.map(x => { const s = String(x).replace('.', ','); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = M.safeFileName('smeta-' + p.slug + '.csv'); a.click();
  };
  el.onclick = e => { const b = e.target.closest('[data-item]'); if (!b) return; const i = cost.items.find(x => x.id === b.dataset.item); sheet('Строка сметы', itemForm(i) + '<button type="button" class="btn danger" id="delI" style="width:100%">Удалить строку</button>', v => saveItem(i, v), 'Сохранить'); $('delI').onclick = async () => { if (confirm('Удалить строку?') && await run(p.slug, { type: 'remove', file: 'cost.json', list: 'items', id: i.id }, `Смета: удалено «${i.name}»`)) closeSheet(); }; };
}

// ---- Источники ----
function sourcesTab(p, f, el) {
  const src = f['sources.json']?.sources || [];
  const photos = src.filter(s => s.file && IMG_EXT.includes(extOf(s.file.path)));
  const rest = src.filter(s => !photos.includes(s));
  el.innerHTML = `
    ${photos.length ? `<h2>Фото</h2><div class="card"><div class="grid">${photos.map(s => `<button data-open="${esc(s.file.path)}" data-name="${esc(s.file.name)}" data-thumb="${esc(s.file.path)}"><span>${esc(s.title)}</span></button>`).join('')}</div></div>` : ''}
    <h2>Модели, чертежи, ссылки</h2><div class="card">${rest.length ? rest.map(s => `<div class="row"><div class="grow"><div class="t">${esc(s.title)}</div>
      <div class="chips">${chip(s.type)}${chip(s.origin, whoClass(s.origin))}<span class="muted">${fmtDate(s.date)}</span></div>${s.note ? `<div class="s" style="margin-top:4px">${linkify(s.note)}</div>` : ''}
      <div class="btns" style="margin-top:6px">${s.file ? `<button class="btn small" data-open="${esc(s.file.path)}" data-name="${esc(s.file.name)}">📎 ${esc(s.file.name)} · ${fmtSize(s.file.size)}</button>` : ''}${s.url ? `<a class="btn small" href="${esc(s.url)}" target="_blank" rel="noopener">Открыть ссылку</a>` : ''}<button class="btn small" data-del="${s.id}">Удалить</button></div></div></div>`).join('') : '<div class="empty">Фото с объекта, 3D-модели, чертежи заказчика, ссылки и выдержки из чатов ИИ.</div>'}</div>
    <div class="btns full" style="margin-top:12px"><label class="btn primary">📷 Фото<input type="file" id="photo" accept="image/*" multiple hidden></label><button class="btn" id="addSrc">Модель / ссылка</button></div>`;
  for (const b of el.querySelectorAll('[data-thumb]')) {
    fileBytes(b.dataset.thumb).then(bytes => { b.style.backgroundImage = `url(${URL.createObjectURL(new Blob([bytes]))})`; }).catch(() => { b.style.backgroundImage = 'none'; });
  }
  el.onclick = async e => {
    const o = e.target.closest('[data-open]'); if (o) return openFile(o.dataset.open, o.dataset.name);
    const d = e.target.closest('[data-del]'); if (d) { const s = src.find(x => x.id === d.dataset.del); if (confirm(`Удалить источник «${s.title}»?`)) await run(p.slug, { type: 'remove', file: 'sources.json', list: 'sources', id: s.id }, `Удалён источник «${s.title}»`); }
  };
  $('photo').onchange = async e => {
    try {
      const list = [...e.target.files]; if (!list.length) return;
      const ops = [];
      for (const fl of list) { const id = M.newId('s'); const s = await stageFile(fl, 'sources', p.slug, id); ops.push({ item: { id, type: 'Фото', title: fl.name.replace(/\.[^.]+$/, ''), origin: me(), date: M.today(), file: s.ref }, uploads: s.uploads }); }
      for (const o of ops) await run(p.slug, { type: 'upsert', file: 'sources.json', list: 'sources', item: o.item, uploads: o.uploads }, `Фото «${o.item.title}»`);
    } catch (err) { toast(err.message, true); }
  };
  $('addSrc').onclick = () => sheet('Источник', select('type', 'Тип', M.SOURCE_TYPES.filter(x => x !== 'Фото'), '3D-модель') + input('title', 'Название', '', 'required') + field('Файл', '<input type="file" name="file">') + input('url', 'Ссылка', '', 'type="url" placeholder="https://"') + area('note', 'Примечание'),
    async (v, form) => {
      if (!v.title) throw new Error('Укажите название');
      const id = M.newId('s'), item = { id, type: v.type, title: v.title, origin: me(), date: M.today() }, uploads = [];
      if (v.url) item.url = v.url; if (v.note) item.note = v.note;
      const fl = form.get('file'); if (fl && fl.size) { const s = await stageFile(fl, 'sources', p.slug, id); item.file = s.ref; uploads.push(...s.uploads); }
      if (!item.file && !item.url && !item.note) throw new Error('Добавьте файл, ссылку или примечание');
      return run(p.slug, { type: 'upsert', file: 'sources.json', list: 'sources', item, uploads }, `Источник «${v.title}»`);
    }, 'Добавить');
}

// ---- Журнал ----
async function commitsList(el, path, slug) {
  if (S.offline || !S.client) { el.innerHTML = '<div class="card"><div class="empty">Журнал доступен при связи.</div></div>'; return; }
  el.innerHTML = '<div class="card"><div class="empty">Загрузка…</div></div>';
  try {
    const list = await S.client.commits(path, 40);
    el.innerHTML = `<div class="card">${list.map((c, i) => {
      const msg = c.commit.message.split('\n')[0], who = M.authorOf(msg, c.commit.author?.name || c.author?.login);
      return `<div class="row"><div class="grow"><div class="t" style="font-weight:500">${esc(msg.replace(/^\s*\[[^\]]+\]\s*/, ''))}</div><div class="chips">${chip(who, whoClass(who))}<span class="muted">${fmtTime(c.commit.author?.date)}</span></div></div>${slug && i ? `<button class="btn small" data-restore="${c.sha}">Вернуть</button>` : slug ? '<span class="muted">сейчас</span>' : ''}</div>`;
    }).join('') || '<div class="empty">Пусто</div>'}</div>${slug ? '<p class="muted" style="margin:10px 4px">«Вернуть» восстанавливает весь проект (данные и файлы) к состоянию после выбранной правки. Это тоже новая правка — её можно отменить так же.</p>' : ''}`;
    if (slug) el.onclick = e => { const b = e.target.closest('[data-restore]'); if (b) restoreProject(slug, b.dataset.restore); };
  } catch (e) { el.innerHTML = `<div class="errors">${esc(e.message)}</div>`; }
}
function logTab(p, f, el) { commitsList(el, `projects/${p.slug}`, p.slug); }
function logView(v) { setBar('Журнал', 'все правки во всех проектах'); commitsList(v, 'projects', null); }
async function restoreProject(slug, sha) {
  if (!confirm('Вернуть проект к этому состоянию? Более поздние изменения проекта будут отменены новой правкой.')) return;
  setBusy(true);
  try {
    const dir = `projects/${slug}/`;
    const old = (await S.client.treeAt(sha)).filter(e => e.path.startsWith(dir));
    if (!old.find(e => e.path === dir + 'project.json')) throw new Error('В этой правке проекта ещё не было');
    const done = await S.client.mutate(`[${me()}] Проект возвращён к состоянию ${sha.slice(0, 7)}`, ({ files }) => {
      const oldMap = new Map(old.map(e => [e.path, e.sha])), changes = [];
      for (const [path, e] of files) if (path.startsWith(dir) && !oldMap.has(path)) changes.push({ path, delete: true });
      for (const [path, s] of oldMap) if (files.get(path)?.sha !== s) changes.push({ path, sha: s });
      return changes;
    });
    toast(done ? 'Проект возвращён' : 'Проект уже в этом состоянии'); if (done) await load();
  } catch (e) { toast(e.message, true); } finally { setBusy(false); }
}

// ---------------- Предложения ИИ ----------------
function prAuthor(pr) { return M.authorOf(pr.title, pr.user?.login); }
function checkChip(c) { return { success: chip('✓ проверка пройдена', 'green'), failure: chip('✕ проверка не пройдена', 'red'), pending: chip('… идёт проверка', 'amber'), none: '', unknown: '' }[c] || ''; }
function prRow(pr) {
  const info = S.pullInfo.get(pr.number), who = prAuthor(pr);
  const names = (info?.slugs || []).map(s => S.projects.get(s)?.files['project.json']?.name || s);
  return `<a class="row" href="#/inbox/${pr.number}"><div class="grow"><div class="t">${esc(pr.title.replace(/^\s*\[[^\]]+\]\s*/, ''))}</div>
    <div class="chips">${chip(who, whoClass(who))}${names.map(n => chip(n)).join('')}${checkChip(info?.check)}<span class="muted">#${pr.number} · ${fmtTime(pr.created_at)}</span></div></div><span class="chev">›</span></a>`;
}
function inboxView(v) {
  setBar('Предложения', 'изменения от Claude и ChatGPT');
  if (S.offline) { v.innerHTML = '<div class="card"><div class="empty">Предложения доступны при связи.</div></div>'; return; }
  v.innerHTML = `<div class="card">${S.pulls.length ? S.pulls.map(prRow).join('') : '<div class="empty">Новых предложений нет. Когда Claude или ChatGPT предложат изменения, они появятся здесь — вы принимаете или отклоняете их одной кнопкой.</div>'}</div>
    <p class="muted" style="margin:10px 4px">ИИ не меняет основную версию сам: каждое изменение ждёт вашего решения. Принятое можно вернуть через «Журнал».</p>`;
}
async function pullView(n, v) {
  setBar('Предложение #' + n, '', '#/inbox');
  v.innerHTML = '<div class="card"><div class="empty">Загрузка…</div></div>';
  try {
    const pr = await S.client.pull(n);
    const files = S.pullInfo.get(n)?.sha === pr.head.sha ? S.pullInfo.get(n).files : await S.client.pullFiles(n);
    const check = await S.client.checks(pr.head.sha);
    const who = prAuthor(pr), open = pr.state === 'open' && !pr.merged;
    v.innerHTML = `
      <div class="card pad"><div class="t" style="font-weight:700;font-size:18px">${esc(pr.title.replace(/^\s*\[[^\]]+\]\s*/, ''))}</div>
        <div class="chips">${chip(who, whoClass(who))}${checkChip(check)}${pr.merged ? chip('принято', 'green') : pr.state === 'closed' ? chip('отклонено', 'red') : ''}${pr.mergeable === false ? chip('конфликт — нужно обновить', 'red') : ''}</div>
        ${pr.body ? `<div class="body" style="margin-top:12px">${linkify(pr.body)}</div>` : ''}</div>
      ${check === 'failure' ? '<div class="errors" style="margin-top:10px">Автоматическая проверка нашла ошибки в данных. Лучше отклонить с комментарием — ИИ исправит.</div>' : ''}
      ${open ? `<div class="btns full" style="margin-top:12px"><button class="btn gold" id="accept">Принять</button><button class="btn danger" id="reject">Отклонить</button></div><button class="btn" id="commentBtn" style="width:100%;margin-top:8px">Написать замечание</button>` : ''}
      <h2>Изменённые файлы (${files.length})</h2>
      ${files.map(fl => `<div class="card" style="margin-bottom:10px"><div class="row"><div class="grow"><div class="t" style="font-size:14px">${esc(fl.filename.replace(/^projects\/[^/]+\//, ''))}</div><div class="s">${{ added: 'новый', removed: 'удалён', modified: 'изменён', renamed: 'переименован' }[fl.status] || fl.status} · +${fl.additions} −${fl.deletions}</div></div></div>
        ${fl.patch ? `<div class="patch">${fl.patch.split('\n').slice(0, 400).map(l => `<div class="${l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : l.startsWith('@@') ? 'h' : ''}">${esc(l) || ' '}</div>`).join('')}</div>` : '<div class="pad muted">Двоичный файл или слишком большое изменение.</div>'}</div>`).join('')}`;
    if (!open) return;
    $('accept').onclick = async () => {
      if (check === 'failure' && !confirm('Проверка не пройдена. Всё равно принять?')) return;
      if (!confirm('Принять изменения в основную версию проекта?')) return;
      setBusy(true);
      try { await S.client.merge(n, pr.head.sha, `[${me()}] Принято предложение #${n} от ${who}: ${pr.title.replace(/^\s*\[[^\]]+\]\s*/, '')}`); toast('Принято'); S.head = null; await load(); location.hash = '#/inbox'; }
      catch (e) { toast(e.status === 405 || e.status === 409 ? 'Нельзя принять: предложение устарело или конфликтует. Напишите ИИ замечание «обнови по main».' : e.message, true); }
      finally { setBusy(false); }
    };
    $('reject').onclick = () => sheet('Отклонить предложение', area('reason', 'Почему (увидит ИИ)', '', 'placeholder="Например: дорого, замени трубу 40×40 на 40×20"'),
      async val => { await S.client.close(n, `[${me()}] Отклонено${val.reason ? ': ' + val.reason : ''}`); toast('Отклонено'); await loadPulls(); location.hash = '#/inbox'; }, 'Отклонить');
    $('commentBtn').onclick = () => sheet('Замечание', area('text', 'Текст для ИИ', '', 'required'),
      async val => { if (!val.text) throw new Error('Напишите замечание'); await S.client.comment(n, `[${me()}] ${val.text}`); toast('Замечание отправлено'); }, 'Отправить');
  } catch (e) { v.innerHTML = `<div class="errors">${esc(e.message)}</div>`; }
}

// ---------------- Настройки ----------------
async function settingsView(v) {
  setBar('Настройки', 'версия ' + VERSION);
  const st = S.settings, est = await C.usage();
  v.innerHTML = `
    ${st.token ? '' : `<div class="hero"><h1>ИГНИС ПРО</h1><div class="muted">Проекты, чат и файлы — вместе с Claude и ChatGPT. Данные хранятся в вашем закрытом репозитории GitHub, копия — на телефоне.</div></div>`}
    <h2>Подключение к хранилищу</h2>
    <form class="card pad" id="conn">
      <div class="two">${input('owner', 'Владелец', st.owner, 'autocapitalize="off" autocorrect="off"')}${input('repo', 'Репозиторий', st.repo, 'autocapitalize="off" autocorrect="off"')}</div>
      ${field('Токен GitHub', `<input name="token" type="password" value="${esc(st.token)}" autocomplete="off" placeholder="github_pat_…">`)}
      ${input('me', 'Ваше имя в чате', st.me)}
      ${input('claudeUrl', 'Рабочий чат Claude (ссылка)', st.claudeUrl, 'type="url" inputmode="url" autocapitalize="off" autocorrect="off" placeholder="https://claude.ai/chat/…"')}
      ${input('chatgptUrl', 'Рабочий чат ChatGPT (ссылка)', st.chatgptUrl, 'type="url" inputmode="url" autocapitalize="off" autocorrect="off" placeholder="https://chatgpt.com/c/…"')}
      <p class="note" style="margin:-4px 0 10px">Кнопки «Позвать» в чате проекта открывают эти чаты. Нужен адрес <b>самого рабочего чата</b>, не публичная ссылка «Поделиться» (<code>/share/</code> не подходит): откройте чат в Safari на claude.ai или chatgpt.com и скопируйте адрес из строки браузера — вида <code>claude.ai/chat/…</code> и <code>chatgpt.com/c/…</code>. Пусто — откроется новый чат, задание будет в буфере.</p>
      <div class="btns full"><button class="btn primary">Сохранить и проверить</button></div>
      <div id="connState" class="muted" style="margin-top:10px">${S.connMsg || ''}</div>
    </form>
    <details class="card pad" ${st.token ? '' : 'open'}><summary><b>Как получить токен (один раз)</b></summary>
      <ol class="steps">
        <li>На github.com: аватар → <b>Settings</b> → <b>Developer settings</b> → <b>Personal access tokens</b> → <b>Fine-grained tokens</b> → <b>Generate new token</b>.</li>
        <li>Срок — 1 год. <b>Repository access</b>: <i>Only select repositories</i> → <code>${esc(st.repo || DEFAULTS.repo)}</code>.</li>
        <li><b>Permissions</b>: Contents — <i>Read and write</i>; Pull requests — <i>Read and write</i>; Actions — <i>Read-only</i>.</li>
        <li>Скопируйте токен и вставьте выше. Он хранится только на этом телефоне.</li>
      </ol>
      <p class="note">Приложение с домашнего экрана и Safari хранят данные раздельно — вводите токен в том, которым пользуетесь.</p></details>
    <h2>На телефоне</h2>
    <div class="card">
      <div class="row"><div class="grow"><div class="t">Последняя синхронизация</div><div class="s">${S.syncedAt ? fmtTime(S.syncedAt) : '—'}${S.offline ? ' · нет связи' : ''}</div></div></div>
      <div class="row"><div class="grow"><div class="t">Не отправлено изменений</div><div class="s">${S.outbox.length ? S.outbox.map(o => esc(o.label) + (o.error ? ' — ⚠ ' + esc(o.error) : '')).join('<br>') : 'нет'}</div></div>${S.outbox.length ? '<button class="btn small" id="flush">Отправить</button>' : ''}</div>
      ${S.outbox.some(o => o.error) ? '<div class="row"><div class="grow s">Изменения с ошибкой не могут быть применены (например, запись удалена кем-то другим).</div><button class="btn small danger" id="dropBad">Удалить ошибочные</button></div>' : ''}
      <div class="row"><div class="grow"><div class="t">Копия всех проектов</div><div class="s">${esc(offlineSummary())}</div></div></div>
      <div class="row"><div class="grow"><div class="t">Приложение без связи</div><div class="s">${'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'сохранено на телефоне — откроется и без сайта' : 'сохраняется… откройте приложение ещё раз при связи') : 'браузер не поддерживает'}</div></div></div>
      <div class="btns full" style="padding:10px 14px"><button class="btn" id="cacheAll">Сохранить все проекты на телефон</button><button class="btn" id="zipAll">Скачать весь архив (ZIP)</button></div>
      <div class="row"><div class="grow"><div class="t">Занято браузером</div><div class="s">${est ? fmtSize(est.usage || 0) + (est.quota ? ' из доступных ~' + fmtSize(est.quota) : '') : 'нет данных'}</div></div></div>
    </div>
    <h2>Прежний архив R08</h2>
    <div class="card">
      <a class="row" href="#/migrate"><div class="grow"><div class="t">Перенести проекты из архива телефона</div><div class="s">Проекты, документы, редакции и файлы R08 → в общий репозиторий</div></div><span class="chev">›</span></a>
      <a class="row" href="./local.html"><div class="grow"><div class="t">Открыть архив R08</div><div class="s">Локальная копия на этом телефоне остаётся без изменений</div></div><span class="chev">›</span></a>
    </div>
    <p class="muted" style="text-align:center;margin-top:18px">ИГНИС ПРО ${VERSION} · Ресурсы · Решения · Результат</p>`;
  $('conn').onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData($('conn')));
    const first = !S.settings.token;
    if (!fd.owner.trim() || !fd.repo.trim()) { $('connState').innerHTML = '<span class="bad">Укажите владельца и репозиторий.</span>'; return; }
    for (const [k, a] of [['claudeUrl', AI.claude], ['chatgptUrl', AI.chatgpt]]) {
      fd[k] = (fd[k] || '').trim();
      if (fd[k] && !a.ok.test(fd[k])) { $('connState').innerHTML = `<span class="bad">Ссылка на чат ${a.name} должна начинаться с ${a.name === 'Claude' ? 'https://claude.ai/chat/… (адрес чата, не /share/)' : 'https://chatgpt.com/c/… (адрес чата, не /share/)'}</span>`; return; }
    }
    if (!fd.token.trim()) { $('connState').innerHTML = '<span class="bad">Вставьте токен GitHub — без него приложение не видит проекты.</span>'; return; }
    const changed = fd.owner.trim() !== S.settings.owner || fd.repo.trim() !== S.settings.repo;
    Object.assign(S.settings, { owner: fd.owner.trim(), repo: fd.repo.trim(), token: fd.token.trim(), me: fd.me.trim() || 'Дмитрий', claudeUrl: fd.claudeUrl, chatgptUrl: fd.chatgptUrl });
    saveSettings(); makeClient();
    if (changed) { S.head = null; S.entries = new Map(); S.projects = new Map(); S.pulls = []; S.pullInfo.clear(); await C.del('kv', 'state').catch(() => {}); }
    const out = $('connState'); out.textContent = 'Проверяю…';
    const btn = e.submitter || $('conn').querySelector('button'); btn.disabled = true;
    try {
      const info = await S.client.repoInfo();
      const perm = info.permissions || {};
      S.connMsg = `<span class="ok">✓ Подключено: <b>${esc(info.full_name)}</b>${info.private ? ' (закрытый)' : ''}</span>${info.private ? '' : '<br><span class="bad">Репозиторий открытый — сделайте его закрытым (Settings → General → Danger Zone).</span>'}${perm.push === false ? '<br><span class="bad">У токена нет права записи.</span>' : ''}`;
      try { await S.client.head(); } catch (err) { if (err.status === 404 || err.status === 409) S.connMsg += '<br>Репозиторий пустой — Claude заполнит его структурой и правилами.'; }
      out.innerHTML = S.connMsg;
      if (first) location.hash = '#/';
      load();
    } catch (err) { S.connMsg = ''; out.innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
    finally { btn.disabled = false; }
  };
  $('flush') && ($('flush').onclick = () => flushOutbox());
  $('cacheAll').onclick = () => cacheAll();
  $('zipAll').onclick = () => zipAll();
  $('dropBad') && ($('dropBad').onclick = async () => { for (const o of S.outbox.filter(x => x.error)) await C.del('outbox', o.seq); S.outbox = await C.all('outbox'); banner(); route(); });
}

// ---------------- Перенос из R08 ----------------
async function migrateView(v) {
  setBar('Перенос из R08', 'архив этого телефона → общий репозиторий', '#/settings');
  v.innerHTML = '<div class="card"><div class="empty">Читаю архив R08 на телефоне…</div></div>';
  if (S.offline || !S.client) { v.innerHTML = '<div class="card"><div class="empty">Перенос возможен только при связи с GitHub.</div></div>'; return; }
  let store, snap;
  try { store = await import('../store.js?v=0.8.0'); await store.init(); snap = await store.readSnapshot(); }
  catch (e) { v.innerHTML = `<div class="card"><div class="empty">Архив R08 на этом телефоне не найден или пуст.<br><span class="muted">${esc(e.message)}</span></div></div>`; return; }
  const done = JSON.parse(localStorage.getItem('ignis-pro-migrated') || '{}');
  const existing = new Set([...S.projects.values()].map(p => p.files['project.json']?.name?.toLowerCase()));
  const rows = snap.projects.map(pr => {
    const docs = snap.documents.filter(d => d.projectId === pr.id), revs = snap.revisions.filter(r => docs.some(d => d.id === r.documentId));
    const size = revs.reduce((a, r) => a + (r.attachment?.size || 0), 0);
    return { pr, docs, revs, size, done: done[pr.id], dup: existing.has(pr.name.toLowerCase()) };
  });
  v.innerHTML = `<p class="muted" style="margin:0 4px 10px">Архив R08 остаётся на телефоне без изменений. Переносятся проекты, документы, редакции со статусами и файлы (до 50 МБ каждый).</p>
    <div class="card">${rows.length ? rows.map(r => `<label class="row"><input type="checkbox" data-mig="${esc(r.pr.id)}" ${r.done || r.dup ? '' : 'checked'} style="width:22px;height:22px"><div class="grow"><div class="t">${esc(r.pr.name)}</div><div class="s">${plural(r.docs.length, 'документ', 'документа', 'документов')}, ${plural(r.revs.length, 'редакция', 'редакции', 'редакций')}, файлы ${fmtSize(r.size)}${r.done ? ' · уже перенесён' : r.dup ? ' · проект с таким именем уже есть' : ''}</div></div></label>`).join('') : '<div class="empty">В архиве R08 нет проектов.</div>'}</div>
    ${rows.length ? '<button class="btn primary" id="migGo" style="width:100%;margin-top:12px">Перенести выбранные</button><div id="migLog" class="muted" style="margin-top:10px"></div>' : ''}`;
  if (!rows.length) return;
  $('migGo').onclick = async () => {
    const chosen = rows.filter(r => v.querySelector(`[data-mig="${CSS.escape(r.pr.id)}"]`).checked);
    if (!chosen.length) return toast('Ничего не выбрано', true);
    $('migGo').disabled = true; const log = $('migLog'); const say = t => { log.innerHTML += esc(t) + '<br>'; };
    for (const r of chosen) {
      try {
        say(`«${r.pr.name}»: подготовка…`);
        const taken = new Set([...S.projects.keys()]); const slug = M.slugify(r.pr.name, taken);
        const files = M.emptyProject({ name: r.pr.name, author: me(), description: 'Перенесён из архива R08 ' + M.today() });
        const uploads = [], skipped = [];
        for (const d of r.docs) {
          const doc = { id: M.newId('d'), name: d.name, format: M.DOC_FORMATS.includes(d.format) ? d.format : 'Другое', revisions: [] };
          const seen = new Set();
          for (const rv of r.revs.filter(x => x.documentId === d.id)) {
            let rev = rv.revision; while (seen.has(rev.toLowerCase())) rev += '*'; seen.add(rev.toLowerCase());
            const item = { id: M.newId('r'), rev, status: M.REV_STATUSES.includes(rv.status) ? rv.status : 'Не проверено', date: (rv.createdAt || '').slice(0, 10) || M.today(), author: me() };
            if (rv.attachment) {
              if (rv.attachment.size > M.MAX_FILE_BYTES) { skipped.push(rv.attachment.name); item.note = `Файл ${rv.attachment.name} (${fmtSize(rv.attachment.size)}) больше 50 МБ — остался в архиве R08`; }
              else {
                const att = await store.getAttachment(rv.id);
                const key = M.newId('u'); await C.put('uploads', key, await att.blob.arrayBuffer());
                const path = `projects/${slug}/files/docs/${item.id}-${M.safeFileName(att.name)}`;
                item.file = { path, name: att.name, size: att.size, sha256: att.sha256 };
                uploads.push({ path, key });
              }
            }
            doc.revisions.push(item);
          }
          // одна отметка «Разрешено к выдаче»
          let seenApproved = false; for (const x of doc.revisions.slice().reverse()) if (x.status === M.APPROVED) { if (seenApproved) x.status = 'Архив'; seenApproved = true; }
          files['documents.json'].documents.push(doc);
        }
        say(`«${r.pr.name}»: отправка ${plural(uploads.length, 'файла', 'файлов', 'файлов')}…`);
        const ok = await run(slug, { type: 'create', files, uploads }, `Перенос из R08: «${r.pr.name}»`);
        if (ok) { done[r.pr.id] = slug; localStorage.setItem('ignis-pro-migrated', JSON.stringify(done)); say(`✓ «${r.pr.name}» перенесён${skipped.length ? `, не перенесено (больше 50 МБ): ${skipped.join(', ')}` : ''}`); }
        else say(`✕ «${r.pr.name}» не перенесён`);
      } catch (e) { say(`✕ «${r.pr.name}»: ${e.message}`); }
    }
    $('migGo').disabled = false;
  };
}

// ---------------- Запуск ----------------
// Значки панелей — линейные SVG (символы ✉ ⚙ на iPhone превращаются в цветные эмодзи).
const ICONS = {
  projects: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  inbox: '<path d="M3.5 13.5 6 6a2 2 0 0 1 1.9-1.5h8.2A2 2 0 0 1 18 6l2.5 7.5V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13.5h4.5l1.5 2.5h5l1.5-2.5h4.5"/>',
  log: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  sync: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
for (const a of document.querySelectorAll('.tabbar [data-nav]')) { const ti = a.querySelector('.ti'); if (ti && ICONS[a.dataset.nav]) ti.innerHTML = svg(a.dataset.nav); }
$('back').innerHTML = svg('back'); $('sync').innerHTML = svg('sync');
makeClient();
route();
if (S.client) load();
document.body.dataset.ready = 'true';
C.get('kv', 'offlineAll').then(v => { if (v) S.offlineAll = v; }).catch(() => {});
// Запуск без связи: приложение сохраняется на телефоне (r05/sw.js) и открывается,
// даже если сайт GitHub Pages недоступен.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // Путь относительно страницы r05/ (index.html): r05/sw.js, область — r05/.
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
