// ИГНИС ПРО: ZIP-архив проекта (r05/pro/zip.js), проверка через python3 zipfile.
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('node:path');
const fs = require('node:fs'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const { loadESModule } = require('./load-module.cjs');
const zip = () => loadESModule(path.join(__dirname, '../r05/pro/zip.js'));

test('CRC32: контрольный вектор "123456789" → cbf43926', async () => {
  const { crc32 } = await zip();
  assert.equal(crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926');
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')).toString(16), '414fa339');
});

test('ZIP открывается python zipfile: русские имена, двоичные данные, пустой файл, testzip без ошибок', async t => {
  try { execFileSync('python3', ['--version']); } catch { return t.skip('нет python3'); }
  const { makeZip } = await zip();
  const big = new Uint8Array(300000); for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 255;
  const files = [
    { name: 'project.json', bytes: new TextEncoder().encode('{"name":"Ограждение Ø3000"}\n') },
    { name: 'files/docs/r-1-чертёж.pdf', bytes: big },
    { name: 'files/work/empty.txt', bytes: new Uint8Array(0) },
  ];
  const blob = makeZip(files, new Date(2026, 10, 9, 14, 30, 58));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-zip-')), file = path.join(dir, 'p.zip');
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const out = execFileSync('python3', ['-I', '-c', `
import zipfile, json, sys, hashlib
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "items": [[i.filename, i.file_size, i.date_time, hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()]}, ensure_ascii=False))
`, file], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.bad, null);
  const sha = b => require('node:crypto').createHash('sha256').update(b).digest('hex');
  assert.deepEqual(r.items.map(x => [x[0], x[1], x[3]]), files.map(f => [f.name, f.bytes.length, sha(f.bytes)]));
  assert.deepEqual(r.items[0][2], [2026, 11, 9, 14, 30, 58]);
  fs.rmSync(dir, { recursive: true, force: true });
});
