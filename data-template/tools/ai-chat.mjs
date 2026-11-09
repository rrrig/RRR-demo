#!/usr/bin/env node
// ИИ-участник чата проекта ИГНИС ПРО (GitHub Actions, workflow ai-chat.yml).
//
// Что делает:
//   1. Находит новые сообщения чата (projects/<slug>/chat/*.json), добавленные пушем BEFORE..AFTER.
//   2. Для сообщений человека с упоминанием @Claude / @ChatGPT / @все вызывает нужный ИИ по API.
//   3. Ответ ИИ записывает новым сообщением чата прямо в main.
//   4. Если ИИ предложил правки данных проекта — проверяет их и открывает pull request (ветка ai/<ии>/chat-<id>).
//   5. Если ИИ в ответе упомянул другого ИИ — тот отвечает в этом же запуске (не более 2 переходов ИИ↔ИИ).
//
// Окружение: ANTHROPIC_API_KEY, OPENAI_API_KEY, CLAUDE_MODEL, OPENAI_MODEL, GITHUB_TOKEN, GITHUB_REPOSITORY,
//   BEFORE, AFTER, INPUT_PROJECT, INPUT_WHO, DRY_RUN=1 (без push и GitHub API — только локальные коммиты).
// Node >= 22, без зависимостей.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PROJECT_FILES, APPROVED, chatFileName, newChatMessage, validateChatMessage, mentionsIn,
  validFilePath, validateFile, approvalChanges, today,
} from './model.js';

// ---------- Константы ----------
export const AIS = Object.freeze(['Claude', 'ChatGPT']);
export const BOT_AUTHOR = 'ИИ-бот';
export const NON_HUMAN = Object.freeze([...AIS, BOT_AUTHOR]);
export const REPLY_MENTIONS = Object.freeze(['Claude', 'ChatGPT', 'Дмитрий']);
export const MAX_HOPS = 2;          // переходов ИИ↔ИИ на одно сообщение человека
export const MAX_CALLS = 6;         // вызовов моделей за запуск
export const MAX_CHANGE_BYTES = 1024 * 1024;
export const TEXT_EXT = Object.freeze(['txt', 'md', 'csv', 'json', 'scad', 'py', 'js', 'dxf', 'svg', 'gcode', 'nc']);
const WORK_FILE_MAX = 30 * 1024;
const WORK_TOTAL_MAX = 150 * 1024;
const JSON_FILE_MAX = 40 * 1024;
const CHAT_LAST = 40;
const CHAT_TEXT_MAX = 4000;
const MAX_REPLY = 19000;
const ZERO_SHA = /^0+$/;
const CHAT_PATH = /^projects\/([a-z0-9][a-z0-9-]{0,60})\/chat\/([^/]+\.json)$/;

const isAuthorNonHuman = a => typeof a !== 'string' || NON_HUMAN.includes(a) || /bot\b|бот/i.test(a);
const lower = who => who === 'ChatGPT' ? 'chatgpt' : 'claude';
const ord = list => AIS.filter(a => list.includes(a));

// ---------- Вспомогательное ----------
export function truncate(s, max, note = '…(сокращено)') {
  s = String(s ?? '');
  return s.length > max ? s.slice(0, max) + '\n' + note : s;
}

export function sanitizeError(e, secrets = []) {
  let s = String(e?.message || e || 'неизвестная ошибка');
  for (const k of secrets) if (k && k.length > 6) s = s.split(k).join('***');
  s = s.replace(/\b(sk|ghp|gho|ghs|github_pat)[-_][A-Za-z0-9_\-]{6,}/g, '***').replace(/\s+/g, ' ').trim();
  return s.slice(0, 300);
}

function readJsonSafe(file) {
  try { let raw = readFileSync(file, 'utf8'); if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); return JSON.parse(raw); } catch { return undefined; }
}

function walk(dir, rel = '') {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// ---------- Git ----------
export function git(root, args, { input, env, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: root, input, env: env ? { ...process.env, ...env } : process.env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args[0]}: ${String(e.stderr || e.message).trim().slice(0, 500)}`);
  }
}

const hasCommit = (root, ref) => !!ref && git(root, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { allowFail: true });

// Пути файлов чата, добавленных между before и after.
export function addedChatPaths(root, before, after, { fetch = false } = {}) {
  after = after || 'HEAD';
  // main мог уйти вперёд, пока запуск ждал в очереди, — догружаем нужный коммит.
  if (!hasCommit(root, after) && fetch) git(root, ['fetch', '--no-tags', '--depth=2', 'origin', after], { allowFail: true });
  let list = null;
  if (before && !ZERO_SHA.test(before)) {
    if (!hasCommit(root, before) && fetch) git(root, ['fetch', '--no-tags', '--depth=1', 'origin', before], { allowFail: true });
    if (hasCommit(root, before)) list = git(root, ['diff', '--name-only', '--diff-filter=A', '--no-renames', before, after], { allowFail: true });
  }
  if (list === null) {
    // Новая ветка, BEFORE пустой или недоступен — берём файлы, добавленные последним коммитом.
    list = git(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '--diff-filter=A', '--no-renames', '-r', after], { allowFail: true }) || '';
  }
  return list.split('\n').map(s => s.trim()).filter(p => CHAT_PATH.test(p)).sort();
}

// ---------- Чат ----------
export function readChat(root, slug) {
  const dir = path.join(root, 'projects', slug, 'chat');
  let names = [];
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = readJsonSafe(path.join(dir, n));
    if (m && !validateChatMessage(m, slug).length) out.push({ ...m, _file: n });
  }
  // Имя файла точно до секунды — внутри одной секунды упорядочиваем по полному времени.
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a._file.localeCompare(b._file)));
}

export function triggerMentions(msg) {
  const fromField = Array.isArray(msg.mentions) ? msg.mentions.filter(x => AIS.includes(x)) : [];
  return ord([...fromField, ...mentionsIn(String(msg.text || ''))]);
}

// Начальная очередь: по одной задаче на каждый упомянутый ИИ, Claude первым.
export function planJobs(messages) {
  const jobs = [];
  for (const { slug, msg, file } of messages) {
    if (!msg || isAuthorNonHuman(msg.author)) continue;
    for (const who of triggerMentions(msg)) jobs.push({ who, slug, trigger: msg, triggerFile: file, rootId: msg.id, hop: 0 });
  }
  return jobs;
}

// Следующие задачи после ответа ИИ: другой ИИ, если его упомянули, с ограничением переходов.
export function nextJobs(job, reply, queue, { maxHops = MAX_HOPS } = {}) {
  const out = [];
  const mentioned = ord([...(reply.mentions || []), ...mentionsIn(String(reply.text || ''))]);
  for (const other of mentioned) {
    if (other === job.who) continue;
    if (job.hop + 1 > maxHops) continue;
    if (queue.some(q => q.rootId === job.rootId && q.who === other)) continue; // уже ждёт своей очереди — увидит ответ в контексте
    out.push({ who: other, slug: job.slug, trigger: reply, triggerFile: chatFileName(reply), rootId: job.rootId, hop: job.hop + 1 });
  }
  return out;
}

// ---------- Контекст ----------
export function agentsEssential(text) {
  if (!text) return '';
  const parts = String(text).split(/^(?=## )/m);
  const keep = parts.filter(p => !/^## .*(Перед началом|Порядок внесения|Проверка)/.test(p));
  return truncate(keep.join('').trim(), 18000);
}

export function buildContext({ root, slug, prs = [], agentsText }) {
  const pdir = path.join(root, 'projects', slug);
  const out = [];
  const sec = (title, body) => out.push(`### ${title}\n${body}\n`);

  for (const f of PROJECT_FILES) {
    let raw = '';
    try { raw = readFileSync(path.join(pdir, f), 'utf8'); } catch { raw = '(файл отсутствует)'; }
    sec(`${f}`, '```json\n' + truncate(raw.trim(), JSON_FILE_MAX, '…(файл сокращён — при правке этого файла будьте осторожны: нужно передать полное содержимое)') + '\n```');
  }

  const filesRoot = path.join(pdir, 'files');
  const all = walk(filesRoot);
  const listing = all.slice(0, 300).map(r => { let s = 0; try { s = statSync(path.join(filesRoot, r)).size; } catch {} return `- projects/${slug}/files/${r} — ${s} байт`; });
  if (all.length > 300) listing.push(`… и ещё ${all.length - 300} файлов`);
  sec('Файлы проекта (files/)', listing.length ? listing.join('\n') : '(нет файлов)');

  let total = 0; const work = [];
  for (const r of all.filter(r => r.startsWith('work/') && !r.slice(5).includes('/'))) {
    const ext = r.split('.').pop().toLowerCase();
    if (!TEXT_EXT.includes(ext)) continue;
    const abs = path.join(filesRoot, r);
    let size = 0; try { size = statSync(abs).size; } catch { continue; }
    if (size > WORK_FILE_MAX) { work.push(`#### projects/${slug}/files/${r}\n(больше 30 КБ — содержимое не включено)`); continue; }
    if (total + size > WORK_TOTAL_MAX) { work.push(`#### projects/${slug}/files/${r}\n(пропущено: превышен общий объём 150 КБ)`); continue; }
    total += size;
    work.push(`#### projects/${slug}/files/${r}\n\`\`\`\n${readFileSync(abs, 'utf8')}\n\`\`\``);
  }
  if (work.length) sec('Рабочие текстовые файлы (files/work/)', work.join('\n\n'));

  const chat = readChat(root, slug).slice(-CHAT_LAST);
  sec(`Чат проекта (последние ${CHAT_LAST} сообщений, старые сверху)`, chat.length ? chat.map(m => {
    const files = (m.files || []).map(f => f.name || f.path).join(', ');
    return `[${m.id}] ${m.date} — ${m.author}${m.replyTo ? ` (ответ на ${m.replyTo})` : ''}:\n${truncate(m.text || '', CHAT_TEXT_MAX)}${files ? `\nВложения: ${files}` : ''}`;
  }).join('\n\n') : '(сообщений нет)');

  sec('Открытые pull request’ы по этому проекту', prs.length ? prs.map(p => `- ${p}`).join('\n') : '(нет или не удалось получить)');
  if (agentsText) sec('Правила репозитория (AGENTS.md, главное)', agentsEssential(agentsText));
  return out.join('\n');
}

// ---------- Промпт ----------
export function systemPrompt(who) {
  const other = who === 'Claude' ? 'ChatGPT' : 'Claude';
  return [
    `Ты — ${who}, инженерный партнёр Дмитрия (ООО «ИГНИС»: металлоконструкции, новогоднее и декоративное оформление города, фрезер ЧПУ). Ты работаешь вместе с ${other} в общем чате проекта: Дмитрий, ${who} и ${other}.`,
    'Как работать:',
    '- Будь точен: проверяй расчёты, единицы, размеры и сортамент; явно отделяй проверенное от допущений. Не выдумывай цены, нормы и факты — если не уверен, так и скажи и предложи, как проверить.',
    '- Думай о дизайне и красоте изделия, о себестоимости и о простоте изготовления (резка, гибка, сварка, ЧПУ, окраска, монтаж).',
    '- Отвечай кратко и по делу, по-русски. Без воды и повторов.',
    `- Если в чате есть мнение ${other}, ответь на его доводы явно: с чем согласен, с чем нет и почему.`,
    `- Чтобы попросить ${other} что-то проверить, упомяни @${other} в тексте и добавь "${other}" в mentions. Не делай этого без нужды.`,
    '- Никогда не ставь и не снимай статус «Разрешено к выдаче» — это делает только Дмитрий.',
    '- Предлагай правки файлов проекта только когда тебя об этом просят или это явно нужно; правка уходит Дмитрию на проверку как pull request.',
  ].join('\n');
}

export function userPrompt({ who, slug, projectName, context, trigger }) {
  return [
    `Сегодня ${today()}. Проект «${projectName}» (папка projects/${slug}).`,
    '',
    '## Данные проекта',
    context,
    '',
    '## Сообщение, на которое нужно ответить',
    `[${trigger.id}] ${trigger.author}: ${truncate(trigger.text || '', 8000)}`,
    '',
    '## Формат ответа',
    'Верни ТОЛЬКО один JSON-объект, без пояснений до и после:',
    '{"reply": "текст ответа в чат", "mentions": [], "changes": [{"path": "...", "content": "полное новое содержимое"}], "pr_title": "...", "pr_body": "..."}',
    '- reply — ответ в чат (обычный текст, можно списки).',
    '- mentions — кого зовёшь: "Дмитрий", "Claude", "ChatGPT" (можно пусто).',
    `- changes — необязательно (по умолчанию []). Разрешены только: projects/${slug}/project.json, documents.json, tasks.json, sources.json, cost.json (ПОЛНОЕ новое содержимое файла, валидный JSON по правилам выше) и текстовые файлы projects/${slug}/files/work/<имя>.<${TEXT_EXT.join('|')}> (имя латиницей, без подпапок). Двоичные файлы нельзя.`,
    `- В изменённых записях: author/origin = "${who}", новые id в формате префикс-12hex, даты ГГГГ-ММ-ДД, сохраняй существующие id и чужие записи, обнови updated в project.json.`,
    '- pr_title — краткий заголовок предложения по-русски; pr_body — что изменено, почему, источники и допущения, открытые вопросы. Если changes пусто — pr_title и pr_body пустые.',
  ].join('\n');
}

// ---------- Разбор ответа модели ----------
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  const norm = o => {
    const reply = typeof o.reply === 'string' ? o.reply : (o.reply == null ? '' : String(o.reply));
    return {
      reply,
      mentions: Array.isArray(o.mentions) ? o.mentions.filter(x => typeof x === 'string') : [],
      changes: Array.isArray(o.changes) ? o.changes.filter(c => c && typeof c === 'object') : [],
      pr_title: typeof o.pr_title === 'string' ? o.pr_title.trim() : '',
      pr_body: typeof o.pr_body === 'string' ? o.pr_body : '',
      parsed: true,
    };
  };
  const tryParse = s => { try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) && ('reply' in o || 'changes' in o) ? o : null; } catch { return null; } };
  const candidates = [raw];
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  for (let m; (m = fence.exec(raw));) candidates.push(m[1].trim());
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(raw.slice(a, b + 1));
  for (const c of candidates) { const o = tryParse(c); if (o) return norm(o); }
  return { reply: raw, mentions: [], changes: [], pr_title: '', pr_body: '', parsed: false };
}

// ---------- Проверка предложенных изменений ----------
// readCurrent(path) → текущий текст файла или undefined; fileExists(path) → есть ли файл в репозитории.
export function validateChanges(changes, { slug, readCurrent = () => undefined, fileExists = () => true }) {
  const valid = [], errors = [];
  const seen = new Set();
  const changedPaths = new Set((changes || []).map(c => c && c.path));
  for (const ch of changes || []) {
    const p = ch && typeof ch.path === 'string' ? ch.path.trim() : '';
    const bad = msg => errors.push(`${p || '(без пути)'}: ${msg}`);
    if (!p) { bad('не указан путь'); continue; }
    if (seen.has(p)) { bad('повторная правка одного файла'); continue; }
    seen.add(p);
    if (p.includes('\\') || p.split('/').some(s => s === '..' || s === '.' || s === '') || path.posix.normalize(p) !== p) { bad('недопустимый путь'); continue; }
    let content = ch.content;
    const name = p.split('/').pop();
    const isJsonFile = p === `projects/${slug}/${name}` && PROJECT_FILES.includes(name);
    const isWork = !isJsonFile && p.startsWith(`projects/${slug}/files/work/`) && validFilePath(p, slug) && !name.startsWith('.');
    if (!isJsonFile && !isWork) { bad(`разрешены только 5 JSON-файлов проекта и текстовые файлы в projects/${slug}/files/work/`); continue; }
    if (isJsonFile && content && typeof content === 'object') content = JSON.stringify(content, null, 2) + '\n';
    if (typeof content !== 'string') { bad('content должен быть текстом'); continue; }
    if (Buffer.byteLength(content, 'utf8') > MAX_CHANGE_BYTES) { bad('больше 1 МБ'); continue; }
    if (isWork) {
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      if (!TEXT_EXT.includes(ext)) { bad(`расширение «${ext}» не разрешено (допустимо: ${TEXT_EXT.join(', ')})`); continue; }
      if (content.includes('\u0000')) { bad('двоичное содержимое'); continue; }
      if (readCurrent(p) === content) continue;
      valid.push({ path: p, content });
      continue;
    }
    let data;
    try { data = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content); } catch (e) { bad('ошибка JSON — ' + e.message); continue; }
    const errs = validateFile(name, data, slug);
    if (errs.length) { bad(errs.slice(0, 5).join('; ') + (errs.length > 5 ? `; и ещё ${errs.length - 5}` : '')); continue; }
    const curRaw = readCurrent(p);
    let cur; try { cur = curRaw === undefined ? undefined : JSON.parse(curRaw); } catch { cur = undefined; }
    if (name === 'documents.json') {
      const ap = approvalChanges(cur || { documents: [] }, data);
      if (ap.length) { bad(`изменена отметка «${APPROVED}» у редакций ${ap.join(', ')} — это может только Дмитрий`); continue; }
    }
    if (name === 'project.json' && cur && cur.id && data.id !== cur.id) { bad('нельзя менять id проекта'); continue; }
    if (name === 'documents.json' || name === 'sources.json') {
      const refs = name === 'documents.json'
        ? (data.documents || []).flatMap(d => (d.revisions || []).map(r => r.file)).filter(Boolean)
        : (data.sources || []).map(s => s.file).filter(Boolean);
      const missing = refs.map(f => f.path).filter(fp => typeof fp === 'string' && !changedPaths.has(fp) && !fileExists(fp));
      if (missing.length) { bad(`ссылки на несуществующие файлы: ${missing.join(', ')}`); continue; }
    }
    const out = JSON.stringify(data, null, 2) + '\n';
    if (curRaw !== undefined && (curRaw === content || curRaw === out)) continue; // без изменений
    valid.push({ path: p, content: out });
  }
  return { valid, errors };
}

// ---------- Сообщение-ответ ----------
export function makeReplyMessage({ author, text, mentions = [], replyTo, slug }) {
  let t = String(text || '').trim() || '(пустой ответ)';
  if (t.length > MAX_REPLY) t = t.slice(0, MAX_REPLY) + '\n…(ответ сокращён)';
  const ms = [...new Set((mentions || []).filter(x => REPLY_MENTIONS.includes(x) && x !== author))];
  const msg = newChatMessage({ author, text: t, mentions: ms, replyTo });
  const errors = validateChatMessage(msg, slug);
  if (errors.length) throw new Error('ответ не прошёл проверку: ' + errors.join('; '));
  return { msg, file: chatFileName(msg) };
}

// ---------- HTTP ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function httpJson(url, init, { timeoutMs, retries = 1, retryDelayMs = 5000, label }) {
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res, body;
    try {
      res = await globalThis.fetch(url, { ...init, signal: ac.signal });
      body = await res.text();
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e?.name === 'AbortError' ? `${label}: нет ответа за ${Math.round(timeoutMs / 1000)} с` : `${label}: сетевая ошибка (${e?.message || e})`);
    }
    clearTimeout(timer);
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : retryDelayMs);
      continue;
    }
    let json; try { json = JSON.parse(body); } catch { json = null; }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || body.slice(0, 200);
      throw new Error(`${label}: HTTP ${res.status} — ${String(msg).slice(0, 200)}`);
    }
    return json;
  }
}

export async function callModel(who, { system, user }, env) {
  const timeoutMs = Number(env.AI_TIMEOUT_MS) || 120000;
  const retryDelayMs = env.AI_RETRY_DELAY_MS !== undefined ? Number(env.AI_RETRY_DELAY_MS) : 5000;
  if (who === 'Claude') {
    const j = await httpJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 8000, system, messages: [{ role: 'user', content: user }] }),
    }, { timeoutMs, retryDelayMs, label: 'Anthropic API' });
    const text = (j?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) throw new Error('Anthropic API: пустой ответ' + (j?.stop_reason ? ` (${j.stop_reason})` : ''));
    return text;
  }
  const j = await httpJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: env.OPENAI_MODEL || 'gpt-5', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  }, { timeoutMs, retryDelayMs, label: 'OpenAI API' });
  const text = j?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI API: пустой ответ' + (j?.choices?.[0]?.finish_reason ? ` (${j.choices[0].finish_reason})` : ''));
  return text;
}

async function githubApi(env, method, p, body) {
  return httpJson(`https://api.github.com${p}`, {
    method,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'user-agent': 'ignis-ai-chat', ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }, { timeoutMs: 30000, retries: 1, retryDelayMs: 2000, label: 'GitHub API' });
}

export async function listOpenPrs(env, slug) {
  if (env.DRY_RUN === '1' || !env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return [];
  try {
    const prs = await githubApi(env, 'GET', `/repos/${env.GITHUB_REPOSITORY}/pulls?state=open&per_page=50`);
    const out = [];
    for (const pr of (prs || []).slice(0, 20)) {
      let touches = String(pr.head?.ref || '').includes(slug) || String(pr.title || '').includes(slug);
      if (!touches) {
        try { const files = await githubApi(env, 'GET', `/repos/${env.GITHUB_REPOSITORY}/pulls/${pr.number}/files?per_page=100`); touches = (files || []).some(f => String(f.filename).startsWith(`projects/${slug}/`)); } catch {}
      }
      if (touches) out.push(`#${pr.number} ${pr.title} (ветка ${pr.head?.ref}, автор ${pr.user?.login})`);
    }
    return out;
  } catch { return []; }
}

// ---------- Запись в репозиторий ----------
function commitAndPushMain(root, relPath, content, message, env, log) {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(root, ['add', '--', relPath]);
  git(root, ['commit', '-q', '-m', message, '--', relPath]);
  if (env.DRY_RUN === '1') return;
  for (let i = 1; ; i++) {
    if (git(root, ['push', '-q', 'origin', 'HEAD:main'], { allowFail: true }) !== null) return;
    if (i >= 3) throw new Error('не удалось отправить коммит в main после 3 попыток');
    log(`push отклонён, git pull --rebase (попытка ${i})`);
    git(root, ['pull', '-q', '--rebase', 'origin', 'main']);
  }
}

// Коммит изменений в отдельную ветку без переключения рабочей папки (через временный индекс).
function commitToBranch(root, branch, changes, message) {
  const idx = path.join(tmpdir(), `ai-chat-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    git(root, ['read-tree', 'HEAD'], { env });
    for (const c of changes) {
      const sha = git(root, ['hash-object', '-w', '--stdin'], { input: c.content });
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${sha},${c.path}`], { env });
    }
    const tree = git(root, ['write-tree'], { env });
    const commit = git(root, ['commit-tree', tree, '-p', 'HEAD', '-m', message]);
    git(root, ['update-ref', `refs/heads/${branch}`, commit]);
    return commit;
  } finally { rmSync(idx, { force: true }); }
}

async function proposeChanges({ root, env, who, slug, projectName, trigger, triggerFile, changes, model, log }) {
  let branch = `ai/${lower(who)}/chat-${trigger.id}`;
  for (let n = 2; hasCommit(root, `refs/heads/${branch}`) || (env.DRY_RUN !== '1' && git(root, ['ls-remote', '--heads', 'origin', branch], { allowFail: true })); n++) branch = `ai/${lower(who)}/chat-${trigger.id}-${n}`;
  let title = (model.pr_title || `Правки по чату проекта ${projectName}`).replace(/^\s*\[(Claude|ChatGPT)\]\s*/i, '').slice(0, 200);
  title = `[${who}] ${title}`;
  const commitMsg = `${title}\n\nПо сообщению ${trigger.id} в чате проекта ${slug}.`;
  commitToBranch(root, branch, changes, commitMsg);
  const link = env.GITHUB_REPOSITORY ? `https://github.com/${env.GITHUB_REPOSITORY}/blob/main/projects/${slug}/chat/${triggerFile}` : `projects/${slug}/chat/${triggerFile}`;
  const body = [
    `Предложение ${who} по сообщению в чате проекта «${projectName}»: [${trigger.id}](${link}) (${trigger.author}).`,
    '',
    model.pr_body || '',
    '',
    '**Изменённые файлы:**',
    ...changes.map(c => `- \`${c.path}\``),
    '',
    '_Создано автоматически (ai-chat). Принять или отклонить может только Дмитрий._',
  ].join('\n');
  if (env.DRY_RUN === '1') { log(`[DRY_RUN] ветка ${branch}, PR «${title}» не открыт`); return { number: 0, title, branch, body }; }
  git(root, ['push', '-q', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
  const pr = await githubApi(env, 'POST', `/repos/${env.GITHUB_REPOSITORY}/pulls`, { title, head: branch, base: 'main', body });
  return { number: pr.number, title, branch, body, url: pr.html_url };
}

function projectNameOf(root, slug) {
  const p = readJsonSafe(path.join(root, 'projects', slug, 'project.json'));
  return (p && typeof p.name === 'string' && p.name) || slug;
}

function postMessage({ root, slug, author, text, mentions, replyTo, commitPrefix, projectName, env, log }) {
  const { msg, file } = makeReplyMessage({ author, text, mentions, replyTo, slug });
  const rel = `projects/${slug}/chat/${file}`;
  commitAndPushMain(root, rel, JSON.stringify(msg, null, 2) + '\n', `[${commitPrefix}] Ответ в чате ${projectName}`, env, log);
  log(`записано сообщение ${rel}`);
  return { msg, file, rel };
}

// ---------- Один ответ ИИ ----------
export async function runJob(job, { root, env, state, log }) {
  const { who, slug, trigger } = job;
  const projectName = projectNameOf(root, slug);
  const keyName = who === 'Claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const secrets = [env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.GITHUB_TOKEN];

  if (!env[keyName]) {
    if (state.keyNotice.has(who + '/' + slug)) return null;
    state.keyNotice.add(who + '/' + slug);
    log(`${keyName} не задан — сообщение от ${BOT_AUTHOR}`);
    postMessage({ root, slug, author: BOT_AUTHOR, commitPrefix: BOT_AUTHOR, projectName, env, log, replyTo: trigger.id,
      text: `Ключ API для ${who} не настроен. Ответ можно получить вручную: откройте ${who} и напишите «проверь чат проекта ${projectName}».` });
    return null;
  }

  state.calls++;
  let modelText;
  try {
    const prs = await listOpenPrs(env, slug);
    const agentsText = existsSync(path.join(root, 'AGENTS.md')) ? readFileSync(path.join(root, 'AGENTS.md'), 'utf8') : '';
    const context = buildContext({ root, slug, prs, agentsText });
    log(`${who}: вызов модели (проект ${slug}, контекст ${context.length} символов, переход ${job.hop})`);
    modelText = await callModel(who, { system: systemPrompt(who), user: userPrompt({ who, slug, projectName, context, trigger }) }, env);
  } catch (e) {
    const short = sanitizeError(e, secrets);
    log(`${who}: ошибка — ${short}`);
    postMessage({ root, slug, author: BOT_AUTHOR, commitPrefix: BOT_AUTHOR, projectName, env, log, replyTo: trigger.id,
      text: `${who} не смог ответить: ${short}. Попробуйте позже (Actions → ai-chat → Run workflow) или спросите вручную: откройте ${who} и напишите «проверь чат проекта ${projectName}».` });
    return null;
  }

  const model = extractJson(modelText);
  let text = model.reply.trim();
  const readCurrent = p => { try { return readFileSync(path.join(root, p), 'utf8'); } catch { return undefined; } };
  const fileExists = p => existsSync(path.join(root, p));
  const { valid, errors } = validateChanges(model.changes, { slug, readCurrent, fileExists });
  if (errors.length) text += `\n\nЧасть предложенных изменений отклонена проверкой и не отправлена:\n${errors.map(e => '- ' + e).join('\n')}`;
  let pr = null;
  if (valid.length) {
    try {
      pr = await proposeChanges({ root, env, who, slug, projectName, trigger, triggerFile: job.triggerFile, changes: valid, model, log });
      text += `\n\nПредложение #${pr.number}: ${pr.title} — примите или отклоните в приложении.`;
    } catch (e) {
      text += `\n\nНе удалось открыть предложение с изменениями: ${sanitizeError(e, secrets)}`;
    }
  }
  const mentions = ord([...model.mentions, ...mentionsIn(model.reply)]).concat(model.mentions.includes('Дмитрий') ? ['Дмитрий'] : []);
  const posted = postMessage({ root, slug, author: who, commitPrefix: who, projectName, env, log, text, mentions, replyTo: trigger.id });
  return { ...posted, pr };
}

// ---------- Главный цикл ----------
export async function run({ root = process.cwd(), env = process.env, log = (...a) => console.log('[ai-chat]', ...a) } = {}) {
  const state = { calls: 0, keyNotice: new Set(), replies: [] };
  let jobs = [];

  if (env.INPUT_PROJECT) {
    const slug = String(env.INPUT_PROJECT).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug) || !existsSync(path.join(root, 'projects', slug))) throw new Error(`проект «${slug}» не найден`);
    const w = String(env.INPUT_WHO || 'Claude').trim();
    const whos = /^(оба|все|both|all)$/i.test(w) ? [...AIS] : [AIS.find(a => a.toLowerCase() === w.toLowerCase()) || 'Claude'];
    const chat = readChat(root, slug);
    const last = [...chat].reverse().find(m => !isAuthorNonHuman(m.author)) || chat[chat.length - 1];
    const trigger = last
      ? { ...last, text: `${last.text || ''}\n\n(Дмитрий вручную запросил ответ: прочитай чат и данные проекта и ответь по существу.)` }
      : { id: undefined, author: 'Дмитрий', text: 'Проверь проект и предложи, чем помочь.' };
    const triggerFile = last?._file || '';
    for (const who of whos) jobs.push({ who, slug, trigger, triggerFile, rootId: trigger.id || 'manual', hop: 0 });
  } else {
    const paths = addedChatPaths(root, env.BEFORE, env.AFTER, { fetch: env.DRY_RUN !== '1' });
    const msgs = [];
    for (const p of paths) {
      const [, slug, file] = CHAT_PATH.exec(p);
      const msg = readJsonSafe(path.join(root, p));
      if (!msg || validateChatMessage(msg, slug).length) { log(`пропущено некорректное сообщение ${p}`); continue; }
      msgs.push({ slug, msg, file });
    }
    jobs = planJobs(msgs);
    log(`новых сообщений: ${paths.length}, задач для ИИ: ${jobs.length}`);
  }

  while (jobs.length) {
    const job = jobs.shift();
    if (state.calls >= MAX_CALLS) { log(`лимит ${MAX_CALLS} вызовов за запуск — пропущено: ${job.who} для ${job.trigger.id}`); continue; }
    const res = await runJob(job, { root, env, state, log });
    if (!res) continue;
    state.replies.push(res);
    jobs.push(...nextJobs(job, res.msg, jobs));
  }
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(e => {
    console.error('[ai-chat] сбой: ' + sanitizeError(e, [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.GITHUB_TOKEN]));
    process.exit(1);
  });
}
