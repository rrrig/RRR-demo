// Локальная копия на телефоне (IndexedDB): последняя версия репозитория,
// содержимое файлов по sha и очередь изменений, сделанных без связи.
const DB = 'ignis-pro-cache';
const STORES = ['kv', 'blobs', 'outbox', 'uploads'];
let opening;

function open(idb = globalThis.indexedDB) {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, s === 'outbox' ? { keyPath: 'seq', autoIncrement: true } : undefined); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { opening = null; reject(r.error); };
  });
  return opening;
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Запись отменена'));
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const get = (store, key) => tx(store, 'readonly', s => s.get(key));
export const put = (store, key, value) => tx(store, 'readwrite', s => (key === null ? s.put(value) : s.put(value, key)));
export const del = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export async function all(store) {
  const db = await open();
  return req(db.transaction(store, 'readonly').objectStore(store).getAll());
}
export async function keys(store) {
  const db = await open();
  return req(db.transaction(store, 'readonly').objectStore(store).getAllKeys());
}
export async function usage() {
  try { const e = await navigator.storage?.estimate?.(); return e || null; } catch { return null; }
}
export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
