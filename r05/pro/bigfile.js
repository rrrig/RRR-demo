// ИГНИС ПРО — большие файлы (больше 50 МБ) частями по 20 МБ: разбиение при загрузке и сборка
// при открытии и скачивании. Формат записи — model.js (file.parts); проверка в хранилище —
// tools/validate.mjs. Части обрабатываются по одной, чтобы не держать весь файл в памяти дважды.
import { Sha256 } from '../sha256.js';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_PARTS, PART_BYTES, partPath, wholeOf, manifestOf, validateManifest } from './model.js';

const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const sha256Of = async buf => hex(await globalThis.crypto.subtle.digest('SHA-256', buf));

export const needsParts = size => size > MAX_FILE_BYTES;

// Разбить файл (File/Blob) на части. onPart(part, bytes) вызывается для каждой части по порядку
// (например, сохранить на телефоне до отправки). Возвращает запись «file» с parts.
export async function splitBlob(blob, path, name, onPart, onProgress) {
  const size = blob.size;
  if (!needsParts(size)) throw new Error('Файл до 50 МБ хранится целиком');
  if (size > MAX_TOTAL_BYTES) throw new Error(`Файл «${name}» больше 2 ГБ`);
  const count = Math.ceil(size / PART_BYTES);
  if (count > MAX_PARTS) throw new Error(`Файл «${name}» слишком большой: ${count} частей`);
  const whole = new Sha256(), parts = [];
  for (let i = 0; i < count; i++) {
    const bytes = await blob.slice(i * PART_BYTES, Math.min(size, (i + 1) * PART_BYTES)).arrayBuffer();
    whole.update(new Uint8Array(bytes));
    const part = { path: partPath(path, i), size: bytes.byteLength, sha256: await sha256Of(bytes) };
    await onPart(part, bytes);
    parts.push(part);
    onProgress?.(i + 1, count);
  }
  return { path, name, size, sha256: whole.digestHex(), parts };
}

// Собрать файл строго по манифесту: getBytes(path) → ArrayBuffer части или null.
// Сверяются: манифест, наличие и порядок всех частей, размер и sha256 каждой части, общий размер
// и sha256 целого файла. Любое расхождение — ошибка (неполный или испорченный файл не выдаётся).
export async function assembleParts(manifest, getBytes, onProgress) {
  const errs = validateManifest(manifest, manifest?.path);
  if (errs.length) throw new Error('Описание частей файла неверно: ' + errs[0]);
  const whole = new Sha256(), pieces = [], parts = manifest.parts;
  let total = 0;
  for (const [i, pt] of parts.entries()) {
    const bytes = await getBytes(pt.path);
    if (!bytes) throw new Error(`Часть ${i + 1} из ${parts.length} не найдена`);
    if (bytes.byteLength !== pt.size) throw new Error(`Часть ${i + 1}: размер ${bytes.byteLength} вместо ${pt.size}`);
    if ((await sha256Of(bytes)) !== pt.sha256) throw new Error(`Часть ${i + 1} повреждена (sha256 не совпал)`);
    whole.update(new Uint8Array(bytes)); total += bytes.byteLength;
    pieces.push(new Blob([bytes]));
    onProgress?.(i + 1, parts.length);
  }
  if (total !== manifest.size) throw new Error(`Размер собранного файла ${total} вместо ${manifest.size}`);
  if (whole.digestHex() !== manifest.sha256) throw new Error('Собранный файл не совпал по sha256');
  return new Blob(pieces);
}

// Пути файлов → логические файлы: части «x.part001…» и манифест «x.parts.json» объединяются в «x».
// У группы: parts — элементы-части, manifest — элемент манифеста (если есть).
export function groupParts(items, key = x => x.path) {
  const out = [], byPath = new Map();
  for (const it of items) {
    const p = key(it), whole = wholeOf(p);
    if (!whole) { out.push({ path: p, item: it, parts: null }); continue; }
    let g = byPath.get(whole);
    if (!g) { g = { path: whole, item: it, parts: [], manifest: null }; byPath.set(whole, g); out.push(g); }
    if (manifestOf(p)) g.manifest = it; else g.parts.push(it);
  }
  for (const g of byPath.values()) g.parts.sort((a, b) => key(a).localeCompare(key(b)));
  return out;
}
