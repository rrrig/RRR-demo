// ИГНИС ПРО: клиент GitHub (r05/pro/github.js) против поддельного GitHub в памяти.
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('node:path');
const { loadESModule } = require('./load-module.cjs');
const gh = () => loadESModule(path.join(__dirname, '../r05/pro/github.js'));
const fake = async (opts = {}) => {
  const { createFakeGitHub } = await import(path.join(__dirname, 'fixtures/fake-github.mjs'));
  const { templateFiles } = await import(path.join(__dirname, 'fixtures/template-seed.mjs'));
  return createFakeGitHub({ files: templateFiles(), token: 'tok', ...opts });
};
const client = async (g, extra = {}) => (await gh()).createClient({ owner: 'rrrig', repo: 'ignis-projects', token: 'tok', fetch: g.fetch, ...extra });
const P = 'projects/primer-ograzhdenie/';

test('чтение: head, дерево, текст и двоичный файл', async () => {
  const g = await fake(), c = await client(g);
  const h = await c.head();
  assert.equal(h.commit, g.head());
  const tree = await c.tree(h.tree);
  assert.ok(tree.every(e => e.type === 'blob'), 'папки отфильтрованы');
  const pj = tree.find(e => e.path === P + 'project.json');
  assert.equal(JSON.parse(await c.blobText(pj.sha)).id, 'p-7f3a9c2e41b0');
  const bytes = new Uint8Array([0, 255, 1, 128, 10, 13, 0x89, 0x50]);
  await c.commit({ message: '[Дмитрий] бинарный', parent: h, changes: [{ path: P + 'files/work/bin.dat', bytes }] });
  const e = (await c.tree((await c.head()).tree)).find(x => x.path === P + 'files/work/bin.dat');
  assert.deepEqual([...new Uint8Array(await c.blobBytes(e.sha))], [...bytes]);
  assert.equal(e.size, bytes.length);
  // Русский текст через base64 не портится.
  assert.match(await c.blobText(pj.sha), /ограждение Ø3000/);
});

test('атомарная запись нескольких файлов одним коммитом, удаление через sha:null', async () => {
  const g = await fake(), c = await client(g);
  const before = g.log().length;
  const sha = await c.mutate('[Дмитрий] Пакет', async ({ read }) => {
    assert.ok(await read(P + 'tasks.json'));
    return [{ path: P + 'files/work/a.txt', text: 'А' }, { path: P + 'files/work/b.txt', bytes: new TextEncoder().encode('Б') }, { path: P + 'sources.json', delete: true }];
  });
  assert.equal(g.head(), sha); assert.equal(g.log().length, before + 1);
  assert.equal(g.read(P + 'files/work/a.txt'), 'А'); assert.equal(g.read(P + 'files/work/b.txt'), 'Б');
  assert.equal(g.read(P + 'sources.json'), undefined);
  assert.equal(g.commits.get(sha).message, '[Дмитрий] Пакет');
  // Без реальных изменений коммит не создаётся.
  assert.equal(await c.mutate('[Дмитрий] пусто', async ({ read }) => [{ path: P + 'files/work/a.txt', text: await read(P + 'files/work/a.txt') }, { path: P + 'nothing.json', delete: true }]), null);
  assert.equal(g.head(), sha);
});

test('mutate: если main ушёл вперёд (ИИ закоммитил), правка строится заново поверх новой версии', async () => {
  const g = await fake(), c = await client(g);
  let builds = 0;
  g.beforeRefUpdate = () => g.aiCommit({ author: 'Claude', message: '[Claude] Чат: ответ', files: { [P + 'chat/20261109T120000Z-claude-m-aaaaaaaaaaaa.json']: '{}' } });
  await c.mutate('[Дмитрий] Задача', async ({ read }) => {
    builds++;
    const t = JSON.parse(await read(P + 'tasks.json')); t.tasks[0].status = 'Готово';
    return [{ path: P + 'tasks.json', text: JSON.stringify(t) }];
  });
  assert.equal(builds, 2);
  assert.equal(g.json(P + 'tasks.json').tasks[0].status, 'Готово');
  assert.ok(g.read(P + 'chat/20261109T120000Z-claude-m-aaaaaaaaaaaa.json'), 'сообщение Claude не затёрто');
  const log = g.log().map(x => x.message);
  assert.deepEqual(log.slice(0, 2), ['[Дмитрий] Задача', '[Claude] Чат: ответ']);
});

test('mutate: после трёх неудач — понятная ошибка 422; сетевые ошибки помечены', async () => {
  const { isNetworkError, isTemporaryError } = await gh();
  const g = await fake(), c = await client(g);
  let n = 0;
  const race = () => { if (n++ < 5) g.beforeRefUpdate = () => { g.aiCommit({ files: { [P + `files/work/x${n}.txt`]: 'x' } }); race(); }; };
  race();
  await assert.rejects(c.mutate('[Дмитрий] x', async () => [{ path: P + 'files/work/me.txt', text: 'я' }]), e => e.status === 422 && /GitHub отклонил изменение/.test(e.message) && !isNetworkError(e));
  g.beforeRefUpdate = null;
  g.offline = true;
  await assert.rejects(c.head(), e => isNetworkError(e) && isTemporaryError(e) && /Нет связи/.test(e.message));
  g.offline = false;
  const bad = await client(g, { token: 'wrong' });
  await assert.rejects(bad.head(), e => e.status === 401 && /Токен не принят/.test(e.message) && isTemporaryError(e) && !isNetworkError(e));
});

test('предложения: список, файлы с patch, принять (squash), отклонить с комментарием, проверки', async () => {
  const g = await fake(), c = await client(g);
  const pr = g.openPR({ author: 'Claude', title: '[Claude] Раскрой трубы', body: 'Что изменено…', check: 'success', files: {
    [P + 'tasks.json']: g.read(P + 'tasks.json').replace('"status": "Открыта"', '"status": "Готово"'),
    [P + 'files/work/raskroy.csv']: 'хлыст;длина\n1;6000\n' } });
  const pr2 = g.openPR({ author: 'ChatGPT', title: '[ChatGPT] Цены', check: 'failure', files: { [P + 'cost.json']: '{}' } });
  const list = await c.pulls();
  assert.deepEqual(list.map(x => x.number).sort(), [pr.number, pr2.number]);
  const files = await c.pullFiles(pr.number);
  assert.deepEqual(files.map(f => [f.filename, f.status]).sort(), [[P + 'files/work/raskroy.csv', 'added'], [P + 'tasks.json', 'modified']]);
  assert.match(files.find(f => f.status === 'added').patch, /^@@ -0,0 \+1,2 @@\n\+хлыст;длина\n\+1;6000$/);
  assert.match(files.find(f => f.status === 'modified').patch, /-.*"Открыта"[\s\S]*\+.*"Готово"/);
  assert.equal(await c.checks(pr.head.sha), 'success'); assert.equal(await c.checks(pr2.head.sha), 'failure'); assert.equal(await c.checks('0'.repeat(40)), 'none');
  // Пока PR ждал, в main появилась правка — squash всё равно применяется поверх.
  g.aiCommit({ files: { [P + 'chat/20261109T130000Z-claude-m-bbbbbbbbbbbb.json']: '{}' } });
  await assert.rejects(c.merge(pr.number, 'f'.repeat(40), 'x'), e => e.status === 409);
  await c.merge(pr.number, pr.head.sha, '[Дмитрий] Принято предложение #1');
  assert.equal(g.json(P + 'tasks.json').tasks[0].status, 'Готово');
  assert.ok(g.read(P + 'chat/20261109T130000Z-claude-m-bbbbbbbbbbbb.json'));
  assert.equal(g.log()[0].message, '[Дмитрий] Принято предложение #1');
  assert.equal(g.log()[0].parents.length, 1, 'squash — один родитель');
  await c.close(pr2.number, '[Дмитрий] Отклонено: дорого');
  assert.equal(g.pulls.find(p => p.number === pr2.number).state, 'closed');
  assert.deepEqual(g.comments, [{ issue: pr2.number, body: '[Дмитрий] Отклонено: дорого' }]);
  assert.deepEqual(await c.pulls(), []);
});

test('журнал: коммиты по пути, состояние на коммит, сведения о репозитории', async () => {
  const g = await fake(), c = await client(g);
  const first = g.head();
  g.aiCommit({ author: 'Claude', message: '[Claude] Чат', files: { [P + 'chat/x.json']: '{}' } });
  g.aiCommit({ author: 'Дмитрий', message: '[Дмитрий] Другое', files: { 'AGENTS.md': 'x' } });
  const log = await c.commits('projects/primer-ograzhdenie', 10);
  assert.deepEqual(log.map(x => x.commit.message), ['[Claude] Чат', 'Начальная структура']);
  const old = await c.treeAt(first);
  assert.ok(!old.some(e => e.path === P + 'chat/x.json'));
  const info = await c.repoInfo();
  assert.equal(info.full_name, 'rrrig/ignis-projects'); assert.equal(info.private, true);
});
