// Запуск ИГНИС ПРО (r05/index.html + r05/pro/app.js) в jsdom с поддельным GitHub и IndexedDB.
const fs = require('node:fs'); const path = require('node:path'); const { webcrypto } = require('node:crypto');
const { JSDOM } = require(process.env.RRR_JSDOM_PATH || 'jsdom');
const FIDB = require(process.env.RRR_FIDB_PATH || 'fake-indexeddb');
const PRO = path.join(__dirname, '../../r05/pro');

// Модули приложения как data:-URL; cache.js — каждый раз новый экземпляр (своя база).
let nonce = 0;
function moduleURL(file, fresh, seen = new Map()) {
  if (seen.has(file)) return seen.get(file);
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(/(\bfrom\s+)['"](\.[^'"]+)['"]/g, (w, pre, rel) => pre + JSON.stringify(moduleURL(path.resolve(path.dirname(file), rel.split('?')[0]), fresh, seen)));
  if (fresh) src += `\n// ${file} ${++nonce}`;
  const url = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
  seen.set(file, url); return url;
}

async function until(fn, what = 'условие', ms = 4000) {
  const t0 = Date.now();
  for (;;) { let v; try { v = fn(); } catch {} if (v) return v; if (Date.now() - t0 > ms) throw new Error('Не дождались: ' + what); await new Promise(r => setTimeout(r, 10)); }
}

async function launch({ settings = { token: 'tok' }, fake, hash = '#/', fetchWrap } = {}) {
  const { createFakeGitHub } = await import(path.join(__dirname, 'fake-github.mjs'));
  const { templateFiles } = await import(path.join(__dirname, 'template-seed.mjs'));
  const gh = fake || createFakeGitHub({ files: templateFiles(), token: 'tok' });
  // Модули работают в глобальном окружении Node: им нужны fetch и IndexedDB.
  globalThis.indexedDB = new FIDB.IDBFactory();
  Object.assign(globalThis, { IDBRequest: FIDB.IDBRequest, IDBKeyRange: FIDB.IDBKeyRange });
  const netLog = [];
  globalThis.fetch = (url, init) => { netLog.push(url); return (fetchWrap ? fetchWrap(gh.fetch) : gh.fetch)(url, init); };
  const mods = {};
  for (const name of ['model.js', 'github.js', 'ops.js', 'cache.js', 'zip.js']) {
    const fresh = name === 'cache.js';
    mods['./' + name] = await import(moduleURL(path.join(PRO, name), fresh));
  }
  const html = fs.readFileSync(path.join(PRO, '../index.html'), 'utf8').replace(/<script type="module"[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { url: 'https://rrrig.github.io/RRR-demo/r05/' + hash, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, $ = id => w.document.getElementById(id);
  const errors = [], confirms = [], urls = new Map();
  let confirmValue = true;
  w.localStorage.setItem('ignis-pro-settings', JSON.stringify(settings));
  w.confirm = m => { confirms.push(m); return confirmValue; };
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.URL.createObjectURL = b => { const id = 'blob:' + urls.size; urls.set(id, b); return id; };
  w.URL.revokeObjectURL = () => {};
  if (!w.crypto?.subtle) Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
  w.__mods = mods;
  w.addEventListener('error', e => errors.push(e.error || e.message));
  w.addEventListener('unhandledrejection', e => errors.push(e.reason));
  let src = fs.readFileSync(path.join(PRO, 'app.js'), 'utf8');
  src = src.replace(/^import \* as (\w+) from '([^']+)';$/gm, (w0, n, f) => `const ${n} = window.__mods[${JSON.stringify(f.split('?')[0])}];`)
           .replace(/^import \{([^}]+)\} from '([^']+)';$/gm, (w0, n, f) => `const {${n}} = window.__mods[${JSON.stringify(f.split('?')[0])}];`);
  if (/^import /m.test(src)) throw new Error('Не все import заменены');
  try { w.eval(src); } catch (e) { errors.push(e); throw e; }
  await until(() => w.document.body.dataset.ready === 'true', 'запуск');
  const h = {
    w, $, gh, dom, errors, confirms, netLog, urls, until,
    confirm(v) { confirmValue = v; },
    text: () => $('view').textContent.replace(/\s+/g, ' '),
    go: async (hash, wait) => { w.location.hash = hash; await new Promise(r => setTimeout(r, 20)); if (wait) await until(() => h.text().includes(wait), wait); },
    idle: () => until(() => !$('sync').classList.contains('spin'), 'конец загрузки'),
    click: async sel => { const el = typeof sel === 'string' ? w.document.querySelector(sel) : sel; if (!el) throw new Error('нет элемента ' + sel); el.click(); await new Promise(r => setTimeout(r, 20)); },
    // Заполнить форму шторки и нажать «Готово»
    sheet: async values => {
      for (const [k, v] of Object.entries(values)) { const el = $('sheetBody').querySelector(`[name="${k}"]`); if (!el) throw new Error('нет поля ' + k); el.value = v; }
      $('sheetForm').requestSubmit(); await new Promise(r => setTimeout(r, 30));
    },
    close: () => { dom.window.close(); },
  };
  return h;
}
module.exports = { launch, until };
