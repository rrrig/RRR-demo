#!/usr/bin/env node
// Собрать большой файл из частей (например, в копии хранилища на компьютере).
// Использование (из корня репозитория):
//   node tools/join-file.mjs <путь в репозитории> [куда сохранить]
// Пример:
//   node tools/join-file.mjs projects/el-17m/files/docs/r-1a2b3c4d5e6f-el17-history.zip ~/Desktop/El17_History.zip
// Сборка идёт только по манифесту <путь>.parts.json: проверяются все части (наличие, размер, sha256),
// общий размер и sha256 целого файла. Файл собирается во временный и заменяет назначение только
// после полной проверки — при любой ошибке существующий файл назначения не трогается.
import { createHash } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { manifestPath, validateManifest } from './model.js';

const fail = msg => { console.error('Ошибка: ' + msg); process.exit(1); };
const [repoPath, dest0] = process.argv.slice(2);
if (!repoPath) { console.error('Использование: node tools/join-file.mjs <путь в репозитории> [куда сохранить]'); process.exit(2); }

let manifest;
try { manifest = JSON.parse(await readFile(manifestPath(repoPath), 'utf8')); }
catch (e) { fail(e.code === 'ENOENT' ? `нет манифеста «${manifestPath(repoPath)}» — собрать файл без него нельзя` : `манифест не прочитан: ${e.message}`); }
const errs = validateManifest(manifest, repoPath);
if (errs.length) fail('манифест неверен: ' + errs.join('; '));

const dest = path.resolve(dest0 || manifest.name || path.basename(repoPath));
const inputs = new Set([manifestPath(repoPath), ...manifest.parts.map(p => p.path)].map(p => path.resolve(p)));
if (inputs.has(dest)) fail('файл назначения совпадает с частью или манифестом');

const tmp = `${dest}.tmp-${process.pid}`;
const out = await open(tmp, 'wx'), whole = createHash('sha256');
let total = 0, ok = false;
try {
  for (const [i, pt] of manifest.parts.entries()) {
    let st; try { st = await stat(pt.path); } catch { throw new Error(`часть ${i + 1} из ${manifest.parts.length} не найдена: ${pt.path}`); }
    if (st.size !== pt.size) throw new Error(`часть ${i + 1}: размер ${st.size} вместо ${pt.size}`);
    const h = createHash('sha256');
    for await (const chunk of createReadStream(pt.path)) { h.update(chunk); whole.update(chunk); await out.write(chunk); total += chunk.length; }
    if (h.digest('hex') !== pt.sha256) throw new Error(`часть ${i + 1} повреждена (sha256 не совпал)`);
  }
  if (total !== manifest.size) throw new Error(`размер ${total} вместо ${manifest.size}`);
  if (whole.digest('hex') !== manifest.sha256) throw new Error('sha256 собранного файла не совпал с манифестом');
  ok = true;
} catch (e) { await out.close(); await rm(tmp, { force: true }); fail(e.message); }
finally { if (ok) await out.close(); }
await rename(tmp, dest);
console.log(`Собрано ${manifest.parts.length} частей, ${total} байт → ${dest} (sha256 совпал)`);
