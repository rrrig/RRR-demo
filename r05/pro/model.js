// ИГНИС ПРО — общая модель данных проекта (приложение, Claude, ChatGPT).
// Один и тот же файл используется приложением и проверкой в репозитории данных.

export const SCHEMA = 1;
export const PROJECT_FILES = Object.freeze(['project.json', 'documents.json', 'tasks.json', 'sources.json', 'cost.json']);
export const PROJECT_STATUSES = Object.freeze(['Идея', 'В работе', 'Пауза', 'Сдан', 'Архив']);
export const DOC_FORMATS = Object.freeze(['PDF', 'DWG', 'DXF', 'STEP', 'SLDPRT', 'STL', 'XLSX', 'Фото', 'Другое']);
export const REV_STATUSES = Object.freeze(['Не проверено', 'На проверке', 'Разрешено к выдаче', 'Архив']);
export const APPROVED = 'Разрешено к выдаче';
export const TASK_STATUSES = Object.freeze(['Открыта', 'В работе', 'Готово']);
export const SOURCE_TYPES = Object.freeze(['Фото', '3D-модель', 'Чертёж', 'Расчёт', 'Ссылка', 'Чат ИИ', 'Прочее']);
export const COST_GROUPS = Object.freeze(['Материалы', 'Покупное', 'Работы', 'Прочее']);
export const AUTHORS = Object.freeze(['Дмитрий', 'Claude', 'ChatGPT']);
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
// Большие файлы (больше MAX_FILE_BYTES) хранятся частями по PART_BYTES: <путь>.part001, .part002, …
// В file указываются размер и sha256 целого файла и список частей (parts) с размером и sha256 каждой.
export const PART_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_PARTS = 200;
export const partPath = (path, i) => `${path}.part${String(i + 1).padStart(3, '0')}`;
const PART_RE = /\.part(\d{3})$/;
// Путь части → путь целого файла (или null, если это не часть).
export const partOf = path => (PART_RE.test(path || '') ? path.replace(PART_RE, '') : null);
// Манифест большого файла лежит рядом с частями: <путь>.parts.json = { schema, path, name, size, sha256, parts }.
// По нему файл собирается и проверяется везде (приложение, проверка, компьютер) — без угадывания частей.
export const MANIFEST_EXT = '.parts.json';
export const manifestPath = path => path + MANIFEST_EXT;
export const manifestOf = path => (typeof path === 'string' && path.endsWith(MANIFEST_EXT) ? path.slice(0, -MANIFEST_EXT.length) : null);
// Часть или манифест → путь целого файла; иначе null.
export const wholeOf = path => partOf(path) || manifestOf(path);
// Запись «file» большого файла в виде манифеста (и обратно — те же поля).
export const toManifest = f => ({ schema: SCHEMA, path: f.path, name: f.name, size: f.size, sha256: f.sha256, parts: f.parts.map(p => ({ path: p.path, size: p.size, sha256: p.sha256 })) });
export const sameManifest = (a, b) => JSON.stringify(toManifest(a)) === JSON.stringify(toManifest(b));
export const fileParts = f => (f && Array.isArray(f.parts) && f.parts.length ? f.parts : null);
export const FILE_KINDS = Object.freeze(['docs', 'sources', 'chat', 'work']);

const ID = /^[a-z]-[a-z0-9]{6,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
export function validDate(v) {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
// Файлы проекта: projects/<папка>/files/<docs|sources|chat|work>/<имя> — без подпапок и «..».
export function validFilePath(path, folder) {
  const m = /^projects\/([a-z0-9][a-z0-9-]{0,60})\/files\/(docs|sources|chat|work)\/([^/]{1,200})$/.exec(path || '');
  return !!m && (!folder || m[1] === folder) && m[3] !== '.' && m[3] !== '..';
}

export function newId(prefix) {
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  return prefix + '-' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export const today = () => new Date().toISOString().slice(0, 10);

const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
export function translit(s) {
  return String(s).toLowerCase().split('').map(c => TR[c] ?? c).join('');
}
export function slugify(name, taken = new Set()) {
  let base = translit(name).replace(/ø/g, 'd').replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'proekt';
  let slug = base, n = 2;
  while (taken.has(slug)) slug = base + '-' + n++;
  return slug;
}
export function safeFileName(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : '';
  const stem = translit(dot > 0 ? name.slice(0, dot) : name).replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
  return ext ? stem + '.' + ext : stem;
}

// ---------- Пустые файлы проекта ----------
export function emptyProject({ id = newId('p'), name, customer = '', description = '', author = 'Дмитрий' }) {
  const d = today();
  return {
    'project.json': { schema: SCHEMA, id, name, status: 'В работе', customer, description, created: d, updated: d, author },
    'documents.json': { schema: SCHEMA, documents: [] },
    'tasks.json': { schema: SCHEMA, tasks: [], decisions: [] },
    'sources.json': { schema: SCHEMA, sources: [] },
    'cost.json': { schema: SCHEMA, currency: 'RUB', overheadPct: 0, marginPct: 0, items: [] },
  };
}

// ---------- Проверка ----------
function checker(file) {
  const errors = [];
  const err = (where, msg) => errors.push(file + (where ? ' › ' + where : '') + ': ' + msg);
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  const text = (o, k, where, { required = true, max = 2000 } = {}) => {
    const v = o[k];
    if (v === undefined || v === '') { if (required) err(where, `поле «${k}» обязательно`); return; }
    if (typeof v !== 'string' || v.length > max) err(where, `поле «${k}» должно быть строкой до ${max} символов`);
  };
  const oneOf = (o, k, list, where) => { if (!list.includes(o[k])) err(where, `«${k}» = ${JSON.stringify(o[k])}, допустимо: ${list.join(', ')}`); };
  const date = (o, k, where, required = true) => {
    if (o[k] === undefined || o[k] === '') { if (required) err(where, `поле «${k}» обязательно`); return; }
    if (!validDate(o[k])) err(where, `«${k}» должно быть существующей датой ГГГГ-ММ-ДД`);
  };
  const ids = new Set();
  const id = (o, prefix, where) => {
    if (typeof o.id !== 'string' || !ID.test(o.id) || o.id[0] !== prefix) err(where, `неверный id ${JSON.stringify(o.id)} (ожидается ${prefix}-xxxxxx)`);
    else if (ids.has(o.id)) err(where, `повтор id ${o.id}`);
    else ids.add(o.id);
  };
  const num = (o, k, where, { min = 0, max = 1e12, required = true } = {}) => {
    if (o[k] === undefined && !required) return;
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k]) || o[k] < min || o[k] > max) err(where, `«${k}» должно быть числом от ${min} до ${max}`);
  };
  const fileRef = (f, where) => {
    if (f === undefined || f === null) return;
    if (!isObj(f)) return err(where, 'file должен быть объектом');
    text(f, 'path', where, { max: 300 });
    text(f, 'name', where, { max: 300 });
    const HEX = /^[0-9a-f]{64}$/;
    if (f.parts === undefined) {
      num(f, 'size', where, { max: MAX_FILE_BYTES });
      if (f.sha256 !== undefined && !HEX.test(f.sha256)) err(where, 'sha256 должен быть 64 hex-символа');
      return;
    }
    // Файл из частей
    num(f, 'size', where, { min: MAX_FILE_BYTES + 1, max: MAX_TOTAL_BYTES });
    if (!HEX.test(f.sha256 || '')) err(where, 'у файла из частей обязателен sha256 целого файла (64 hex-символа)');
    if (!Array.isArray(f.parts) || f.parts.length < 2 || f.parts.length > MAX_PARTS) return err(where, `parts — список из 2…${MAX_PARTS} частей`);
    let sum = 0;
    f.parts.forEach((pt, i) => {
      const wp = `${where}, часть ${i + 1}`;
      if (!isObj(pt)) return err(wp, 'ожидается объект');
      if (typeof f.path === 'string' && pt.path !== partPath(f.path, i)) err(wp, `путь должен быть «${partPath(f.path, i)}»`);
      const last = i === f.parts.length - 1;
      if (last) num(pt, 'size', wp, { min: 1, max: PART_BYTES });
      else if (pt.size !== PART_BYTES) err(wp, `размер каждой части, кроме последней, — ${PART_BYTES} байт`);
      if (!HEX.test(pt.sha256 || '')) err(wp, 'sha256 части обязателен (64 hex-символа)');
      if (typeof pt.size === 'number') sum += pt.size;
    });
    if (typeof f.size === 'number' && sum !== f.size) err(where, `сумма частей ${sum} байт не равна size ${f.size}`);
  };
  const arr = (o, k, where) => { if (!Array.isArray(o[k])) { err(where, `«${k}» должно быть списком`); return []; } return o[k]; };
  return { errors, err, isObj, text, oneOf, date, id, num, fileRef, arr };
}

export function validateFile(name, data, folder = '') {
  const c = checker(name);
  if (!c.isObj(data)) { c.err('', 'ожидается JSON-объект'); return c.errors; }
  if (data.schema !== SCHEMA) c.err('', `schema должна быть ${SCHEMA}`);
  const filePrefix = folder ? `projects/${folder}/files/` : null;
  const ownFile = (f, where) => { c.fileRef(f, where); if (f && filePrefix && typeof f.path === 'string' && !validFilePath(f.path, folder)) c.err(where, `файл должен лежать в ${filePrefix}<docs|sources|chat|work>/`); };
  switch (name) {
    case 'project.json':
      c.id(data, 'p', '');
      c.text(data, 'name', '', { max: 200 });
      c.oneOf(data, 'status', PROJECT_STATUSES, '');
      c.text(data, 'customer', '', { required: false, max: 300 });
      c.text(data, 'description', '', { required: false, max: 20000 });
      c.date(data, 'created', ''); c.date(data, 'updated', '');
      c.text(data, 'author', '', { required: false, max: 100 });
      break;
    case 'documents.json':
      c.arr(data, 'documents', '').forEach((d, i) => {
        const w = `документ ${i + 1}`;
        if (!c.isObj(d)) return c.err(w, 'ожидается объект');
        c.id(d, 'd', w); c.text(d, 'name', w, { max: 300 }); c.oneOf(d, 'format', DOC_FORMATS, w);
        const revs = new Set(); let approved = 0;
        c.arr(d, 'revisions', w).forEach((r, j) => {
          const wr = `${w} «${d.name}», редакция ${j + 1}`;
          if (!c.isObj(r)) return c.err(wr, 'ожидается объект');
          c.id(r, 'r', wr); c.text(r, 'rev', wr, { max: 40 }); c.oneOf(r, 'status', REV_STATUSES, wr);
          c.date(r, 'date', wr); c.text(r, 'author', wr, { max: 100 }); c.text(r, 'note', wr, { required: false, max: 5000 });
          ownFile(r.file, wr);
          if (typeof r.rev === 'string') { const k = r.rev.trim().toLowerCase(); if (revs.has(k)) c.err(wr, `повтор редакции ${r.rev}`); revs.add(k); }
          if (r.status === APPROVED) approved++;
        });
        if (approved > 1) c.err(w, `«${APPROVED}» может быть только у одной редакции`);
      });
      break;
    case 'tasks.json':
      c.arr(data, 'tasks', '').forEach((t, i) => {
        const w = `задача ${i + 1}`;
        if (!c.isObj(t)) return c.err(w, 'ожидается объект');
        c.id(t, 't', w); c.text(t, 'title', w, { max: 500 }); c.text(t, 'assignee', w, { max: 100 });
        c.oneOf(t, 'status', TASK_STATUSES, w); c.date(t, 'created', w); c.date(t, 'due', w, false);
        c.text(t, 'author', w, { max: 100 }); c.text(t, 'note', w, { required: false, max: 10000 });
      });
      c.arr(data, 'decisions', '').forEach((d, i) => {
        const w = `решение ${i + 1}`;
        if (!c.isObj(d)) return c.err(w, 'ожидается объект');
        c.id(d, 'k', w); c.text(d, 'title', w, { max: 500 }); c.text(d, 'text', w, { required: false, max: 20000 });
        c.date(d, 'date', w); c.text(d, 'author', w, { max: 100 });
      });
      break;
    case 'sources.json':
      c.arr(data, 'sources', '').forEach((s, i) => {
        const w = `источник ${i + 1}`;
        if (!c.isObj(s)) return c.err(w, 'ожидается объект');
        c.id(s, 's', w); c.oneOf(s, 'type', SOURCE_TYPES, w); c.text(s, 'title', w, { max: 300 });
        c.text(s, 'origin', w, { max: 100 }); c.date(s, 'date', w); c.text(s, 'note', w, { required: false, max: 10000 });
        c.text(s, 'url', w, { required: false, max: 2000 });
        if (typeof s.url === 'string' && s.url && !/^https?:\/\//.test(s.url)) c.err(w, 'url должен начинаться с http:// или https://');
        ownFile(s.file, w);
        if (!s.file && !s.url && !s.note) c.err(w, 'нужен файл, ссылка или примечание');
      });
      break;
    case 'cost.json':
      if (data.currency !== 'RUB') c.err('', 'currency должна быть RUB');
      c.num(data, 'overheadPct', '', { max: 1000 }); c.num(data, 'marginPct', '', { max: 1000 });
      c.arr(data, 'items', '').forEach((it, i) => {
        const w = `строка ${i + 1}`;
        if (!c.isObj(it)) return c.err(w, 'ожидается объект');
        c.id(it, 'c', w); c.oneOf(it, 'group', COST_GROUPS, w); c.text(it, 'name', w, { max: 300 });
        c.text(it, 'unit', w, { max: 20 }); c.num(it, 'qty', w); c.num(it, 'price', w);
        c.text(it, 'note', w, { required: false, max: 2000 });
      });
      break;
    default: c.err('', 'неизвестный файл');
  }
  return c.errors;
}

export function validateProject(folder, files) {
  const errors = [];
  if (!SLUG.test(folder)) errors.push(`папка «${folder}»: только латиница в нижнем регистре, цифры и дефис`);
  for (const f of PROJECT_FILES) {
    if (files[f] === undefined) errors.push(`${f}: файл отсутствует`);
    else if (files[f] instanceof Error) errors.push(`${f}: ${files[f].message}`);
    else errors.push(...validateFile(f, files[f], folder));
  }
  return errors;
}

// ---------- Чат проекта ----------
// Каждое сообщение — отдельный файл projects/<папка>/chat/<время>-<автор>-<id>.json.
// Файлы только добавляются, поэтому одновременные сообщения трёх участников не конфликтуют.
export const CHAT_DIR = 'chat';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export function chatFileName(msg) {
  const t = msg.date.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const who = translit(msg.author).replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'user';
  return `${t}-${who}-${msg.id}.json`;
}
export function newChatMessage({ author, text, files = [], mentions = [], replyTo }) {
  const m = { schema: SCHEMA, id: newId('m'), author, date: new Date().toISOString(), text };
  if (files.length) m.files = files;
  if (mentions.length) m.mentions = mentions;
  if (replyTo) m.replyTo = replyTo;
  return m;
}
export function mentionsIn(text) {
  const out = [];
  if (/@claude|@клод/i.test(text)) out.push('Claude');
  if (/@chatgpt|@gpt|@чатгпт|@джипити/i.test(text)) out.push('ChatGPT');
  if (/@все|@all/i.test(text)) { for (const a of ['Claude', 'ChatGPT']) if (!out.includes(a)) out.push(a); }
  return out;
}
export function validateChatMessage(m, folder = '') {
  const c = checker('chat');
  if (!c.isObj(m)) { c.err('', 'ожидается JSON-объект'); return c.errors; }
  if (m.schema !== SCHEMA) c.err('', `schema должна быть ${SCHEMA}`);
  c.id(m, 'm', '');
  c.text(m, 'author', '', { max: 100 });
  c.text(m, 'text', '', { required: !(m.files && m.files.length), max: 20000 });
  if (typeof m.date !== 'string' || !ISO.test(m.date) || !validDate(m.date.slice(0, 10)) || Number.isNaN(Date.parse(m.date))) c.err('', 'date должна быть временем ISO в UTC, например 2026-11-09T10:15:00Z');
  if (m.files !== undefined) {
    if (!Array.isArray(m.files) || m.files.length > 20) c.err('', 'files: список до 20 файлов');
    else m.files.forEach((f, i) => { c.fileRef(f, 'файл ' + (i + 1)); if (folder && f && typeof f.path === 'string' && !validFilePath(f.path, folder)) c.err('файл ' + (i + 1), `файл должен лежать в projects/${folder}/files/<docs|sources|chat|work>/`); });
  }
  if (m.mentions !== undefined && (!Array.isArray(m.mentions) || m.mentions.some(x => typeof x !== 'string'))) c.err('', 'mentions: список имён');
  if (m.replyTo !== undefined && (typeof m.replyTo !== 'string' || !ID.test(m.replyTo))) c.err('', 'replyTo: id сообщения');
  return c.errors;
}

// Запрет для ИИ: менять отметку «Разрешено к выдаче» может только пользователь.
export function approvalChanges(before, after) {
  const map = d => new Map((d?.documents || []).flatMap(doc => (doc.revisions || []).map(r => [r.id, r.status === APPROVED])));
  const a = map(before), b = map(after), out = [];
  for (const [id, v] of b) if (v !== (a.get(id) || false)) out.push(id);
  for (const [id, v] of a) if (v && !b.has(id)) out.push(id);
  return out;
}

// ---------- Себестоимость (в копейках, без ошибок округления) ----------
export const kop = x => Math.round(Number((x * 100).toPrecision(15)));
export function lineKop(it) { return Math.round(Number((it.qty * it.price * 100).toPrecision(12))); }
export function costTotals(cost) {
  const groups = Object.fromEntries(COST_GROUPS.map(g => [g, 0]));
  for (const it of cost.items || []) groups[it.group] = (groups[it.group] || 0) + lineKop(it);
  const direct = Object.values(groups).reduce((a, b) => a + b, 0);
  const overhead = Math.round(direct * (cost.overheadPct || 0) / 100);
  const total = direct + overhead;
  const margin = Math.round(total * (cost.marginPct || 0) / 100);
  return { groups, direct, overhead, total, margin, price: total + margin };
}
export function rub(k) {
  const neg = k < 0; k = Math.abs(k);
  const r = Math.floor(k / 100), c = k % 100;
  return (neg ? '−' : '') + String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + String(c).padStart(2, '0') + ' ₽';
}

// ---------- Автор правки по сообщению коммита ----------
export function authorOf(message, fallback = '') {
  const m = /^\s*\[([^\]]{1,40})\]/.exec(message || '');
  if (m) return m[1];
  if (/claude/i.test(fallback)) return 'Claude';
  if (/chatgpt|openai|codex/i.test(fallback)) return 'ChatGPT';
  return fallback || 'Неизвестно';
}

// Проверка манифеста <path>.parts.json большого файла.
export function validateManifest(data, path) {
  const c = checker(path ? path.split('/').pop() + MANIFEST_EXT : 'манифест');
  if (!c.isObj(data)) { c.err('', 'ожидается JSON-объект'); return c.errors; }
  if (data.schema !== SCHEMA) c.err('', `schema должна быть ${SCHEMA}`);
  if (path && data.path !== path) c.err('', `path должен быть «${path}»`);
  if (!Array.isArray(data.parts)) c.err('', 'нет списка частей parts');
  else c.fileRef(data, '');
  return c.errors;
}
