// Клиент GitHub REST API для репозитория данных.
// Все записи — одним коммитом (Git Data API) с проверкой, что основа не изменилась.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message, body, network = false) { super(message); this.status = status; this.body = body; this.network = network; }
}
// Нет связи (запрос не дошёл до GitHub) — изменение можно отложить и отправить позже.
export const isNetworkError = e => !!(e && e.network);
// Временная причина (связь, токен, лимит, сбой GitHub) — изменение остаётся в очереди без пометки об ошибке.
export const isTemporaryError = e => isNetworkError(e) || [401, 403, 429, 500, 502, 503, 504].includes(e?.status);

function b64encodeBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64decodeText(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

// Общий предел одновременных запросов к GitHub для всего приложения (все клиенты, синхронизация,
// чат, массовые операции): не больше 2. Место освобождается только после чтения ответа целиком.
export const MAX_CONCURRENT = 2;
let active = 0;
const waiting = [];
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));      // место передаётся из release()
}
function release() { const next = waiting.shift(); if (next) next(); else active--; }
export const inFlight = () => active;

export function createClient({ owner, repo, token, branch = 'main', fetch: f = globalThis.fetch.bind(globalThis) }) {
  const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const blobCache = new Map();

  async function req(method, path, body, opts = {}) {
    await acquire();
    try { return await send(method, path, body, opts); }
    finally { release(); }
  }
  async function send(method, path, body, { accept = 'application/vnd.github+json', raw = false, abs = false } = {}) {
    let res;
    try {
      res = await f(abs ? path : base + path, {
        method,
        headers: { Accept: accept, Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (e) {
      throw new GitHubError(0, 'Нет связи с GitHub. Проверьте интернет.', null, true);
    }
    if (!res.ok) {
      let data = null; try { data = await res.json(); } catch {}
      const msg = data?.message || res.statusText;
      if (res.status === 409 && /empty/i.test(msg)) throw new GitHubError(409, 'Репозиторий пустой — в нём ещё нет ни одной правки.', data);
      const human = {
        401: 'Токен не принят GitHub. Проверьте или замените его в настройках.',
        403: /rate limit/i.test(msg) ? 'Превышен лимит запросов GitHub, повторите через несколько минут.' : 'Недостаточно прав у токена: ' + msg,
        404: 'Не найдено (проверьте имя репозитория и доступ токена): ' + msg,
        409: 'Конфликт версий: ' + msg,
        422: 'GitHub отклонил изменение: ' + msg,
      }[res.status] || `Ошибка GitHub ${res.status}: ${msg}`;
      throw new GitHubError(res.status, human, data);
    }
    if (res.status === 204) return null;
    return await (raw ? res.arrayBuffer() : res.json());
  }

  async function head() {
    const ref = await req('GET', `/git/ref/heads/${encodeURIComponent(branch)}`);
    const commit = await req('GET', `/git/commits/${ref.object.sha}`);
    return { commit: ref.object.sha, tree: commit.tree.sha };
  }

  async function tree(sha) {
    const t = await req('GET', `/git/trees/${sha}?recursive=1`);
    if (t.truncated) throw new GitHubError(-1, 'Репозиторий слишком большой для чтения одним запросом');
    return t.tree.filter(e => e.type === 'blob');
  }

  async function blobText(sha) {
    if (blobCache.has(sha)) return blobCache.get(sha);
    const b = await req('GET', `/git/blobs/${sha}`);
    const text = b.encoding === 'base64' ? b64decodeText(b.content) : b.content;
    blobCache.set(sha, text);
    return text;
  }

  async function blobBytes(sha) {
    return req('GET', `/git/blobs/${sha}`, null, { accept: 'application/vnd.github.raw', raw: true });
  }

  async function createBlob(bytes) {
    const blob = await req('POST', '/git/blobs', { content: b64encodeBytes(bytes), encoding: 'base64' });
    return blob.sha;
  }

  // changes: [{path, text}|{path, bytes:Uint8Array}|{path, sha}|{path, delete:true}]
  async function commit({ message, changes, parent }) {
    const entries = [];
    for (const c of changes) {
      if (c.delete) entries.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
      else if (c.sha) entries.push({ path: c.path, mode: '100644', type: 'blob', sha: c.sha });
      else if (c.bytes) entries.push({ path: c.path, mode: '100644', type: 'blob', sha: await createBlob(c.bytes) });
      else entries.push({ path: c.path, mode: '100644', type: 'blob', content: c.text });
    }
    const t = await req('POST', '/git/trees', { base_tree: parent.tree, tree: entries });
    const cm = await req('POST', '/git/commits', { message, tree: t.sha, parents: [parent.commit] });
    await req('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: cm.sha, force: false });
    return cm.sha;
  }

  // Повторяемая запись: build(read) получает текущие данные и возвращает изменения.
  // Если основная ветка ушла вперёд (кто-то принял предложение ИИ), запись строится заново.
  async function mutate(message, build, { attempts = 3 } = {}) {
    for (let i = 0; ; i++) {
      const h = await head();
      const files = new Map((await tree(h.tree)).map(e => [e.path, e]));
      const read = async path => { const e = files.get(path); return e ? blobText(e.sha) : undefined; };
      const all = await build({ read, files, head: h });
      // Убрать «изменения», которые ничего не меняют, — чтобы не плодить пустые правки.
      const changes = [];
      for (const c of all) {
        const e = files.get(c.path);
        if (c.delete ? !e : c.sha ? e?.sha === c.sha : c.text !== undefined && e && await read(c.path) === c.text) continue;
        changes.push(c);
      }
      if (!changes.length) return null;
      try { return await commit({ message, changes, parent: h }); }
      catch (e) { if (e.status === 422 && i + 1 < attempts) continue; throw e; }
    }
  }

  const pulls = () => req('GET', '/pulls?state=open&per_page=50');
  const pull = n => req('GET', `/pulls/${n}`);
  const pullFiles = n => req('GET', `/pulls/${n}/files?per_page=100`);
  const merge = (n, sha, title) => req('PUT', `/pulls/${n}/merge`, { merge_method: 'squash', sha, commit_title: title });
  async function close(n, comment) {
    if (comment) await req('POST', `/issues/${n}/comments`, { body: comment });
    return req('PATCH', `/pulls/${n}`, { state: 'closed' });
  }
  const comment = (n, body) => req('POST', `/issues/${n}/comments`, { body });
  async function checks(sha) {
    try {
      const r = await req('GET', `/actions/runs?head_sha=${sha}&per_page=10`);
      const runs = r.workflow_runs || [];
      if (!runs.length) return 'none';
      if (runs.some(x => x.status !== 'completed')) return 'pending';
      return runs.every(x => x.conclusion === 'success' || x.conclusion === 'skipped') ? 'success' : 'failure';
    } catch { return 'unknown'; }
  }
  const commits = (path, n = 30) => req('GET', `/commits?sha=${encodeURIComponent(branch)}&per_page=${n}${path ? '&path=' + encodeURIComponent(path) : ''}`);
  const commitInfo = sha => req('GET', `/commits/${sha}`);
  async function treeAt(commitSha) { const c = await req('GET', `/git/commits/${commitSha}`); return tree(c.tree.sha); }
  const repoInfo = () => req('GET', '');
  const contentsPath = p => encPath(p);

  return { owner, repo, branch, req, head, tree, blobText, blobBytes, createBlob, commit, mutate, pulls, pull, pullFiles, merge, close, comment, checks, commits, commitInfo, treeAt, repoInfo, contentsPath };
}
