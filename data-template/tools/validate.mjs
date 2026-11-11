#!/usr/bin/env node
// Проверка репозитория данных ИГНИС ПРО.
// Использование: node tools/validate.mjs [--base <папка>]
//   Проекты ищутся в ./projects относительно текущей папки (process.cwd()).
//   --base <папка> — checkout базовой ветки: запрещает менять отметку «Разрешено к выдаче»
//   и изменять или удалять уже существующие сообщения чата.
// Node >= 20, без зависимостей.

import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import {
  PROJECT_FILES, APPROVED, MAX_FILE_BYTES, FILE_KINDS, CHAT_DIR,
  validateProject, validateChatMessage, chatFileName, validFilePath, approvalChanges, fileParts,
  manifestPath, manifestOf, partOf, validateManifest, sameManifest,
} from './model.js';

const args = process.argv.slice(2);
let baseDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base') {
    baseDir = args[++i];
    if (!baseDir) { console.error('Ошибка: после --base нужно указать папку'); process.exit(2); }
  } else if (args[i] === '-h' || args[i] === '--help') {
    console.log('Использование: node tools/validate.mjs [--base <папка с базовой веткой>]');
    process.exit(0);
  } else { console.error(`Неизвестный аргумент: ${args[i]}`); process.exit(2); }
}

const root = process.cwd();
const projectsDir = path.join(root, 'projects');
const errors = [];
const add = (where, msg) => errors.push(`${where}: ${msg}`);
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const IGNORED = new Set(['.DS_Store', '.gitkeep']);

async function exists(p) { try { return await stat(p); } catch { return null; } }

function parseJson(raw) {
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try { return JSON.parse(raw); } catch (e) {
    let msg = e.message;
    const m = /position (\d+)/.exec(msg);
    if (m) {
      const pos = +m[1], before = raw.slice(0, pos);
      msg = `строка ${before.split('\n').length}, столбец ${pos - before.lastIndexOf('\n')}: ${msg}`;
    }
    return new Error(`ошибка JSON — ${msg}`);
  }
}

async function readJson(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    return new Error(`не удалось прочитать файл (${e.code || e.message})`);
  }
  return parseJson(raw);
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

async function listDir(dir) {
  try { return (await readdir(dir, { withFileTypes: true })).filter(e => !IGNORED.has(e.name)); }
  catch { return []; }
}

const ok = x => x && !(x instanceof Error);

// Ссылки на файлы: { where, f, kind (обязательная папка или null), owner (id, с которого начинается имя, или null) }
function projectFileRefs(files) {
  const out = [];
  const docs = files['documents.json'];
  if (ok(docs) && Array.isArray(docs.documents)) {
    docs.documents.forEach((d, i) => (Array.isArray(d?.revisions) ? d.revisions : []).forEach((r, j) => {
      if (r?.file && typeof r.file === 'object') out.push({ where: `documents.json › документ ${i + 1}, редакция ${j + 1}`, f: r.file, kind: 'docs', owner: r.id });
    }));
  }
  const src = files['sources.json'];
  if (ok(src) && Array.isArray(src.sources)) {
    src.sources.forEach((s, i) => {
      if (s?.file && typeof s.file === 'object') out.push({ where: `sources.json › источник ${i + 1}`, f: s.file, kind: 'sources', owner: s.id });
    });
  }
  return out;
}

async function checkRef(folder, { where, f, kind, owner }, referenced) {
  if (typeof f.path !== 'string') return; // ошибку уже сообщила модель
  if (!validFilePath(f.path, folder)) { add(where, `путь «${f.path}» должен иметь вид projects/${folder}/files/<${FILE_KINDS.join('|')}>/<имя>`); return; }
  const [, , , k, name] = f.path.split('/');
  if (kind && k !== kind) { add(where, `файл «${f.path}» должен лежать в projects/${folder}/files/${kind}/`); return; }
  if (owner && (k === 'docs' || k === 'sources' || k === 'chat') && kind && !name.startsWith(owner + '-')) {
    add(where, `имя файла «${name}» должно начинаться с «${owner}-»`);
  }
  const parts = fileParts(f);
  if (parts) {
    // Запись в JSON должна совпадать с манифестом рядом с частями.
    const mp = manifestPath(f.path);
    referenced.add(mp);
    const m = await readJson(path.join(root, mp));
    if (m === undefined) add(where, `нет манифеста «${mp}» (создаётся tools/split-file.mjs)`);
    else if (m instanceof Error) add(where, `манифест «${mp}»: ${m.message}`);
    else if (!sameManifest(m, f)) add(where, `запись file не совпадает с манифестом «${mp}»`);
    await checkParts(where, f, parts, referenced);
    return;
  }
  referenced.add(f.path);
  const abs = path.join(root, f.path);
  const st = await exists(abs);
  if (!st || !st.isFile()) { add(where, `файл «${f.path}» не найден в репозитории`); return; }
  if (typeof f.size === 'number' && f.size !== st.size) add(where, `размер «${f.path}»: указано ${f.size}, на диске ${st.size} байт`);
  if (typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)) {
    const h = await sha256(abs);
    if (h !== f.sha256) add(where, `sha256 «${f.path}» не совпадает (в файле ${h})`);
  }
}

// Большой файл частями: целого файла в репозитории нет; каждая часть — отдельный файл
// (размер и sha256 сверяются), а sha256 всех частей подряд должен совпасть с sha256 целого файла.
async function checkParts(where, f, parts, referenced) {
  if (await exists(path.join(root, f.path))) add(where, `«${f.path}» хранится частями — целого файла с этим именем быть не должно`);
  const whole = createHash('sha256');
  let complete = true;
  for (const [i, pt] of parts.entries()) {
    if (!pt || typeof pt.path !== 'string') { complete = false; continue; }
    const wp = `${where}, часть ${i + 1}`;
    referenced.add(pt.path);
    const abs = path.join(root, pt.path);
    const st = await exists(abs);
    if (!st || !st.isFile()) { add(wp, `файл «${pt.path}» не найден в репозитории`); complete = false; continue; }
    if (pt.size !== st.size) add(wp, `размер «${pt.path}»: указано ${pt.size}, на диске ${st.size} байт`);
    const h = createHash('sha256');
    for await (const chunk of createReadStream(abs)) { h.update(chunk); whole.update(chunk); }
    const got = h.digest('hex');
    if (got !== pt.sha256) add(wp, `sha256 «${pt.path}» не совпадает (в файле ${got})`);
  }
  if (complete && typeof f.sha256 === 'string') {
    const got = whole.digest('hex');
    if (got !== f.sha256) add(where, `sha256 собранного файла «${f.path}» не совпадает (по частям ${got})`);
  }
}

async function checkChat(folder, dir, where, referenced) {
  const chatDir = path.join(dir, CHAT_DIR);
  const st = await exists(chatDir);
  if (!st) return;
  if (!st.isDirectory()) { add(where, `«${CHAT_DIR}» должен быть папкой`); return; }
  const ids = new Map();
  for (const e of (await listDir(chatDir)).sort((a, b) => a.name.localeCompare(b.name))) {
    const w = `${where}/${CHAT_DIR}/${e.name}`;
    if (!e.isFile() || !e.name.endsWith('.json')) { add(w, 'в папке chat/ допускаются только файлы сообщений *.json'); continue; }
    const msg = await readJson(path.join(chatDir, e.name));
    if (msg instanceof Error) { add(w, msg.message); continue; }
    const errs = validateChatMessage(msg, folder);
    for (const m of errs) add(w, m);
    if (!errs.length) {
      const expected = chatFileName(msg);
      if (expected !== e.name) add(w, `имя файла должно быть «${expected}» (по date, author и id сообщения)`);
    }
    if (ok(msg) && typeof msg.id === 'string') {
      if (ids.has(msg.id)) add(w, `повтор id сообщения ${msg.id} (уже в ${ids.get(msg.id)})`);
      else ids.set(msg.id, e.name);
    }
    if (ok(msg) && Array.isArray(msg.files)) {
      for (const [i, f] of msg.files.entries()) {
        if (!f || typeof f !== 'object') continue;
        // Вложение, загруженное в чат, лежит в files/chat/<id сообщения>-…; ссылки на docs/sources/work тоже допустимы.
        const inChat = typeof f.path === 'string' && f.path.startsWith(`projects/${folder}/files/chat/`);
        await checkRef(folder, { where: `${w} › файл ${i + 1}`, f, kind: inChat ? 'chat' : null, owner: inChat ? msg.id : null }, referenced);
      }
    }
  }
}

async function checkFilesDir(folder, dir, where, referenced) {
  const filesRoot = path.join(dir, 'files');
  const st = await exists(filesRoot);
  if (!st) return;
  if (!st.isDirectory()) { add(where, '«files» должен быть папкой'); return; }
  // Сначала манифесты больших файлов, на которые нет записи в JSON (рабочие файлы и т.п.):
  // проверяются сами по себе. Затем — части без манифеста.
  const kinds = (await listDir(filesRoot)).filter(k => k.isDirectory() && FILE_KINDS.includes(k.name));
  for (const k of kinds) for (const e of await listDir(path.join(filesRoot, k.name))) {
    const full = `projects/${folder}/files/${k.name}/${e.name}`, whole = manifestOf(full);
    if (!whole || referenced.has(full)) continue;
    referenced.add(full);
    const m = await readJson(path.join(root, full));
    const errs = m instanceof Error ? [m.message] : validateManifest(m, whole);
    if (errs.length) { for (const x of errs) add(`${where} › ${full}`, x); continue; }
    await checkParts(`${where} › ${full}`, m, m.parts, referenced);
  }
  for (const k of kinds) for (const e of await listDir(path.join(filesRoot, k.name))) {
    const full = `projects/${folder}/files/${k.name}/${e.name}`, whole = partOf(full);
    if (whole && !referenced.has(full)) add(where, `«${full}» — часть без манифеста «${manifestPath(whole)}» или не указана в нём`);
  }
  for (const k of await listDir(filesRoot)) {
    if (!k.isDirectory() || !FILE_KINDS.includes(k.name)) {
      add(where, `«files/${k.name}»: в files/ допускаются только папки ${FILE_KINDS.join(', ')}`);
      continue;
    }
    for (const e of await listDir(path.join(filesRoot, k.name))) {
      const full = `projects/${folder}/files/${k.name}/${e.name}`;
      if (!e.isFile()) { add(where, `«${full}»: подпапки в files/${k.name}/ не допускаются`); continue; }
      if (!SAFE_NAME.test(e.name)) add(where, `«${full}»: имя файла — только латиница в нижнем регистре, цифры, «.», «_», «-»`);
      const s = await exists(path.join(filesRoot, k.name, e.name));
      if (s && s.size > MAX_FILE_BYTES) add(where, `файл «${full}» больше 50 МБ (${s.size} байт)`);
      if (k.name !== 'work' && !referenced.has(full)) {
        console.warn(`Предупреждение: ${full} не упомянут ни в documents.json, sources.json, ни в сообщениях чата`);
      }
    }
  }
}

// Только добавление: файлы из base (chat/* и files/chat/*) должны остаться байт-в-байт.
async function checkAppendOnly(folder, where) {
  const baseProj = path.resolve(root, baseDir, 'projects', folder);
  for (const [rel, label] of [[CHAT_DIR, 'сообщение чата'], ['files/chat', 'вложение чата']]) {
    for (const e of await listDir(path.join(baseProj, rel))) {
      if (!e.isFile()) continue;
      const before = await readFile(path.join(baseProj, rel, e.name));
      let after = null;
      try { after = await readFile(path.join(projectsDir, folder, rel, e.name)); } catch { /* удалён */ }
      if (!after) add(where, `${label} «${rel}/${e.name}» удалено — в чат можно только добавлять`);
      else if (!before.equals(after)) add(where, `${label} «${rel}/${e.name}» изменено — в чат можно только добавлять`);
    }
  }
}

async function main() {
  if (!await exists(projectsDir)) { console.error(`Ошибка: папка projects/ не найдена в ${root}`); process.exit(1); }
  if (baseDir && !await exists(path.resolve(root, baseDir))) { console.error(`Ошибка: папка базовой ветки «${baseDir}» не найдена`); process.exit(1); }

  const entries = (await listDir(projectsDir)).sort((a, b) => a.name.localeCompare(b.name));
  const seenIds = new Map();
  let count = 0;

  for (const e of entries) {
    if (!e.isDirectory()) { add(`projects/${e.name}`, 'в папке projects/ допускаются только папки проектов'); continue; }
    count++;
    const folder = e.name;
    const dir = path.join(projectsDir, folder);
    const where = `projects/${folder}`;
    const files = {};
    for (const f of PROJECT_FILES) files[f] = await readJson(path.join(dir, f));

    for (const msg of validateProject(folder, files)) add(where, msg);

    // Лишнее в корне проекта
    for (const x of await listDir(dir)) {
      if (x.isDirectory() && (x.name === 'files' || x.name === CHAT_DIR)) continue;
      if (x.isFile() && PROJECT_FILES.includes(x.name)) continue;
      add(where, `лишний ${x.isDirectory() ? 'каталог' : 'файл'} «${x.name}» — в корне проекта допускаются только ${PROJECT_FILES.join(', ')} и папки ${CHAT_DIR}/, files/`);
    }

    // Повтор id проекта
    const p = files['project.json'];
    if (ok(p) && typeof p.id === 'string') {
      if (seenIds.has(p.id)) add(where, `id проекта ${p.id} уже используется в projects/${seenIds.get(p.id)}`);
      else seenIds.set(p.id, folder);
    }

    const referenced = new Set();
    for (const ref of projectFileRefs(files)) await checkRef(folder, { ...ref, where: `${where} › ${ref.where}` }, referenced);
    await checkChat(folder, dir, where, referenced);
    await checkFilesDir(folder, dir, where, referenced);

    if (baseDir) {
      const after = files['documents.json'];
      const before = await readJson(path.resolve(root, baseDir, 'projects', folder, 'documents.json'));
      if (!(after instanceof Error) && !(before instanceof Error)) {
        for (const id of approvalChanges(before, after)) {
          add(`${where} › documents.json`, `изменена отметка «${APPROVED}» у редакции ${id} — менять её может только Дмитрий в приложении`);
        }
      }
      await checkAppendOnly(folder, where);
    }
  }

  // Проекты, удалённые относительно base
  if (baseDir) {
    for (const e of await listDir(path.resolve(root, baseDir, 'projects'))) {
      if (!e.isDirectory() || await exists(path.join(projectsDir, e.name))) continue;
      const where = `projects/${e.name}`;
      const before = await readJson(path.resolve(root, baseDir, 'projects', e.name, 'documents.json'));
      if (ok(before)) for (const id of approvalChanges(before, { documents: [] })) add(where, `проект удалён вместе с редакцией ${id} со статусом «${APPROVED}»`);
      await checkAppendOnly(e.name, where);
    }
  }

  if (errors.length) {
    console.error(`Найдено ошибок: ${errors.length}`);
    for (const m of errors) console.error('  ✗ ' + m);
    process.exit(1);
  }
  const word = (n => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? 'проект' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'проекта' : 'проектов'; })(count);
  console.log(`Проверка пройдена: ${count} ${word}`);
}

main().catch(e => { console.error('Сбой проверки: ' + (e.stack || e.message)); process.exit(1); });
