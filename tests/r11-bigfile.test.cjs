// R11: большие файлы частями по 20 МБ — разбиение, сборка, проверка модели и хранилища.
const test = require('node:test'); const assert = require('node:assert/strict');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const { execFileSync } = require('node:child_process'); const crypto = require('node:crypto');
const { loadESModule } = require('./load-module.cjs');
const mod = n => loadESModule(path.join(__dirname, '../r05/pro', n));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const MB = 1024 * 1024;

test('разбиение 55 МБ → 3 части (20+20+остаток), сборка байт в байт, sha256 целого', async () => {
  const B = await mod('bigfile.js'), M = await mod('model.js');
  const data = crypto.randomBytes(55 * 1000 * 1000);
  const store = new Map(), P = 'projects/x/files/docs/r-aaaaaa-big.zip';
  const ref = await B.splitBlob(new Blob([data]), P, 'Big.zip', async (pt, bytes) => store.set(pt.path, bytes));
  assert.deepEqual(ref.parts.map(x => x.size), [20 * MB, 20 * MB, data.length - 40 * MB]);
  assert.deepEqual(ref.parts.map(x => x.path), [P + '.part001', P + '.part002', P + '.part003']);
  assert.equal(ref.sha256, sha(data)); assert.equal(ref.size, data.length);
  for (const pt of ref.parts) assert.equal(pt.sha256, sha(Buffer.from(store.get(pt.path))));
  const doc = { schema: 1, documents: [{ id: 'd-aaaaaa', name: 'n', format: 'Другое', revisions: [{ id: 'r-aaaaaa', rev: 'R01', status: 'Не проверено', date: '2026-11-11', author: 'Claude', file: ref }] }] };
  assert.deepEqual(M.validateFile('documents.json', doc, 'x'), []);
  const blob = await B.assembleParts(ref.parts, async p => store.get(p));
  assert.ok(Buffer.from(await blob.arrayBuffer()).equals(data));
});

test('повреждённая или отсутствующая часть — понятная ошибка, а не битый файл', async () => {
  const B = await mod('bigfile.js');
  const data = crypto.randomBytes(51 * MB), store = new Map();
  const ref = await B.splitBlob(new Blob([data]), 'projects/x/files/docs/r-aaaaaa-b.bin', 'b.bin', async (pt, b) => store.set(pt.path, b));
  const bad = new Uint8Array(store.get(ref.parts[1].path).slice(0)); bad[5] ^= 1;
  await assert.rejects(B.assembleParts(ref.parts, async p => (p === ref.parts[1].path ? bad.buffer : store.get(p))), /Часть 2 повреждена/);
  await assert.rejects(B.assembleParts(ref.parts, async p => (p === ref.parts[2].path ? null : store.get(p))), /Часть 3 из 3 не найдена/);
});

test('до 50 МБ — не делится; части группируются в один файл', async () => {
  const B = await mod('bigfile.js');
  await assert.rejects(B.splitBlob(new Blob([new Uint8Array(10)]), 'p', 'a', async () => {}), /целиком/);
  const g = B.groupParts([{ path: 'a/x.zip.part002' }, { path: 'a/y.pdf' }, { path: 'a/x.zip.part001' }]);
  assert.deepEqual(g.map(x => [x.path, x.parts?.map(p => p.path)]), [['a/x.zip', ['a/x.zip.part001', 'a/x.zip.part002']], ['a/y.pdf', undefined]]);
});

test('модель: части — строго по 20 МБ кроме последней, сумма = size, sha256 обязателен', async () => {
  const M = await mod('model.js');
  const P = 'projects/x/files/docs/r-aaaaaa-b.zip', h = 'a'.repeat(64);
  const mk = (sizes, extra = {}) => ({ schema: 1, sources: [{ id: 's-aaaaaa', type: 'Прочее', title: 't', origin: 'Claude', date: '2026-11-11', file: { path: P, name: 'b', size: sizes.reduce((a, b) => a + b, 0), sha256: h, parts: sizes.map((s, i) => ({ path: M.partPath(P, i), size: s, sha256: h })), ...extra } }] });
  assert.deepEqual(M.validateFile('sources.json', mk([20 * MB, 20 * MB, 11 * MB]), 'x'), []);
  assert.match(M.validateFile('sources.json', mk([20 * MB, 5, 31 * MB]), 'x').join(), /кроме последней/);
  assert.match(M.validateFile('sources.json', mk([20 * MB, 20 * MB, 11 * MB], { sha256: undefined }), 'x').join(), /обязателен sha256/);
  assert.match(M.validateFile('sources.json', mk([20 * MB, 20 * MB, 11 * MB], { size: 1 }), 'x').join(), /size/);
});

test('хранилище: split-file.mjs → validate.mjs проходит; порча части и лишний целый файл ловятся; join-file.mjs собирает исходник', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-'));
  fs.cpSync(path.join(__dirname, '../data-template'), tmp, { recursive: true });
  const run = (...a) => execFileSync('node', a, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const runFail = (...a) => { try { run(...a); return ''; } catch (e) { return e.stdout + e.stderr; } };
  const src = path.join(tmp, 'big.bin'); const data = crypto.randomBytes(52 * MB); fs.writeFileSync(src, data);
  const P = 'projects/primer-ograzhdenie', rp = `${P}/files/docs/r-b1c5e9d3b7f5-big.bin`;
  const ref = JSON.parse(run('tools/split-file.mjs', src, rp));
  fs.unlinkSync(src);
  const dj = path.join(tmp, P, 'documents.json'); const d = JSON.parse(fs.readFileSync(dj, 'utf8'));
  d.documents[0].revisions.push({ id: 'r-b1c5e9d3b7f5', rev: 'R99', status: 'Не проверено', date: '2026-11-11', author: 'Claude', file: ref });
  fs.writeFileSync(dj, JSON.stringify(d, null, 2));
  assert.match(run('tools/validate.mjs'), /Проверка пройдена/);
  const out = path.join(tmp, 'joined.bin');
  assert.match(run('tools/join-file.mjs', rp, out), /sha256 совпал/);
  assert.ok(fs.readFileSync(out).equals(data));
  fs.writeFileSync(path.join(tmp, rp), 'x');                                   // целый файл рядом с частями
  assert.match(runFail('tools/validate.mjs'), /хранится частями/);
  fs.unlinkSync(path.join(tmp, rp));
  const p2 = path.join(tmp, rp + '.part002'); const b = fs.readFileSync(p2); b[0] ^= 1; fs.writeFileSync(p2, b);
  assert.match(runFail('tools/validate.mjs'), /часть 2: sha256/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
