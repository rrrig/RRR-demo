#!/usr/bin/env node
// Собрать большой файл из частей (например, в копии хранилища на компьютере).
// Использование (из корня репозитория):
//   node tools/join-file.mjs <путь в репозитории> [куда сохранить]
// Пример:
//   node tools/join-file.mjs projects/el-17m/files/docs/r-1a2b3c4d5e6f-el17-history.zip ~/Desktop/El17_History.zip
// Сверяет sha256 с записью в documents.json / sources.json проекта, если она найдена.
import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { partPath } from './model.js';

const [repoPath, dest0] = process.argv.slice(2);
if (!repoPath) { console.error('Использование: node tools/join-file.mjs <путь в репозитории> [куда сохранить]'); process.exit(2); }
const folder = repoPath.split('/').slice(0, 2).join('/');
let ref = null;
for (const f of ['documents.json', 'sources.json']) {
  try {
    const j = JSON.parse(await readFile(path.join(folder, f), 'utf8'));
    for (const x of j.documents?.flatMap(d => d.revisions || []) || j.sources || []) if (x.file?.path === repoPath) ref = x.file;
  } catch {}
}
const dest = dest0 || (ref?.name ? path.join(process.cwd(), ref.name) : path.basename(repoPath));
const out = await open(dest, 'w'), h = createHash('sha256');
let i = 0, total = 0;
try {
  for (;; i++) {
    const p = partPath(repoPath, i);
    try { await stat(p); } catch { break; }
    for await (const chunk of createReadStream(p)) { h.update(chunk); await out.write(chunk); total += chunk.length; }
  }
} finally { await out.close(); }
if (!i) { console.error(`Частей «${repoPath}.part001…» не найдено`); process.exit(1); }
const sum = h.digest('hex');
if (ref?.sha256 && ref.sha256 !== sum) { console.error(`Ошибка: sha256 собранного файла ${sum} не совпадает с записью ${ref.sha256}`); process.exit(1); }
console.log(`Собрано ${i} частей, ${total} байт → ${dest}${ref?.sha256 ? ' (sha256 совпал)' : ''}`);
