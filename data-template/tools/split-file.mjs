#!/usr/bin/env node
// Разбить большой файл (> 50 МБ) на части для хранилища и получить готовую запись «file».
// Использование (из корня репозитория):
//   node tools/split-file.mjs <исходный файл> <путь в репозитории>
// Пример:
//   node tools/split-file.mjs ~/El17_History.zip projects/el-17m/files/docs/r-1a2b3c4d5e6f-el17-history.zip
// Части пишутся рядом с путём: <путь>.part001, .part002, … по 20 МБ (последняя — остаток).
// В stdout — JSON для поля «file» (path, name, size, sha256, parts); вставьте его в documents.json или sources.json.
// Файлы до 50 МБ не делятся — их кладут целиком.
import { createHash } from 'node:crypto';
import { open, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_FILE_BYTES, PART_BYTES, MAX_PARTS, partPath, validFilePath } from './model.js';

const [src, repoPath] = process.argv.slice(2);
if (!src || !repoPath) { console.error('Использование: node tools/split-file.mjs <исходный файл> <путь в репозитории>'); process.exit(2); }
if (!validFilePath(repoPath)) { console.error(`Неверный путь «${repoPath}»: projects/<папка>/files/<docs|sources|chat|work>/<имя>`); process.exit(2); }
const { size } = await stat(src);
if (size <= MAX_FILE_BYTES) { console.error(`Файл ${size} байт — не больше 50 МБ, делить не нужно: положите его целиком.`); process.exit(2); }
const count = Math.ceil(size / PART_BYTES);
if (count > MAX_PARTS) { console.error(`Слишком большой файл: ${count} частей (предел ${MAX_PARTS}).`); process.exit(2); }

await mkdir(path.dirname(repoPath), { recursive: true });
const fh = await open(src, 'r');
const whole = createHash('sha256'), parts = [];
try {
  for (let i = 0; i < count; i++) {
    const len = Math.min(PART_BYTES, size - i * PART_BYTES);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, i * PART_BYTES);
    if (bytesRead !== len) throw new Error('файл изменился во время чтения');
    whole.update(buf);
    const p = partPath(repoPath, i);
    const out = await open(p, 'w'); try { await out.writeFile(buf); } finally { await out.close(); }
    parts.push({ path: p, size: len, sha256: createHash('sha256').update(buf).digest('hex') });
  }
} finally { await fh.close(); }
console.log(JSON.stringify({ path: repoPath, name: path.basename(src), size, sha256: whole.digest('hex'), parts }, null, 2));
