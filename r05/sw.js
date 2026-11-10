// ИГНИС ПРО — запуск без связи.
// Приложение (страницы, скрипты, стили, иконки) сохраняется на телефоне. При каждом открытии
// сначала берётся свежая версия с сайта; если сайт недоступен (нет связи, ошибка, блокировка
// GitHub Pages) — открывается последняя сохранённая. Данные проектов здесь не хранятся:
// они в IndexedDB приложения (pro/cache.js). Запросы к другим сайтам (api.github.com и др.)
// не перехватываются.
const CACHE = 'ignis-pro-shell-v1';
const SHELL = [
  './',
  './pro/app.js?v=0.10.0',
  './pro/styles.css?v=0.10.0',
  './pro/model.js',
  './pro/github.js',
  './pro/ops.js',
  './pro/cache.js',
  './pro/zip.js',
  './manifest.webmanifest?v=0.10.0',
  '../assets/ignis-pro-180.png',
  '../assets/ignis-pro-192.png',
  '../assets/ignis-pro-512.png',
];
const TIMEOUT_MS = 5000;

// Ключ кэша: страницы — без параметров (?v=0.8.0 и ./index.html = «./»), остальное — как есть.
function cacheKey(request) {
  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    url.search = ''; url.hash = '';
    if (url.pathname.endsWith('/index.html')) url.pathname = url.pathname.slice(0, -'index.html'.length);
  }
  return url.href;
}

// Сохранять можно только полноценный ответ своего сайта: 200–299, не перенаправление.
// 404/5xx (например, при блокировке GitHub Pages) и редиректы не затирают рабочую копию.
const cacheable = r => !!r && r.ok && r.type === 'basic' && !r.redirected;
const TIMEOUT = Symbol('timeout');

// Возвращает ответ пользователю и отдельную фоновую задачу: запрос к сайту продолжается после
// таймаута и обновляет копию, даже если пользователю уже показана сохранённая версия.
function handle(request) {
  const key = cacheKey(request);
  const cacheP = caches.open(CACHE);
  const net = fetch(request).then(async r => {
    if (cacheable(r)) await (await cacheP).put(key, r.clone());
    return r;
  });
  const background = net.catch(() => {});
  const response = (async () => {
    const cache = await cacheP;
    let r;
    try {
      r = await Promise.race([net, new Promise(res => setTimeout(() => res(TIMEOUT), TIMEOUT_MS))]);
    } catch (e) {
      const saved = await cache.match(key);
      if (saved) return saved;
      throw e;
    }
    if (r === TIMEOUT) return (await cache.match(key)) || net;   // нет копии — ждём сайт
    if (cacheable(r)) return r;
    return (await cache.match(key)) || r;
  })();
  return { response, background };
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // По одному: недоступный файл не должен отменять сохранение остальных.
    for (const path of SHELL) {
      try {
        const url = new URL(path, self.registration.scope).href;
        const r = await fetch(url, { cache: 'no-cache' });
        if (cacheable(r)) await cache.put(url, r);
      } catch {}
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('ignis-pro-shell-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;            // GitHub API и другие сайты — напрямую
  if (url.pathname.endsWith('/sw.js')) return;
  const { response, background } = handle(request);
  event.respondWith(response);
  event.waitUntil(background);
});
