// R10: запуск без связи — r05/sw.js в изолированной среде с поддельными caches и fetch.
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');

const SCOPE = 'https://rrrig.github.io/RRR-demo/r05/';
const code = fs.readFileSync(path.join(__dirname, '../r05/sw.js'), 'utf8');

function resp(body, { status = 200, type = 'basic', redirected = false } = {}) {
  return { body, status, ok: status >= 200 && status < 300, type, redirected, clone() { return resp(body, { status, type, redirected }); } };
}
function setup(net) {
  const stores = new Map();
  const caches = {
    async open(n) { if (!stores.has(n)) stores.set(n, new Map()); const m = stores.get(n); return { put: async (k, r) => m.set(typeof k === 'string' ? k : k.url, r), match: async k => m.get(typeof k === 'string' ? k : k.url) }; },
    async keys() { return [...stores.keys()]; }, async delete(n) { return stores.delete(n); },
  };
  const handlers = {};
  const self = { location: new URL(SCOPE + 'sw.js'), registration: { scope: SCOPE }, clients: { claim: async () => {} }, skipWaiting: async () => {}, addEventListener: (t, f) => (handlers[t] = f) };
  const fetch = async req => net(typeof req === 'string' ? req : req.url);
  // Таймаут 5 с в тесте сокращён до 20 мс.
  const fastTimeout = (f, ms) => setTimeout(f, ms >= 5000 ? 20 : ms);
  vm.runInNewContext(code, { self, caches, fetch, URL, setTimeout: fastTimeout, clearTimeout, Promise, Error, Symbol });
  const run = async (type, ev) => { let p; handlers[type]({ ...ev, waitUntil: x => (p = x), respondWith: x => (p = x) }); return p; };
  const bg = [];
  const get = (url, mode = 'no-cors') => { let out = null; handlers.fetch({ request: { url, method: 'GET', mode }, respondWith: x => (out = x), waitUntil: x => bg.push(x) }); return out; };
  return { stores, run, get, settle: () => Promise.all(bg), cache: () => stores.get('ignis-pro-shell-v2') };
}

test('установка сохраняет оболочку приложения; недоступный файл не мешает остальным', async () => {
  const h = setup(url => url.endsWith('ignis-pro-512.png') ? Promise.reject(new Error('net')) : Promise.resolve(resp('ok:' + url)));
  await h.run('install', {});
  const keys = [...h.cache().keys()];
  assert.ok(keys.includes(SCOPE));
  assert.ok(keys.includes(SCOPE + 'pro/app.js?v=0.11.0'));
  assert.ok(keys.includes('https://rrrig.github.io/RRR-demo/assets/ignis-pro-180.png'));
  assert.ok(!keys.some(k => k.endsWith('512.png')));
});

test('при связи — свежая версия и обновление копии', async () => {
  let v = 'v1';
  const h = setup(() => Promise.resolve(resp(v)));
  assert.equal((await h.get(SCOPE + 'pro/app.js?v=0.11.0')).body, 'v1');
  v = 'v2';
  assert.equal((await h.get(SCOPE + 'pro/app.js?v=0.11.0')).body, 'v2');
  assert.equal(h.cache().get(SCOPE + 'pro/app.js?v=0.11.0').body, 'v2');
});

test('без связи и при блокировке сайта (404/503) открывается сохранённая копия', async () => {
  let mode = 'ok';
  const h = setup(() => mode === 'ok' ? Promise.resolve(resp('app')) : mode === 'down' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(resp('Not Found', { status: mode })));
  await h.get(SCOPE + '?v=0.8.0', 'navigate');           // старая ссылка с параметром
  mode = 'down'; assert.equal((await h.get(SCOPE, 'navigate')).body, 'app');
  mode = 404; assert.equal((await h.get(SCOPE + 'index.html', 'navigate')).body, 'app');
  mode = 503; assert.equal((await h.get(SCOPE + '?v=0.9.0', 'navigate')).body, 'app');
  assert.equal(h.cache().get(SCOPE).body, 'app', 'ошибка сайта не затирает копию');
});

test('GitHub API, POST и sw.js не перехватываются; нет копии и нет связи — ошибка сети', async () => {
  const h = setup(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.equal(h.get('https://api.github.com/repos/rrrig/RRR'), null);
  assert.equal(h.get(SCOPE + 'sw.js'), null);
  await assert.rejects(h.get(SCOPE + 'pro/zip.js'));
});

test('ответ с перенаправлением не сохраняется (Safari не открывает такие страницы из кэша)', async () => {
  const h = setup(() => Promise.resolve(resp('x', { redirected: true })));
  await h.get('https://rrrig.github.io/RRR-demo/r05', 'navigate');
  assert.equal(h.cache()?.size || 0, 0);
});

test('установка: перенаправление и ошибка сайта не сохраняются', async () => {
  const h = setup(url => Promise.resolve(url.endsWith('/r05/') ? resp('moved', { redirected: true }) : url.endsWith('zip.js') ? resp('nf', { status: 404 }) : resp('ok')));
  await h.run('install', {});
  const keys = [...h.cache().keys()];
  assert.ok(!keys.includes(SCOPE), 'страница с перенаправлением не сохранена');
  assert.ok(!keys.some(k => k.endsWith('zip.js')), '404 не сохранён');
  assert.ok(keys.includes(SCOPE + 'pro/app.js?v=0.11.0'));
});

test('медленная связь: показывается копия, а поздний ответ сайта обновляет её в фоне', async () => {
  let delay = 0, body = 'old';
  const h = setup(() => new Promise(r => setTimeout(() => r(resp(body)), delay)));
  await h.get(SCOPE + 'pro/app.js?v=0.11.0'); await h.settle();
  delay = 80; body = 'new';
  assert.equal((await h.get(SCOPE + 'pro/app.js?v=0.11.0')).body, 'old', 'после таймаута — сохранённая копия');
  await h.settle();
  assert.equal(h.cache().get(SCOPE + 'pro/app.js?v=0.11.0').body, 'new', 'поздний ответ обновил копию');
});

test('медленная связь без копии — ждём сайт, а не ошибку', async () => {
  const h = setup(() => new Promise(r => setTimeout(() => r(resp('slow')), 60)));
  assert.equal((await h.get(SCOPE + 'pro/ops.js')).body, 'slow');
});
