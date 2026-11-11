// Изменения пользователя в виде данных («операций»).
// Одна и та же операция применяется сразу (при связи) или позже из очереди (без связи)
// к самой свежей версии проекта — поэтому чужие изменения не затираются.
import { PROJECT_FILES, APPROVED, today, validateFile, validateChatMessage, chatFileName, CHAT_DIR, validFilePath, wholeOf, projectLinkErrors } from './model.js';

const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
// Слияние записи: поля со значением null удаляются (так форма сообщает «поле очищено»),
// остальные поля, в том числе добавленные другими участниками, сохраняются.
function merge(old, patch) {
  const out = { ...old, ...clone(patch) };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}
const strip = item => merge({}, item);

export function applyOp(files, op) {
  const f = files;
  switch (op.type) {
    case 'create': {
      for (const name of PROJECT_FILES) f[name] = clone(op.files[name]);
      return;
    }
    case 'set': {
      need(f, op.file);
      f[op.file] = merge(f[op.file], op.fields);
      return;
    }
    case 'upsert': {
      need(f, op.file);
      const list = f[op.file][op.list] ||= [];
      const i = list.findIndex(x => x.id === op.item.id);
      if (i >= 0) list[i] = merge(list[i], op.item); else list.push(strip(op.item));
      return;
    }
    case 'remove': {
      need(f, op.file);
      const list = f[op.file][op.list] || [];
      const i = list.findIndex(x => x.id === op.id);
      if (i < 0) throw new Error('Запись уже удалена кем-то другим');
      list.splice(i, 1);
      return;
    }
    case 'revision': {
      const doc = findDoc(f, op.docId);
      doc.revisions ||= [];
      const i = doc.revisions.findIndex(r => r.id === op.item.id);
      if (i >= 0) doc.revisions[i] = merge(doc.revisions[i], op.item);
      else {
        const k = String(op.item.rev).trim().toLowerCase();
        if (doc.revisions.some(r => String(r.rev).trim().toLowerCase() === k)) throw new Error(`Редакция ${op.item.rev} уже есть у документа «${doc.name}»`);
        doc.revisions.push(strip(op.item));
      }
      return;
    }
    case 'status': {
      const doc = findDoc(f, op.docId);
      const rev = (doc.revisions || []).find(r => r.id === op.revId);
      if (!rev) throw new Error('Редакция не найдена');
      if (op.status === APPROVED) for (const r of doc.revisions) if (r.status === APPROVED && r.id !== rev.id) r.status = 'Архив';
      rev.status = op.status;
      return;
    }
    case 'chat':
    case 'deleteFile':
    case 'writeFile':
      return; // отдельные файлы, JSON проекта не меняют
    default:
      throw new Error('Неизвестная операция ' + op.type);
  }
}
function need(f, name) { if (!f[name]) throw new Error(`Нет файла ${name} в проекте`); }
function findDoc(f, id) {
  need(f, 'documents.json');
  const d = f['documents.json'].documents.find(x => x.id === id);
  if (!d) throw new Error('Документ не найден (возможно, удалён)');
  return d;
}

// Построить список изменений файлов репозитория для одной операции.
// read(path) → текст или undefined; blobSha(key) → sha уже загруженного файла.
async function checkLinks(slug, pj, read, tree) {
  if (!pj || (!pj.parent && !(pj.related || []).length)) return;      // связей нет — нечего проверять
  const list = [{ folder: slug, project: pj }];
  for (const path of tree.keys()) {
    const m = /^projects\/([^/]+)\/project\.json$/.exec(path);
    if (!m || m[1] === slug) continue;
    try { list.push({ folder: m[1], project: JSON.parse(await read(path)) }); } catch { /* повреждённый project.json другого проекта — не связь */ }
  }
  const mine = projectLinkErrors(list).filter(e => e.startsWith(`projects/${slug}:`));
  if (mine.length) throw new Error('Связь проектов не сохранена: ' + mine.map(e => e.slice(`projects/${slug}: `.length)).join('; ') + '. Обновите список проектов и выберите снова.');
}

// Все пути, которыми сейчас представлен файл L в дереве: сам L, его части L.partNNN и манифест L.parts.json.
function representation(tree, L) {
  const out = [];
  if (tree) for (const p of tree.keys()) if (p === L || wholeOf(p) === L) out.push(p);
  return out;
}
// tree — Map путей текущего дерева (из mutate); нужен, чтобы при замене и удалении убрать
// старое представление файла (целый файл, части, манифест) в том же коммите.
export async function buildChanges(slug, op, read, blobSha, tree = null) {
  const dir = `projects/${slug}/`;
  const changes = [];
  if (op.type === 'chat') {
    const errs = validateChatMessage(op.message, slug);
    if (errs.length) throw new Error(errs.join('\n'));
    const path = dir + CHAT_DIR + '/' + chatFileName(op.message);
    // Сообщения не изменяются: если файл уже есть (повторная отправка из очереди), второй раз не пишем.
    if (await read(path) === undefined) changes.push({ path, text: JSON.stringify(op.message, null, 2) + '\n' });
  } else if (op.type === 'deleteFile') {
    if (!validFilePath(op.path, slug)) throw new Error('Удалять можно только файлы проекта');
    const rep = tree ? representation(tree, op.path) : (await read(op.path) === undefined ? [] : [op.path]);
    if (!rep.length && !op.force) throw new Error('Файл уже удалён');
    for (const p of rep) changes.push({ path: p, delete: true });
    if (!rep.length) changes.push({ path: op.path, delete: true });
  } else if (op.type === 'writeFile') {
    for (const u of op.uploads || []) if (!validFilePath(u.path, slug)) throw new Error('Неверный путь файла: ' + u.path);
    // Замена: всё прежнее представление файла, которого нет среди новых загрузок, удаляется.
    const keep = new Set((op.uploads || []).map(u => u.path));
    for (const L of op.replace || []) {
      if (!validFilePath(L, slug)) throw new Error('Неверный путь файла: ' + L);
      for (const p of representation(tree, L)) if (!keep.has(p)) changes.push({ path: p, delete: true });
    }
  } else {
    const files = {}, before = {};
    for (const name of PROJECT_FILES) {
      const t = await read(dir + name);
      before[name] = t;
      files[name] = t === undefined ? undefined : JSON.parse(t);
    }
    // Повторная отправка того же проекта (ответ GitHub потерялся) — данные уже на месте.
    const already = op.type === 'create' && files['project.json']?.id === op.files['project.json'].id;
    if (op.type === 'create' && files['project.json'] && !already) throw new Error('Папка проекта уже существует');
    if (!already) applyOp(files, op);
    const text = name => JSON.stringify(files[name], null, 2) + '\n';
    const changed = PROJECT_FILES.filter(name => files[name] !== undefined && text(name) !== before[name]);
    // Дата изменения проекта — только если что-то действительно изменилось.
    if (op.type !== 'create' && changed.length && files['project.json'] && !(files['project.json'] instanceof Error)) {
      files['project.json'].updated = today();
      if (!changed.includes('project.json') && text('project.json') !== before['project.json']) changed.push('project.json');
    }
    for (const name of changed) {
      const errs = validateFile(name, files[name], slug);
      if (errs.length) throw new Error(errs.join('\n'));
      changes.push({ path: dir + name, text: text(name) });
    }
    // Связи проектов проверяются по свежему дереву хранилища, прочитанному прямо перед записью
    // (mutate повторяет сборку при конфликте; очередь с телефона идёт тем же путём): цель parent/related
    // существует, вложенность без циклов. Так одновременная правка другого устройства не даст записать цикл.
    if (changed.includes('project.json') && tree) await checkLinks(slug, files['project.json'], read, tree);
  }
  for (const u of op.uploads || []) changes.push({ path: u.path, sha: await blobSha(u) });
  return changes;
}

// Применить ожидающие операции к локальной копии (для показа до отправки).
export function preview(files, ops) {
  const out = clone(files);
  const failed = [];
  for (const op of ops) {
    try { if (op.type !== 'create') applyOp(out, op); } catch (e) { failed.push({ op, error: e.message }); }
  }
  return { files: out, failed };
}
