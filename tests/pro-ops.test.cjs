// ИГНИС ПРО: операции изменения проекта (r05/pro/ops.js) — applyOp, buildChanges, preview.
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('node:path'); const fs = require('node:fs');
const { loadESModule } = require('./load-module.cjs');
const ops = () => loadESModule(path.join(__dirname, '../r05/pro/ops.js'));
const model = () => loadESModule(path.join(__dirname, '../r05/pro/model.js'));
const SLUG = 'primer-ograzhdenie', DIR = path.join(__dirname, '../data-template/projects', SLUG);
const NAMES = ['project.json', 'documents.json', 'tasks.json', 'sources.json', 'cost.json'];
// Дата «updated» в фикстуре — заведомо в прошлом, чтобы тест не зависел от сегодняшнего дня.
const read = n => { const t = fs.readFileSync(path.join(DIR, n), 'utf8'); return n === 'project.json' ? t.replace(/"updated": "[^"]+"/, '"updated": "2020-01-01"') : t; };
function repo() { return new Map(NAMES.map(n => [`projects/${SLUG}/${n}`, read(n)])); }
const files = () => Object.fromEntries(NAMES.map(n => [n, JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'))]));
async function changes(op, r = repo(), slug = SLUG) {
  const { buildChanges } = await ops();
  return buildChanges(slug, op, async p => r.get(p), async u => 'sha-of-' + u.key);
}
const json = (ch, name) => JSON.parse(ch.find(c => c.path.endsWith('/' + name)).text);

test('upsert: новая запись добавляется, существующая сливается; null удаляет поле', async () => {
  const { applyOp } = await ops();
  const f = files();
  applyOp(f, { type: 'upsert', file: 'tasks.json', list: 'tasks', item: { id: 't-newtask1', title: 'Новая', assignee: 'Дмитрий', status: 'Открыта', created: '2026-11-09', author: 'Дмитрий', due: null, note: null } });
  const nt = f['tasks.json'].tasks.at(-1);
  assert.equal(nt.title, 'Новая'); assert.ok(!('due' in nt)); assert.ok(!('note' in nt));
  // Задача с due и note: пользователь очистил оба поля, заголовок не менял.
  const t0 = f['tasks.json'].tasks[0]; assert.equal(t0.due, '2026-11-20'); assert.ok(t0.note);
  f['tasks.json'].tasks[0].aiField = 'добавлено ИИ';
  applyOp(f, { type: 'upsert', file: 'tasks.json', list: 'tasks', item: { id: t0.id, title: t0.title, assignee: 'Claude', status: 'В работе', created: t0.created, author: t0.author, due: null, note: null } });
  const t1 = f['tasks.json'].tasks[0];
  assert.ok(!('due' in t1), 'срок удалён'); assert.ok(!('note' in t1), 'подробности удалены');
  assert.equal(t1.status, 'В работе'); assert.equal(t1.aiField, 'добавлено ИИ', 'чужие поля сохраняются');
  // JSON-копия операции из очереди (IndexedDB хранит null, но не undefined) даёт тот же результат.
  const queued = JSON.parse(JSON.stringify({ type: 'upsert', file: 'cost.json', list: 'items', item: { ...f['cost.json'].items[0], note: null } }));
  applyOp(f, queued); assert.ok(!('note' in f['cost.json'].items[0]));
});

test('set, remove, revision, status', async () => {
  const { applyOp } = await ops();
  const f = files();
  applyOp(f, { type: 'set', file: 'project.json', fields: { name: 'Новое имя', customer: '' } });
  assert.equal(f['project.json'].name, 'Новое имя'); assert.equal(f['project.json'].id, 'p-7f3a9c2e41b0');
  applyOp(f, { type: 'set', file: 'cost.json', fields: { overheadPct: 10, marginPct: 0 } });
  assert.equal(f['cost.json'].overheadPct, 10); assert.equal(f['cost.json'].items.length, 3);
  applyOp(f, { type: 'remove', file: 'cost.json', list: 'items', id: 'c-6a2d8f4c0e95' });
  assert.equal(f['cost.json'].items.length, 2);
  assert.throws(() => applyOp(f, { type: 'remove', file: 'cost.json', list: 'items', id: 'c-6a2d8f4c0e95' }), /уже удалена/);
  const doc = f['documents.json'].documents[0];
  applyOp(f, { type: 'revision', docId: doc.id, item: { id: 'r-second01', rev: 'R02', status: 'Не проверено', date: '2026-11-10', author: 'Дмитрий' } });
  assert.equal(doc.revisions.length, 2);
  assert.throws(() => applyOp(f, { type: 'revision', docId: doc.id, item: { id: 'r-third001', rev: ' r02', status: 'Не проверено', date: '2026-11-10', author: 'Дмитрий' } }), /Редакция r02 уже есть|Редакция  r02 уже есть/);
  assert.throws(() => applyOp(f, { type: 'revision', docId: 'd-missing1', item: { id: 'r-x00001', rev: 'R9' } }), /Документ не найден/);
  // Разрешение к выдаче: прежняя разрешённая редакция уходит в архив.
  applyOp(f, { type: 'status', docId: doc.id, revId: 'r-a1c5e9d3b7f4', status: 'Разрешено к выдаче' });
  applyOp(f, { type: 'status', docId: doc.id, revId: 'r-second01', status: 'Разрешено к выдаче' });
  assert.deepEqual(doc.revisions.map(r => r.status), ['Архив', 'Разрешено к выдаче']);
  applyOp(f, { type: 'status', docId: doc.id, revId: 'r-second01', status: 'На проверке' });
  assert.deepEqual(doc.revisions.map(r => r.status), ['Архив', 'На проверке']);
  assert.throws(() => applyOp(f, { type: 'status', docId: doc.id, revId: 'r-nope000', status: 'Архив' }), /Редакция не найдена/);
  assert.throws(() => applyOp(f, { type: 'bogus' }), /Неизвестная операция/);
});

test('buildChanges: изменённые JSON проверяются, дата updated обновляется только при изменении', async () => {
  const { today } = await model();
  const ch = await changes({ type: 'upsert', file: 'tasks.json', list: 'tasks', item: { id: 't-3d9f2a7c5e18', status: 'Готово' } });
  assert.deepEqual(ch.map(c => c.path).sort(), [`projects/${SLUG}/project.json`, `projects/${SLUG}/tasks.json`]);
  assert.equal(json(ch, 'project.json').updated, today());
  assert.equal(json(ch, 'tasks.json').tasks[0].status, 'Готово');
  assert.ok(ch.every(c => c.text.endsWith('}\n')));
  // Ничего не меняющая операция — ни одной правки (и дата не трогается).
  assert.deepEqual(await changes({ type: 'upsert', file: 'tasks.json', list: 'tasks', item: { id: 't-3d9f2a7c5e18', status: 'Открыта' } }), []);
  // Неверные данные не уходят в репозиторий.
  await assert.rejects(changes({ type: 'upsert', file: 'tasks.json', list: 'tasks', item: { id: 't-3d9f2a7c5e18', due: '2026-02-30' } }), /due.*существующей датой/);
  await assert.rejects(changes({ type: 'upsert', file: 'cost.json', list: 'items', item: { id: 'bad', group: 'Материалы', name: 'x', unit: 'шт', qty: 1, price: 1 } }), /неверный id/);
  await assert.rejects(changes({ type: 'set', file: 'project.json', fields: { status: 'Готов' } }), /status/);
  await assert.rejects(changes({ type: 'revision', docId: 'd-4b8e1f6a90c2', item: { id: 'r-dup00001', rev: 'R01', status: 'Не проверено', date: '2026-11-09', author: 'Дмитрий' } }), /Редакция R01 уже есть/);
});

test('buildChanges: create — новая папка; существующая — ошибка; повтор того же проекта — без изменений', async () => {
  const { emptyProject } = await model();
  const f = emptyProject({ name: 'Звезда 6 м', author: 'Дмитрий' });
  const ch = await changes({ type: 'create', files: f, uploads: [{ path: 'projects/zvezda/files/docs/r-1-a.pdf', key: 'u-1' }] }, new Map(), 'zvezda');
  assert.deepEqual(ch.map(c => c.path), [...NAMES.map(n => 'projects/zvezda/' + n), 'projects/zvezda/files/docs/r-1-a.pdf']);
  assert.equal(ch.at(-1).sha, 'sha-of-u-1');
  const r = new Map(ch.filter(c => c.text).map(c => [c.path, c.text]));
  await assert.rejects(changes({ type: 'create', files: emptyProject({ name: 'Другой' }) }, r, 'zvezda'), /Папка проекта уже существует/);
  const again = await changes({ type: 'create', files: f }, r, 'zvezda');
  assert.deepEqual(again, [], 'ответ GitHub потерялся — повторная отправка ничего не ломает');
  await assert.rejects(changes({ type: 'create', files: { ...f, 'project.json': { ...f['project.json'], status: 'Нет' } } }, new Map(), 'x2'), /status/);
});

test('buildChanges: chat, deleteFile, writeFile — проверка путей', async () => {
  const { newChatMessage } = await model();
  const msg = newChatMessage({ author: 'Дмитрий', text: '@Claude привет', mentions: ['Claude'] });
  const ch = await changes({ type: 'chat', message: msg });
  assert.equal(ch.length, 1); assert.match(ch[0].path, new RegExp(`^projects/${SLUG}/chat/\\d{8}T\\d{6}Z-dmitriy-${msg.id}\\.json$`));
  assert.deepEqual(JSON.parse(ch[0].text), msg);
  const r = repo(); r.set(ch[0].path, ch[0].text);
  assert.deepEqual(await changes({ type: 'chat', message: msg }, r), [], 'то же сообщение второй раз не пишется');
  await assert.rejects(changes({ type: 'chat', message: { ...msg, text: '' } }), /text/);
  await assert.rejects(changes({ type: 'chat', message: { ...msg, files: [{ path: 'projects/other/files/chat/x', name: 'x', size: 1 }] } }), /файл должен лежать/);

  const wp = `projects/${SLUG}/files/work/raschet.txt`;
  assert.deepEqual(await changes({ type: 'writeFile', uploads: [{ path: wp, key: 'u-9' }] }), [{ path: wp, sha: 'sha-of-u-9' }]);
  for (const bad of [`projects/${SLUG}/files/work/../project.json`, `projects/${SLUG}/project.json`, `projects/other/files/work/a.txt`, `projects/${SLUG}/files/work/sub/a.txt`, 'AGENTS.md'])
    await assert.rejects(changes({ type: 'writeFile', uploads: [{ path: bad, key: 'u' }] }), /Неверный путь файла/, bad);
  await assert.rejects(changes({ type: 'deleteFile', path: `projects/${SLUG}/project.json` }), /только файлы проекта/);
  await assert.rejects(changes({ type: 'deleteFile', path: wp }), /уже удалён/);
  r.set(wp, 'x');
  assert.deepEqual(await changes({ type: 'deleteFile', path: wp }, r), [{ path: wp, delete: true }]);
});

test('preview: ожидающие операции показываются поверх копии, ошибки собираются, исходник не меняется', async () => {
  const { preview } = await ops();
  const f = files();
  const { files: out, failed } = preview(f, [
    { type: 'upsert', file: 'tasks.json', list: 'tasks', item: { id: 't-3d9f2a7c5e18', status: 'Готово', due: null } },
    { type: 'remove', file: 'tasks.json', list: 'tasks', id: 't-nothere1' },
    { type: 'create', files: {} },
    { type: 'chat', message: {} },
  ]);
  assert.equal(out['tasks.json'].tasks[0].status, 'Готово'); assert.ok(!('due' in out['tasks.json'].tasks[0]));
  assert.equal(f['tasks.json'].tasks[0].status, 'Открыта', 'исходные данные не изменились');
  assert.equal(failed.length, 1); assert.match(failed[0].error, /уже удалена/);
});
