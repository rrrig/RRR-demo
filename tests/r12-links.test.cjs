// R12: связи проектов — parent (подпроект) и related (связанные); переименование документов.
const test = require('node:test'); const assert = require('node:assert/strict');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { loadESModule } = require('./load-module.cjs');
const mod = n => loadESModule(path.join(__dirname, '../r05/pro', n));
const pj = (id, extra = {}) => ({ schema: 1, id, name: 'П ' + id, status: 'В работе', created: '2026-11-11', updated: '2026-11-11', ...extra });

test('модель: parent и related — id проектов, не на себя, без повторов', async () => {
  const M = await mod('model.js');
  assert.deepEqual(M.validateFile('project.json', pj('p-aaaaaa', { parent: 'p-bbbbbb', related: ['p-cccccc', 'p-dddddd'] })), []);
  assert.match(M.validateFile('project.json', pj('p-aaaaaa', { parent: 'd-bbbbbb' })).join(), /parent/);
  assert.match(M.validateFile('project.json', pj('p-aaaaaa', { parent: 'p-aaaaaa' })).join(), /сам в себя/);
  assert.match(M.validateFile('project.json', pj('p-aaaaaa', { related: ['p-bbbbbb', 'p-bbbbbb'] })).join(), /повтор/);
  assert.match(M.validateFile('project.json', pj('p-aaaaaa', { related: 'p-bbbbbb' })).join(), /related/);
});

test('связи между проектами: нет такого проекта, цикл', async () => {
  const M = await mod('model.js');
  const P = (folder, id, extra) => ({ folder, project: pj(id, extra) });
  assert.deepEqual(M.projectLinkErrors([P('a', 'p-aaaaaa'), P('b', 'p-bbbbbb', { parent: 'p-aaaaaa', related: ['p-aaaaaa'] }), P('c', 'p-cccccc', { parent: 'p-bbbbbb' })]), []);
  assert.match(M.projectLinkErrors([P('b', 'p-bbbbbb', { parent: 'p-zzzzzz' })]).join(), /parent p-zzzzzz — нет такого проекта/);
  assert.match(M.projectLinkErrors([P('b', 'p-bbbbbb', { related: ['p-zzzzzz'] })]).join(), /related p-zzzzzz/);
  assert.match(M.projectLinkErrors([P('a', 'p-aaaaaa', { parent: 'p-cccccc' }), P('b', 'p-bbbbbb', { parent: 'p-aaaaaa' }), P('c', 'p-cccccc', { parent: 'p-bbbbbb' })]).join(), /цикл/);
});

test('операция «Изменить проект»: parent ставится и снимается (null удаляет поле), документ переименовывается без потери редакций', async () => {
  const O = await mod('ops.js');
  const files = { 'project.json': pj('p-aaaaaa', { related: ['p-cccccc'] }), 'documents.json': { schema: 1, documents: [{ id: 'd-aaaaaa', name: 'Старое', format: 'PDF', revisions: [{ id: 'r-aaaaaa', rev: 'R01', status: 'Не проверено', date: '2026-11-11', author: 'Claude' }] }] } };
  O.applyOp(files, { type: 'set', file: 'project.json', fields: { parent: 'p-bbbbbb', related: null } });
  assert.equal(files['project.json'].parent, 'p-bbbbbb'); assert.equal('related' in files['project.json'], false);
  O.applyOp(files, { type: 'set', file: 'project.json', fields: { parent: null } });
  assert.equal('parent' in files['project.json'], false);
  O.applyOp(files, { type: 'upsert', file: 'documents.json', list: 'documents', item: { id: 'd-aaaaaa', name: 'Новое', format: 'DWG' } });
  const d = files['documents.json'].documents[0];
  assert.equal(d.name, 'Новое'); assert.equal(d.format, 'DWG'); assert.equal(d.revisions.length, 1);
});

test('хранилище: validate.mjs проверяет связи проектов', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-'));
  fs.cpSync(path.join(__dirname, '../data-template'), tmp, { recursive: true });
  const run = () => { try { return execFileSync('node', ['tools/validate.mjs'], { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return e.stdout + e.stderr; } };
  const A = path.join(tmp, 'projects/primer-ograzhdenie'), B = path.join(tmp, 'projects/podproekt');
  fs.mkdirSync(B); for (const f of ['documents.json', 'tasks.json', 'sources.json', 'cost.json']) fs.copyFileSync(path.join(A, f), path.join(B, f));
  const aId = JSON.parse(fs.readFileSync(path.join(A, 'project.json'), 'utf8')).id;
  const writeB = extra => fs.writeFileSync(path.join(B, 'project.json'), JSON.stringify(pj('p-bbbbbb111111', extra)));
  writeB({ parent: aId, related: [aId] }); assert.match(run(), /Проверка пройдена: 2 проекта/);
  writeB({ parent: 'p-ffffff000000' }); assert.match(run(), /нет такого проекта/);
  const a = JSON.parse(fs.readFileSync(path.join(A, 'project.json'), 'utf8')); a.parent = 'p-bbbbbb111111';
  fs.writeFileSync(path.join(A, 'project.json'), JSON.stringify(a)); writeB({ parent: aId });
  assert.match(run(), /цикл/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- Одновременные правки связей: проверка по свежему дереву внутри записи (mutate → buildChanges) ---
async function linkRepo() {
  const { createFakeGitHub } = await import(path.join(__dirname, 'fixtures/fake-github.mjs'));
  const { templateFiles } = await import(path.join(__dirname, 'fixtures/template-seed.mjs'));
  const base = templateFiles(), A = 'projects/primer-ograzhdenie/', files = { ...base };
  const aPj = JSON.parse(new TextDecoder().decode(base[A + 'project.json']));
  for (const f of ['documents.json', 'tasks.json', 'sources.json', 'cost.json']) files['projects/c-proekt/' + f] = base[A + f];
  files['projects/c-proekt/project.json'] = JSON.stringify(pj('p-cccccc111111'));
  const gh = createFakeGitHub({ files, token: 'tok' });
  const G = await mod('github.js'), O = await mod('ops.js');
  const client = G.createClient({ owner: 'rrrig', repo: 'RRR', token: 'tok', fetch: gh.fetch });
  const send = op => client.mutate('[Дмитрий] связь', ({ read, files: tree }) => O.buildChanges(op.slug, op, read, async () => null, tree));
  const setC = parent => gh.aiCommit({ author: 'ChatGPT', files: { 'projects/c-proekt/project.json': JSON.stringify(pj('p-cccccc111111', parent ? { parent } : {})) } });
  const readPj = async slug => JSON.parse(await client.blobText((await client.tree((await client.head()).tree)).find(e => e.path === `projects/${slug}/project.json`).sha));
  return { gh, client, send, setC, readPj, aId: aPj.id, setA: parent => ({ type: 'set', slug: 'primer-ograzhdenie', file: 'project.json', fields: { parent } }) };
}

test('конкурентно: C.parent=A записан другим устройством до отправки — A.parent=C отклоняется, цикл в main не попадает', async () => {
  const r = await linkRepo();
  r.setC(r.aId);                                       // другое устройство: C входит в A (само по себе корректно)
  await assert.rejects(r.send(r.setA('p-cccccc111111')), /Связь проектов не сохранена: цикл/);
  assert.equal((await r.readPj('primer-ograzhdenie')).parent, undefined);
});

test('конкурентно: правка между чтением и обновлением ref — повтор mutate проверяет связи заново', async () => {
  const r = await linkRepo();
  r.gh.beforeRefUpdate = () => r.setC(r.aId);           // C.parent=A появляется в момент записи → конфликт → повтор
  await assert.rejects(r.send(r.setA('p-cccccc111111')), /цикл/);
  assert.equal((await r.readPj('primer-ograzhdenie')).parent, undefined);
  assert.equal((await r.readPj('c-proekt')).parent, r.aId);
});

test('очередь с телефона: родитель удалён на сервере, пока изменение ждало отправки — отказ «нет такого проекта»', async () => {
  const r = await linkRepo();
  const queued = r.setA('p-cccccc111111');               // поставлено в очередь без связи
  r.gh.aiCommit({ author: 'ChatGPT', files: Object.fromEntries(['project.json', 'documents.json', 'tasks.json', 'sources.json', 'cost.json'].map(f => ['projects/c-proekt/' + f, null])) });
  await assert.rejects(r.send(queued), /нет такого проекта/);
});

test('корректная связь сохраняется; чужая старая ошибка в другом проекте не мешает', async () => {
  const r = await linkRepo();
  r.gh.aiCommit({ author: 'ChatGPT', files: { 'projects/c-proekt/project.json': JSON.stringify(pj('p-cccccc111111', { related: ['p-ffffff000000'] })) } });
  await r.send(r.setA('p-cccccc111111'));
  assert.equal((await r.readPj('primer-ograzhdenie')).parent, 'p-cccccc111111');
});
