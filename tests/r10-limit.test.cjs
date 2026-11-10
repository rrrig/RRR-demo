// R10: общий предел одновременных запросов к GitHub — не больше 2 на всё приложение,
// включая чтение тела ответа и одновременную работу нескольких клиентов (синхронизация + копия).
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('node:path');
const { loadESModule } = require('./load-module.cjs');
const gh = () => loadESModule(path.join(__dirname, '../r05/pro/github.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function slowFetch(stats, { failEvery = 0 } = {}) {
  let n = 0;
  return async () => {
    stats.cur++; stats.peak = Math.max(stats.peak, stats.cur); const k = ++n;
    await sleep(15);
    const done = () => { stats.cur--; };
    if (failEvery && k % failEvery === 0) { done(); throw new TypeError('Failed to fetch'); }
    return {
      ok: true, status: 200, statusText: 'OK',
      arrayBuffer: async () => { await sleep(15); done(); return new ArrayBuffer(4); },   // тело читается дольше заголовков
      json: async () => { await sleep(15); done(); return { object: { sha: 'a' }, tree: { sha: 'b' } }; },
    };
  };
}

test('синхронизация и массовая загрузка вместе — не больше 2 запросов одновременно', async () => {
  const m = await gh(); const stats = { cur: 0, peak: 0 };
  const f = slowFetch(stats);
  const bulk = m.createClient({ owner: 'rrrig', repo: 'RRR', token: 't', fetch: f });
  const sync = m.createClient({ owner: 'rrrig', repo: 'RRR', token: 't', fetch: f });   // другой экземпляр клиента
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => bulk.blobBytes('sha' + i)),
    sync.head(), sync.head(), sync.req('GET', '/pulls'),
  ]);
  assert.equal(stats.peak, 2);
  assert.equal(m.inFlight(), 0);
});

test('ошибка связи освобождает место — очередь не зависает', async () => {
  const m = await gh(); const stats = { cur: 0, peak: 0 };
  const c = m.createClient({ owner: 'rrrig', repo: 'RRR', token: 't', fetch: slowFetch(stats, { failEvery: 2 }) });
  const res = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => c.blobBytes('s' + i)));
  assert.equal(res.filter(r => r.status === 'rejected').length, 3);
  assert.ok(res.filter(r => r.status === 'rejected').every(r => r.reason.network));
  assert.ok(stats.peak <= 2);
  assert.equal(m.inFlight(), 0);
});
