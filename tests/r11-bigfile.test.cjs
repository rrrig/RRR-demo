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
  const blob = await B.assembleParts(M.toManifest(ref), async p => store.get(p));
  assert.ok(Buffer.from(await blob.arrayBuffer()).equals(data));
});

test('повреждённая, отсутствующая часть или неверный манифест — ошибка, а не неполный файл', async () => {
  const B = await mod('bigfile.js'), M = await mod('model.js');
  const data = crypto.randomBytes(51 * MB), store = new Map();
  const ref = await B.splitBlob(new Blob([data]), 'projects/x/files/docs/r-aaaaaa-b.bin', 'b.bin', async (pt, b) => store.set(pt.path, b));
  const man = M.toManifest(ref);
  const bad = new Uint8Array(store.get(ref.parts[1].path).slice(0)); bad[5] ^= 1;
  await assert.rejects(B.assembleParts(man, async p => (p === ref.parts[1].path ? bad.buffer : store.get(p))), /Часть 2 повреждена/);
  // part001 и part003 есть, part002 нет — неполный файл не выдаётся
  await assert.rejects(B.assembleParts(man, async p => (p === ref.parts[1].path ? null : store.get(p))), /Часть 2 из 3 не найдена/);
  await assert.rejects(B.assembleParts({ ...man, parts: man.parts.slice(0, 2) }, async p => store.get(p)), /Описание частей/);
  await assert.rejects(B.assembleParts({ ...man, sha256: 'b'.repeat(64) }, async p => store.get(p)), /не совпал по sha256/);
  await assert.rejects(B.assembleParts(null, async () => null), /Описание частей/);
});

test('до 50 МБ — не делится; части группируются в один файл', async () => {
  const B = await mod('bigfile.js');
  await assert.rejects(B.splitBlob(new Blob([new Uint8Array(10)]), 'p', 'a', async () => {}), /целиком/);
  const g = B.groupParts([{ path: 'a/x.zip.part002' }, { path: 'a/y.pdf' }, { path: 'a/x.zip.parts.json' }, { path: 'a/x.zip.part001' }]);
  assert.deepEqual(g.map(x => [x.path, x.parts?.map(p => p.path), x.manifest?.path]), [['a/x.zip', ['a/x.zip.part001', 'a/x.zip.part002'], 'a/x.zip.parts.json'], ['a/y.pdf', undefined, undefined]]);
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

function repo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-'));
  fs.cpSync(path.join(__dirname, '../data-template'), tmp, { recursive: true });
  const run = (...a) => execFileSync('node', a, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const runFail = (...a) => { try { run(...a); return { code: 0, out: '' }; } catch (e) { return { code: e.status, out: e.stdout + e.stderr }; } };
  return { tmp, run, runFail, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
const P = 'projects/primer-ograzhdenie';

test('хранилище: split → validate; манифест обязателен и совпадает с записью; порча части и лишний целый файл ловятся', () => {
  const r = repo();
  const src = path.join(r.tmp, 'big.bin'); fs.writeFileSync(src, crypto.randomBytes(52 * MB));
  const rp = `${P}/files/docs/r-b1c5e9d3b7f5-big.bin`;
  const ref = JSON.parse(r.run('tools/split-file.mjs', src, rp)); fs.unlinkSync(src);
  assert.ok(fs.existsSync(path.join(r.tmp, rp + '.parts.json')), 'манифест создан');
  const dj = path.join(r.tmp, P, 'documents.json'); const d = JSON.parse(fs.readFileSync(dj, 'utf8'));
  d.documents[0].revisions.push({ id: 'r-b1c5e9d3b7f5', rev: 'R99', status: 'Не проверено', date: '2026-11-11', author: 'Claude', file: ref });
  fs.writeFileSync(dj, JSON.stringify(d, null, 2));
  assert.match(r.run('tools/validate.mjs'), /Проверка пройдена/);
  const man = path.join(r.tmp, rp + '.parts.json'), manText = fs.readFileSync(man, 'utf8');
  fs.unlinkSync(man); assert.match(r.runFail('tools/validate.mjs').out, /нет манифеста/);
  const m2 = JSON.parse(manText); m2.name = 'другое.bin'; fs.writeFileSync(man, JSON.stringify(m2));
  assert.match(r.runFail('tools/validate.mjs').out, /не совпадает с манифестом/);
  const m3 = JSON.parse(manText); m3.schema = 999; fs.writeFileSync(man, JSON.stringify(m3));
  assert.match(r.runFail('tools/validate.mjs').out, /манифест .*schema должна быть 1/);
  delete m3.schema; fs.writeFileSync(man, JSON.stringify(m3));
  assert.match(r.runFail('tools/validate.mjs').out, /манифест .*schema должна быть 1/);
  fs.writeFileSync(man, '{не json'); assert.match(r.runFail('tools/validate.mjs').out, /манифест .*ошибка JSON/);
  fs.writeFileSync(man, manText);
  assert.match(r.run('tools/validate.mjs'), /Проверка пройдена/);
  fs.writeFileSync(path.join(r.tmp, rp), 'x'); assert.match(r.runFail('tools/validate.mjs').out, /хранится частями/); fs.unlinkSync(path.join(r.tmp, rp));
  const p2 = path.join(r.tmp, rp + '.part002'); const b = fs.readFileSync(p2); b[0] ^= 1; fs.writeFileSync(p2, b);
  assert.match(r.runFail('tools/validate.mjs').out, /часть 2: sha256/);
  r.done();
});

test('хранилище: рабочий файл частями проверяется по манифесту; часть без манифеста — ошибка', () => {
  const r = repo();
  const src = path.join(r.tmp, 'w.bin'); fs.writeFileSync(src, crypto.randomBytes(51 * MB));
  const rp = `${P}/files/work/raschet.bin`;
  r.run('tools/split-file.mjs', src, rp);
  assert.match(r.run('tools/validate.mjs'), /Проверка пройдена/);
  fs.unlinkSync(path.join(r.tmp, rp + '.part002'));
  assert.match(r.runFail('tools/validate.mjs').out, /часть 2.*не найден/);
  fs.unlinkSync(path.join(r.tmp, rp + '.parts.json'));
  assert.match(r.runFail('tools/validate.mjs').out, /часть без манифеста/);
  r.done();
});

test('join-file: собирает только по манифесту; при любой ошибке файл назначения не трогается', () => {
  const r = repo();
  const data = crypto.randomBytes(52 * MB), src = path.join(r.tmp, 'big.bin'); fs.writeFileSync(src, data);
  const rp = `${P}/files/work/big.bin`;
  r.run('tools/split-file.mjs', src, rp); fs.unlinkSync(src);
  const out = path.join(r.tmp, 'joined.bin');
  assert.match(r.run('tools/join-file.mjs', rp, out), /sha256 совпал/);
  assert.ok(fs.readFileSync(out).equals(data));
  const saved = path.join(r.tmp, 'saved.bin'); fs.writeFileSync(saved, 'VALUABLE');
  let x = r.runFail('tools/join-file.mjs', `${P}/files/work/net-takogo.bin`, saved);   // нет манифеста
  assert.equal(x.code, 1); assert.match(x.out, /нет манифеста/); assert.equal(fs.readFileSync(saved, 'utf8'), 'VALUABLE');
  const p2 = path.join(r.tmp, rp + '.part002'), p2b = fs.readFileSync(p2);
  fs.unlinkSync(p2);                                                                    // пропущенная часть
  x = r.runFail('tools/join-file.mjs', rp, saved);
  assert.equal(x.code, 1); assert.match(x.out, /часть 2 из 3 не найдена/); assert.equal(fs.readFileSync(saved, 'utf8'), 'VALUABLE');
  const bad = Buffer.from(p2b); bad[0] ^= 1; fs.writeFileSync(p2, bad);                // испорченная часть
  x = r.runFail('tools/join-file.mjs', rp, saved);
  assert.equal(x.code, 1); assert.match(x.out, /повреждена/); assert.equal(fs.readFileSync(saved, 'utf8'), 'VALUABLE');
  fs.writeFileSync(p2, p2b);
  x = r.runFail('tools/join-file.mjs', rp, rp + '.part001');                           // назначение = часть
  assert.equal(x.code, 1); assert.match(x.out, /совпадает с частью/);
  assert.deepEqual(fs.readdirSync(r.tmp).filter(f => f.includes('.tmp-')), [], 'временные файлы удалены');
  r.done();
});

test('split-file: больше 2 ГБ — отказ до создания частей', () => {
  const r = repo();
  const huge = path.join(r.tmp, 'huge.bin'); const fd = fs.openSync(huge, 'w'); fs.ftruncateSync(fd, 2 * 1024 * MB + 1); fs.closeSync(fd);  // разреженный файл
  const rp = `${P}/files/work/huge.bin`;
  const x = r.runFail('tools/split-file.mjs', huge, rp);
  assert.equal(x.code, 2); assert.match(x.out, /больше предела/);
  assert.equal(fs.existsSync(path.join(r.tmp, rp + '.part001')), false);
  r.done();
});

test('замена файла убирает прежнее представление в том же коммите (small↔large, large→меньше частей)', async () => {
  const O = await mod('ops.js');
  const L = 'projects/x/files/work/f.bin', parts = n => Array.from({ length: n }, (_, i) => `${L}.part00${i + 1}`);
  const build = async (treePaths, uploads) => {
    const tree = new Map(treePaths.map(p => [p, { sha: 'old' }]));
    const ch = await O.buildChanges('x', { type: 'writeFile', uploads: uploads.map(path => ({ path, key: path })), replace: [L] }, async () => undefined, async u => 'new:' + u.key, tree);
    return { del: ch.filter(c => c.delete).map(c => c.path).sort(), put: ch.filter(c => !c.delete).map(c => c.path).sort() };
  };
  let r = await build([L], [...parts(3), L + '.parts.json']);                         // small → large
  assert.deepEqual(r.del, [L]); assert.equal(r.put.length, 4);
  r = await build([...parts(3), L + '.parts.json'], [L]);                             // large → small
  assert.deepEqual(r.del, [...parts(3), L + '.parts.json'].sort()); assert.deepEqual(r.put, [L]);
  r = await build([...parts(3), L + '.parts.json'], [...parts(2), L + '.parts.json']); // large → меньше частей
  assert.deepEqual(r.del, [L + '.part003']);
  const del = await O.buildChanges('x', { type: 'deleteFile', path: L }, async () => undefined, null, new Map([...parts(2), L + '.parts.json', 'projects/x/files/work/other'].map(p => [p, {}])));
  assert.deepEqual(del.map(c => c.path).sort(), [...parts(2), L + '.parts.json'].sort());
});
