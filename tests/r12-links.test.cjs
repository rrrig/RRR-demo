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
