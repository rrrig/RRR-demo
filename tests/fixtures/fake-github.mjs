// Поддельный GitHub REST API в памяти — ровно те запросы, которые делает r05/pro/github.js.
// Работает и в Node (тесты), и в браузере (Playwright: файл подключается как обычный скрипт,
// последняя строка `export {…}` при этом вырезается).
//
//   const gh = createFakeGitHub({ files: { 'projects/x/project.json': '{…}' } });
//   globalThis.fetch = gh.fetch;
//   gh.aiCommit({ author: 'Claude', message: '[Claude] Чат', files: { path: 'текст' | Uint8Array | null } });
//   gh.openPR({ author: 'ChatGPT', title: '[ChatGPT] …', files: {…} });
//   gh.offline = true;                     // fetch бросает TypeError, как Safari без сети
//   gh.beforeRefUpdate = () => gh.aiCommit(…)  // «одновременная» правка между чтением и записью

const enc = new TextEncoder(), dec = new TextDecoder();

function sha1Hex(bytes) {
  const ml = bytes.length, withPad = ((ml + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(withPad); m.set(bytes); m[ml] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(withPad - 8, Math.floor(ml / 0x20000000), false); dv.setUint32(withPad - 4, (ml * 8) >>> 0, false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let o = 0; o < withPad; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4, false);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(x => x.toString(16).padStart(8, '0')).join('');
}
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const bin = atob(String(s).replace(/\s/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
const toBytes = v => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : enc.encode(String(v)));

function createFakeGitHub({ owner = 'rrrig', repo = 'RRR', branch = 'main', files = {}, token = null, now = () => new Date() } = {}) {
  const blobs = new Map();    // sha → Uint8Array
  const trees = new Map();    // sha → Map(path → blobSha)
  const commits = new Map();  // sha → {sha, tree, parents, message, author:{name,date}}
  const refs = new Map();     // имя ветки → sha коммита
  const pulls = [];           // {number, title, body, user, state, merged, head:{ref,sha}, base:{ref,sha}, created_at}
  const comments = [];        // {issue, body}
  const runs = new Map();     // sha → [{status, conclusion}]
  const requests = [];        // журнал запросов: "GET /git/ref/heads/main"
  let tick = 0;

  function putBlob(bytes) { bytes = toBytes(bytes); const sha = sha1Hex(new Uint8Array([...enc.encode(`blob ${bytes.length}\0`), ...bytes])); blobs.set(sha, bytes); return sha; }
  function putTree(map) {
    const sorted = new Map([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const sha = sha1Hex(enc.encode('tree ' + JSON.stringify([...sorted])));
    trees.set(sha, sorted); return sha;
  }
  function putCommit({ tree, parents, message, author = 'Дмитрий' }) {
    const date = new Date(now().getTime() + tick++ * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    const sha = sha1Hex(enc.encode(`commit ${tree} ${parents.join(',')} ${message} ${date} ${tick}`));
    commits.set(sha, { sha, tree, parents, message, author: { name: author, date } });
    return sha;
  }
  const treeOf = commitSha => trees.get(commits.get(commitSha).tree);
  function applyFiles(base, changes) {
    const map = new Map(base);
    for (const [path, v] of Object.entries(changes)) { if (v === null) map.delete(path); else map.set(path, putBlob(v)); }
    return map;
  }

  // начальное состояние
  refs.set(branch, putCommit({ tree: putTree(applyFiles(new Map(), files)), parents: [], message: 'Начальная структура', author: 'Claude' }));

  // ---------- помощники для тестов ----------
  const api = {
    owner, repo, branch, blobs, trees, commits, refs, pulls, comments, runs, requests,
    offline: false, beforeRefUpdate: null, failNext: null, nextNumber: 1,
    head: () => refs.get(branch),
    paths: (ref = branch) => [...treeOf(refs.get(ref) || ref).keys()],
    bytes(path, ref = branch) { const sha = treeOf(refs.get(ref) || ref).get(path); return sha ? blobs.get(sha) : undefined; },
    read(path, ref = branch) { const b = api.bytes(path, ref); return b && dec.decode(b); },
    json(path, ref = branch) { const t = api.read(path, ref); return t === undefined ? undefined : JSON.parse(t); },
    log: () => { const out = []; let c = refs.get(branch); while (c) { out.push(commits.get(c)); c = commits.get(c).parents[0]; } return out; },
    // Прямой коммит в main (например, ИИ добавил сообщение чата).
    aiCommit({ author = 'Claude', message, files: ch }) {
      const parent = refs.get(branch);
      const sha = putCommit({ tree: putTree(applyFiles(treeOf(parent), ch)), parents: [parent], message: message || `[${author}] Правка`, author });
      refs.set(branch, sha); return sha;
    },
    // Предложение ИИ: ветка от текущего main + pull request.
    openPR({ author = 'Claude', title, body = '', files: ch, branchName, check = null }) {
      const base = refs.get(branch), number = api.nextNumber++;
      const ref = branchName || `ai/${author.toLowerCase()}/pr-${number}`;
      const sha = putCommit({ tree: putTree(applyFiles(treeOf(base), ch)), parents: [base], message: title, author });
      refs.set(ref, sha);
      const pr = { number, title, body, user: { login: author === 'Claude' ? 'claude[bot]' : 'chatgpt-codex[bot]' }, state: 'open', merged: false, mergeable: true, head: { ref, sha }, base: { ref: branch, sha: base }, created_at: new Date(now().getTime() + tick++ * 1000).toISOString().replace(/\.\d+Z$/, 'Z') };
      pulls.push(pr);
      if (check) runs.set(sha, [check === 'pending' ? { status: 'in_progress', conclusion: null } : { status: 'completed', conclusion: check }]);
      return pr;
    },
    fetch: (url, init) => handle(url, init),
  };

  // ---------- HTTP ----------
  const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const fail = (status, message) => json(status, { message, documentation_url: 'https://docs.github.com/rest' });
  const treeEntries = map => {
    const out = [], dirs = new Set();
    for (const [path, sha] of map) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!dirs.has(d)) { dirs.add(d); out.push({ path: d, mode: '040000', type: 'tree', sha: sha1Hex(enc.encode('dir ' + d)) }); } }
      out.push({ path, mode: '100644', type: 'blob', sha, size: blobs.get(sha).length, url: `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}` });
    }
    return out;
  };
  const isAncestor = (anc, sha) => { const stack = [sha]; while (stack.length) { const c = stack.pop(); if (c === anc) return true; stack.push(...(commits.get(c)?.parents || [])); } return false; };
  function diff(baseMap, headMap) {
    const out = [];
    for (const [path, sha] of headMap) {
      const old = baseMap.get(path);
      if (old === sha) continue;
      out.push(fileDiff(path, old, sha));
    }
    for (const [path, sha] of baseMap) if (!headMap.has(path)) out.push(fileDiff(path, sha, undefined));
    return out;
  }
  function fileDiff(path, oldSha, newSha) {
    const text = sha => { if (!sha) return null; const b = blobs.get(sha); return b.includes(0) ? undefined : dec.decode(b); };
    const a = text(oldSha), b = text(newSha);
    const status = !oldSha ? 'added' : !newSha ? 'removed' : 'modified';
    const al = a ? a.replace(/\n$/, '').split('\n') : [], bl = b ? b.replace(/\n$/, '').split('\n') : [];
    let patch;
    if (a !== undefined && b !== undefined) {
      let p = 0; while (p < al.length && p < bl.length && al[p] === bl[p]) p++;
      let s = 0; while (s < al.length - p && s < bl.length - p && al[al.length - 1 - s] === bl[bl.length - 1 - s]) s++;
      const ctx = al.slice(Math.max(0, p - 3), p), del = al.slice(p, al.length - s), add = bl.slice(p, bl.length - s), post = al.slice(al.length - s, al.length - s + 3);
      const start = Math.max(0, p - 3);
      patch = `@@ -${al.length ? start + 1 : 0},${ctx.length + del.length + post.length} +${bl.length ? start + 1 : 0},${ctx.length + add.length + post.length} @@\n` +
        [...ctx.map(l => ' ' + l), ...del.map(l => '-' + l), ...add.map(l => '+' + l), ...post.map(l => ' ' + l)].join('\n');
    }
    let additions = status === 'removed' ? 0 : bl.length, deletions = status === 'added' ? 0 : al.length;
    if (patch !== undefined) { additions = (patch.match(/^\+/gm) || []).length; deletions = (patch.match(/^-/gm) || []).length; }
    return { sha: newSha || oldSha, filename: path, status, additions, deletions, changes: additions + deletions, ...(patch !== undefined ? { patch } : {}) };
  }

  async function handle(url, init = {}) {
    if (api.offline) throw new TypeError('Load failed');
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const prefix = `/repos/${owner}/${repo}`;
    const path = decodeURIComponent(u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname);
    requests.push(method + ' ' + path + u.search);
    if (api.failNext) { const f = api.failNext; api.failNext = null; const r = typeof f === 'function' ? f(method, path) : f; if (r === 'network') throw new TypeError('Load failed'); if (r) return fail(r.status, r.message || 'Ошибка'); }
    const headers = init.headers || {};
    const auth = headers.Authorization || headers.authorization;
    if (token && auth !== 'Bearer ' + token) return fail(401, 'Bad credentials');
    if (!u.pathname.startsWith(prefix)) return fail(404, 'Not Found');
    const body = init.body ? JSON.parse(init.body) : null;
    const q = u.searchParams;
    let m;

    if (method === 'GET' && path === '') return json(200, { full_name: `${owner}/${repo}`, name: repo, private: true, default_branch: branch, permissions: { admin: true, push: true, pull: true } });

    if (method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(path))) {
      const sha = refs.get(m[1]); if (!sha) return fail(404, 'Not Found');
      return json(200, { ref: 'refs/heads/' + m[1], object: { sha, type: 'commit' } });
    }
    if (method === 'PATCH' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(path))) {
      if (api.beforeRefUpdate) { const fn = api.beforeRefUpdate; api.beforeRefUpdate = null; await fn(); }
      const cur = refs.get(m[1]); if (!cur) return fail(422, 'Reference does not exist');
      if (!commits.has(body.sha)) return fail(422, 'Object does not exist');
      if (!body.force && !isAncestor(cur, body.sha)) return fail(422, 'Update is not a fast forward');
      refs.set(m[1], body.sha);
      return json(200, { ref: 'refs/heads/' + m[1], object: { sha: body.sha, type: 'commit' } });
    }
    if (method === 'GET' && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path))) {
      const c = commits.get(m[1]); if (!c) return fail(404, 'Not Found');
      return json(200, { sha: c.sha, tree: { sha: c.tree }, parents: c.parents.map(sha => ({ sha })), message: c.message, author: { ...c.author, email: 'x@example.com' } });
    }
    if (method === 'POST' && path === '/git/commits') {
      if (!trees.has(body.tree)) return fail(422, 'Tree SHA does not exist');
      for (const p of body.parents || []) if (!commits.has(p)) return fail(422, 'Parent SHA does not exist');
      const author = /^\s*\[([^\]]+)\]/.exec(body.message || '')?.[1] || 'Дмитрий';
      const sha = putCommit({ tree: body.tree, parents: body.parents || [], message: body.message, author });
      return json(201, { sha, tree: { sha: body.tree }, message: body.message });
    }
    if (method === 'GET' && (m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path))) {
      const t = trees.get(m[1]); if (!t) return fail(404, 'Not Found');
      if (q.get('recursive') !== '1') return fail(400, 'fake: only recursive trees are supported');
      return json(200, { sha: m[1], tree: treeEntries(t), truncated: false });
    }
    if (method === 'POST' && path === '/git/trees') {
      const base = body.base_tree ? trees.get(body.base_tree) : new Map();
      if (!base) return fail(422, 'base_tree is not a valid tree');
      const map = new Map(base);
      for (const e of body.tree || []) {
        if (!e.path || e.path.startsWith('/') || e.path.split('/').some(x => !x || x === '..' || x === '.')) return fail(422, 'tree.path contains a malformed path component');
        if (e.sha === null) { if (!map.has(e.path)) return fail(422, `GitRPC::BadObjectState: ${e.path} does not exist`); map.delete(e.path); }
        else if (e.sha) { if (!blobs.has(e.sha)) return fail(422, 'tree.sha ' + e.sha + ' is not a valid blob'); map.set(e.path, e.sha); }
        else if (typeof e.content === 'string') map.set(e.path, putBlob(e.content));
        else return fail(422, 'Must supply tree.sha or tree.content');
      }
      const sha = putTree(map);
      return json(201, { sha, tree: treeEntries(map), truncated: false });
    }
    if (method === 'GET' && (m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path))) {
      const b = blobs.get(m[1]); if (!b) return fail(404, 'Not Found');
      const accept = headers.Accept || headers.accept || '';
      if (/vnd\.github\.raw/.test(accept)) return new Response(b.slice(), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
      return json(200, { sha: m[1], size: b.length, encoding: 'base64', content: b64(b).replace(/(.{60})/g, '$1\n') });
    }
    if (method === 'POST' && path === '/git/blobs') {
      const bytes = body.encoding === 'base64' ? unb64(body.content) : enc.encode(body.content);
      return json(201, { sha: putBlob(bytes) });
    }

    if (method === 'GET' && path === '/pulls') {
      const state = q.get('state') || 'open';
      return json(200, pulls.filter(p => state === 'all' || p.state === state).slice().reverse().map(p => ({ ...p })));
    }
    if ((m = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(path))) {
      const pr = pulls.find(p => p.number === +m[1]); if (!pr) return fail(404, 'Not Found');
      if (method === 'GET' && !m[2]) return json(200, { ...pr });
      if (method === 'GET' && m[2] === '/files') return json(200, diff(treeOf(pr.base.sha), treeOf(pr.head.sha)));
      if (method === 'PUT' && m[2] === '/merge') {
        if (pr.state !== 'open') return fail(405, 'Pull Request is not mergeable');
        if (body.sha && body.sha !== pr.head.sha) return fail(409, 'Head branch was modified. Review and try the merge again.');
        const mainSha = refs.get(branch), changes = diff(treeOf(pr.base.sha), treeOf(pr.head.sha));
        const mainTree = treeOf(mainSha), baseTree = treeOf(pr.base.sha), headTree = treeOf(pr.head.sha);
        const map = new Map(mainTree);
        for (const c of changes) {
          if (mainTree.get(c.filename) !== baseTree.get(c.filename) && mainTree.get(c.filename) !== headTree.get(c.filename)) { pr.mergeable = false; return fail(405, 'Pull Request is not mergeable'); }
          if (headTree.has(c.filename)) map.set(c.filename, headTree.get(c.filename)); else map.delete(c.filename);
        }
        const sha = putCommit({ tree: putTree(map), parents: [mainSha], message: body.commit_title || pr.title, author: 'Дмитрий' });
        refs.set(branch, sha); pr.state = 'closed'; pr.merged = true;
        return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
      }
      if (method === 'PATCH' && !m[2]) { if (body.state) pr.state = body.state; return json(200, { ...pr }); }
    }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/comments$/.exec(path))) {
      comments.push({ issue: +m[1], body: body.body });
      return json(201, { id: comments.length, body: body.body });
    }
    if (method === 'GET' && path === '/actions/runs') {
      const list = runs.get(q.get('head_sha')) || [];
      return json(200, { total_count: list.length, workflow_runs: list });
    }
    if (method === 'GET' && path === '/commits') {
      let c = refs.get(q.get('sha') || branch) || q.get('sha');
      if (!commits.has(c)) return fail(404, 'Not Found');
      const filter = q.get('path'), per = +(q.get('per_page') || 30), out = [];
      while (c && out.length < per) {
        const cm = commits.get(c), parent = cm.parents[0];
        const touched = !filter || (() => { const a = trees.get(cm.tree), b = parent ? treeOf(parent) : new Map(); for (const p of new Set([...a.keys(), ...b.keys()])) if ((p === filter || p.startsWith(filter + '/')) && a.get(p) !== b.get(p)) return true; return false; })();
        if (touched) out.push({ sha: cm.sha, commit: { message: cm.message, author: { ...cm.author, email: 'x@example.com' } }, author: { login: /claude/i.test(cm.author.name) ? 'claude[bot]' : 'rrrig' }, parents: cm.parents.map(sha => ({ sha })) });
        c = parent;
      }
      return json(200, out);
    }
    if (method === 'GET' && (m = /^\/commits\/([0-9a-f]{40})$/.exec(path))) {
      const cm = commits.get(m[1]); if (!cm) return fail(404, 'Not Found');
      return json(200, { sha: cm.sha, commit: { message: cm.message, author: cm.author }, files: cm.parents[0] ? diff(treeOf(cm.parents[0]), trees.get(cm.tree)) : [] });
    }
    return fail(404, `fake: ${method} ${path} не реализован`);
  }

  return api;
}

export { createFakeGitHub, sha1Hex };
