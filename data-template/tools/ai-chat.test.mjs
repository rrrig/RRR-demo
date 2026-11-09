// Тесты бота чата: node --test tools/ai-chat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractJson, validateChanges, planJobs, nextJobs, makeReplyMessage, run, buildContext, agentsEssential,
  sanitizeError, addedChatPaths, MAX_HOPS, MAX_CALLS,
} from './ai-chat.mjs';
import { chatFileName, validateChatMessage, newChatMessage, APPROVED } from './model.js';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'primer-ograzhdenie';
const P = f => `projects/${SLUG}/${f}`;
const tplRead = f => readFileSync(path.join(TEMPLATE, P(f)), 'utf8');

// ---------- extractJson ----------
test('extractJson: чистый JSON', () => {
  const r = extractJson('{"reply":"Привет","mentions":["ChatGPT"],"changes":[]}');
  assert.equal(r.parsed, true); assert.equal(r.reply, 'Привет'); assert.deepEqual(r.mentions, ['ChatGPT']);
});
test('extractJson: блок ```json и текст вокруг', () => {
  const r = extractJson('Вот ответ:\n```json\n{"reply":"Ок","changes":[{"path":"a","content":"b"}],"pr_title":"T"}\n```\nСпасибо');
  assert.equal(r.reply, 'Ок'); assert.equal(r.changes.length, 1); assert.equal(r.pr_title, 'T');
});
test('extractJson: JSON внутри текста без ограждения', () => {
  const r = extractJson('Ответ: {"reply":"Да {скобки}","mentions":"не список"} конец');
  assert.equal(r.reply, 'Да {скобки}'); assert.deepEqual(r.mentions, []);
});
test('extractJson: не JSON — весь текст становится ответом', () => {
  const r = extractJson('Просто текст { без json');
  assert.equal(r.parsed, false); assert.equal(r.reply, 'Просто текст { без json'); assert.deepEqual(r.changes, []);
});

// ---------- validateChanges ----------
const ctx = { slug: SLUG, readCurrent: p => { try { return readFileSync(path.join(TEMPLATE, p), 'utf8'); } catch { return undefined; } }, fileExists: () => false };

test('validateChanges: недопустимые пути', () => {
  const bad = [
    { path: 'projects/drugoy/tasks.json', content: '{}' },
    { path: 'tools/validate.mjs', content: 'x' },
    { path: `projects/${SLUG}/files/work/../tasks.json`, content: 'x' },
    { path: `projects/${SLUG}/files/docs/a.txt`, content: 'x' },
    { path: `projects/${SLUG}/files/work/sub/a.txt`, content: 'x' },
    { path: `projects/${SLUG}/files/work/a.exe`, content: 'x' },
    { path: `projects/${SLUG}/README.md`, content: 'x' },
    { path: `projects/${SLUG}/chat/x.json`, content: '{}' },
  ];
  const { valid, errors } = validateChanges(bad, ctx);
  assert.equal(valid.length, 0); assert.equal(errors.length, bad.length);
});
test('validateChanges: файл больше 1 МБ', () => {
  const { valid, errors } = validateChanges([{ path: P('files/work/big.txt'), content: 'a'.repeat(1024 * 1024 + 1) }], ctx);
  assert.equal(valid.length, 0); assert.match(errors[0], /1 МБ/);
});
test('validateChanges: неверный JSON и неверная схема', () => {
  const { valid, errors } = validateChanges([
    { path: P('tasks.json'), content: '{ "schema": 1, tasks: [' },
    { path: P('cost.json'), content: JSON.stringify({ schema: 1, currency: 'USD', overheadPct: 0, marginPct: 0, items: [] }) },
  ], ctx);
  assert.equal(valid.length, 0); assert.match(errors[0], /ошибка JSON/); assert.match(errors[1], /RUB/);
});
test('validateChanges: попытка поставить «Разрешено к выдаче»', () => {
  const docs = JSON.parse(tplRead('documents.json'));
  docs.documents[0].revisions[0].status = APPROVED;
  const { valid, errors } = validateChanges([{ path: P('documents.json'), content: JSON.stringify(docs) }], ctx);
  assert.equal(valid.length, 0); assert.match(errors[0], /Разрешено к выдаче/);
});
test('validateChanges: ссылка на несуществующий файл и смена id проекта', () => {
  const docs = JSON.parse(tplRead('documents.json'));
  docs.documents[0].revisions[0].file = { path: P('files/docs/r-a1c5e9d3b7f4-x.pdf'), name: 'x.pdf', size: 1 };
  const pj = JSON.parse(tplRead('project.json')); pj.id = 'p-000000000000';
  const { valid, errors } = validateChanges([{ path: P('documents.json'), content: JSON.stringify(docs) }, { path: P('project.json'), content: JSON.stringify(pj) }], ctx);
  assert.equal(valid.length, 0); assert.match(errors[0], /несуществующие/); assert.match(errors[1], /id проекта/);
});
test('validateChanges: корректные правки проходят, без изменений — пропускаются', () => {
  const tasks = JSON.parse(tplRead('tasks.json'));
  tasks.tasks.push({ id: 't-a1b2c3d4e5f6', title: 'Проверить', assignee: 'Дмитрий', status: 'Открыта', created: '2026-11-09', author: 'Claude' });
  const { valid, errors } = validateChanges([
    { path: P('tasks.json'), content: tasks },                       // объект тоже принимается
    { path: P('files/work/raskroy.csv'), content: 'a;b\n1;2\n' },
    { path: P('cost.json'), content: tplRead('cost.json') },         // без изменений
  ], ctx);
  assert.deepEqual(errors, []);
  assert.deepEqual(valid.map(v => v.path), [P('tasks.json'), P('files/work/raskroy.csv')]);
  assert.equal(JSON.parse(valid[0].content).tasks.length, tasks.tasks.length);
});

// ---------- Очередь и переходы ----------
const human = (text, extra = {}) => ({ ...newChatMessage({ author: 'Дмитрий', text }), ...extra });

test('planJobs: Claude первым, ИИ-авторы пропускаются', () => {
  const jobs = planJobs([
    { slug: SLUG, msg: human('@ChatGPT и @Claude посмотрите'), file: 'a.json' },
    { slug: SLUG, msg: { ...newChatMessage({ author: 'Claude', text: '@ChatGPT ответь' }) }, file: 'b.json' },
    { slug: SLUG, msg: { ...newChatMessage({ author: 'ИИ-бот', text: '@все' }) }, file: 'c.json' },
    { slug: SLUG, msg: human('без упоминаний'), file: 'd.json' },
    { slug: SLUG, msg: human('текст', { mentions: ['ChatGPT', 'Дмитрий'] }), file: 'e.json' },
    { slug: SLUG, msg: human('@все'), file: 'f.json' },
  ]);
  assert.deepEqual(jobs.map(j => j.who), ['Claude', 'ChatGPT', 'ChatGPT', 'Claude', 'ChatGPT']);
  assert.ok(jobs.every(j => j.hop === 0));
});
test('nextJobs: ограничение переходов ИИ↔ИИ и без дублей', () => {
  const root = human('@Claude');
  let job = planJobs([{ slug: SLUG, msg: root, file: 'a.json' }])[0];
  const hops = [];
  for (let i = 0; i < 5; i++) {
    const reply = newChatMessage({ author: job.who, text: `@${job.who === 'Claude' ? 'ChatGPT' : 'Claude'} проверь` });
    const nx = nextJobs(job, reply, []);
    if (!nx.length) break;
    job = nx[0]; hops.push(job.who);
  }
  assert.deepEqual(hops, ['ChatGPT', 'Claude']); assert.equal(hops.length, MAX_HOPS);
  // Другой ИИ уже в очереди на то же сообщение — не дублируем.
  const [c, g] = planJobs([{ slug: SLUG, msg: human('@все'), file: 'a.json' }]);
  assert.deepEqual(nextJobs(c, newChatMessage({ author: 'Claude', text: '@ChatGPT' }), [g]), []);
  // Упоминание себя не порождает задач.
  assert.deepEqual(nextJobs(c, newChatMessage({ author: 'Claude', text: '@Claude' }), []), []);
});

// ---------- Сообщение-ответ ----------
test('makeReplyMessage: валидно, имя файла по chatFileName, длинный текст сокращается', () => {
  const { msg, file } = makeReplyMessage({ author: 'Claude', text: 'x'.repeat(30000), mentions: ['ChatGPT', 'Claude', 'Вася', 'Дмитрий'], replyTo: 'm-abcdef123456', slug: SLUG });
  assert.deepEqual(validateChatMessage(msg, SLUG), []);
  assert.equal(file, chatFileName(msg)); assert.match(file, /^\d{8}T\d{6}Z-claude-m-[0-9a-f]{12}\.json$/);
  assert.deepEqual(msg.mentions, ['ChatGPT', 'Дмитрий']); assert.equal(msg.replyTo, 'm-abcdef123456');
  assert.ok(msg.text.length <= 20000);
  const bot = makeReplyMessage({ author: 'ИИ-бот', text: '', slug: SLUG });
  assert.equal(bot.msg.text, '(пустой ответ)'); assert.match(bot.file, /-iibot-m-/);
});
test('sanitizeError убирает ключи', () => {
  assert.equal(sanitizeError(new Error('bad key sk-ant-abcdef1234567890 and SECRETVALUE1'), ['SECRETVALUE1']), 'bad key *** and ***');
});
test('agentsEssential и buildContext', () => {
  const a = agentsEssential(readFileSync(path.join(TEMPLATE, 'AGENTS.md'), 'utf8'));
  assert.match(a, /Разрешено к выдаче/);
  const c = buildContext({ root: TEMPLATE, slug: SLUG, prs: ['#3 [Claude] тест'], agentsText: 'x' });
  assert.match(c, /project\.json/); assert.match(c, /#3 \[Claude\] тест/);
});

// ---------- Сквозной прогон (без сети) ----------
function g(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ai-chat-e2e-'));
  cpSync(TEMPLATE, dir, { recursive: true, filter: s => !/[/\\](\.git|node_modules)([/\\]|$)/.test(s) });
  rmSync(path.join(dir, 'projects', SLUG, 'chat'), { recursive: true, force: true });
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.name', 'Тест'); g(dir, 'config', 'user.email', 't@example.com'); g(dir, 'config', 'commit.gpgsign', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function addHumanMessage(dir, text) {
  const before = g(dir, 'rev-parse', 'HEAD');
  const msg = newChatMessage({ author: 'Дмитрий', text });
  const rel = `projects/${SLUG}/chat/${chatFileName(msg)}`;
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), JSON.stringify(msg, null, 2) + '\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'Чат');
  return { msg, before, after: g(dir, 'rev-parse', 'HEAD') };
}
function chatMessages(dir) {
  const d = path.join(dir, 'projects', SLUG, 'chat');
  return readdirSync(d).map(n => ({ n, m: JSON.parse(readFileSync(path.join(d, n), 'utf8')) })).sort((a, b) => a.m.date.localeCompare(b.m.date) || a.n.localeCompare(b.n));
}

function mockFetch(handlers) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    const h = handlers(String(url), calls.length);
    return new Response(JSON.stringify(h.body), { status: h.status || 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('e2e DRY_RUN: Claude отвечает с PR, зовёт ChatGPT, ChatGPT отвечает', async () => {
  const dir = makeRepo();
  const { msg, before, after } = addHumanMessage(dir, '@Claude посчитай раскрой и добавь задачу');
  assert.deepEqual(addedChatPaths(dir, before, after), [`projects/${SLUG}/chat/${chatFileName(msg)}`]);
  assert.equal(addedChatPaths(dir, '0'.repeat(40), after).length, 1); // новая ветка

  const tasks = JSON.parse(readFileSync(path.join(dir, P('tasks.json')), 'utf8'));
  tasks.tasks.push({ id: 't-0a1b2c3d4e5f', title: 'Согласовать раскрой', assignee: 'Дмитрий', status: 'Открыта', created: '2026-11-09', author: 'Claude' });
  const claudeOut = { reply: 'Раскрой: 4 хлыста по 6 м. @ChatGPT проверь цены.', mentions: ['ChatGPT'],
    changes: [{ path: P('tasks.json'), content: JSON.stringify(tasks, null, 2) }, { path: 'tools/x.js', content: 'evil' }],
    pr_title: 'Задача на согласование раскроя', pr_body: 'Добавлена задача.' };
  const m = mockFetch(url => {
    if (url.includes('anthropic')) return { body: { content: [{ type: 'text', text: '```json\n' + JSON.stringify(claudeOut) + '\n```' }] } };
    if (url.includes('openai')) return { body: { choices: [{ message: { content: 'Цены проверю, согласен с раскроем. Просто текст без JSON.' } }] } };
    throw new Error('неожиданный запрос ' + url);
  });
  const logs = [];
  try {
    const state = await run({ root: dir, log: s => logs.push(s), env: { DRY_RUN: '1', BEFORE: before, AFTER: after, ANTHROPIC_API_KEY: 'test-a', OPENAI_API_KEY: 'test-o', GITHUB_REPOSITORY: 'rrrig/ignis-projects' } });
    assert.equal(state.calls, 2);
  } finally { m.restore(); }

  assert.equal(m.calls.length, 2);
  assert.equal(m.calls[0].headers['x-api-key'], 'test-a'); assert.equal(m.calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(m.calls[0].body.model, 'claude-sonnet-5-5'); assert.equal(m.calls[0].body.max_tokens, 8000);
  assert.equal(m.calls[1].body.model, 'gpt-5'); assert.equal('temperature' in m.calls[1].body, false);
  assert.match(m.calls[1].body.messages[1].content, /Раскрой: 4 хлыста/); // ChatGPT видит ответ Claude

  const msgs = chatMessages(dir);
  assert.deepEqual(msgs.map(x => x.m.author), ['Дмитрий', 'Claude', 'ChatGPT']);
  for (const { n, m: cm } of msgs) { assert.deepEqual(validateChatMessage(cm, SLUG), []); assert.equal(n, chatFileName(cm)); }
  const [, c, gpt] = msgs.map(x => x.m);
  assert.equal(c.replyTo, msg.id); assert.equal(gpt.replyTo, c.id);
  assert.match(c.text, /Предложение #0: \[Claude\] Задача на согласование раскроя — примите или отклоните в приложении/);
  assert.match(c.text, /отклонена проверкой[\s\S]*tools\/x\.js/);
  assert.deepEqual(c.mentions, ['ChatGPT']);

  // Ветка с предложением и коммиты в main
  const branch = `ai/claude/chat-${msg.id}`;
  assert.equal(g(dir, 'diff', '--name-only', 'main', branch).split('\n').filter(x => !x.includes('/chat/')).join(), P('tasks.json'));
  assert.match(g(dir, 'log', '-1', '--format=%s', branch), /^\[Claude\] /);
  assert.equal(g(dir, 'status', '--porcelain'), '');
  const subjects = g(dir, 'log', '--format=%s', `${after}..main`).split('\n');
  assert.deepEqual(subjects, ['[ChatGPT] Ответ в чате Пример: ограждение Ø3000', '[Claude] Ответ в чате Пример: ограждение Ø3000']);
  assert.ok(!JSON.parse(readFileSync(path.join(dir, P('tasks.json')), 'utf8')).tasks.some(t => t.id === 't-0a1b2c3d4e5f'), 'main не изменён');
  rmSync(dir, { recursive: true, force: true });
});

test('e2e DRY_RUN: нет ключа OpenAI, ошибка Anthropic, лимит вызовов', async () => {
  const dir = makeRepo();
  const { before, after } = addHumanMessage(dir, '@все что скажете?');
  const m = mockFetch(() => ({ status: 500, body: { error: { message: 'overloaded' } } }));
  try {
    const state = await run({ root: dir, log: () => {}, env: { DRY_RUN: '1', BEFORE: before, AFTER: after, ANTHROPIC_API_KEY: 'test-a', AI_RETRY_DELAY_MS: '1' } });
    assert.equal(state.calls, 1);
  } finally { m.restore(); }
  assert.equal(m.calls.length, 2); // одна повторная попытка
  const bots = chatMessages(dir).filter(x => x.m.author === 'ИИ-бот').map(x => x.m.text);
  assert.equal(bots.length, 2);
  assert.ok(bots.some(t => /^Claude не смог ответить: Anthropic API: HTTP 500 — overloaded/.test(t)));
  assert.ok(bots.includes('Ключ API для ChatGPT не настроен. Ответ можно получить вручную: откройте ChatGPT и напишите «проверь чат проекта Пример: ограждение Ø3000».'));
  assert.ok(!bots.join().includes('test-a'));
  rmSync(dir, { recursive: true, force: true });

  // Лимит вызовов: 4 сообщения × 2 ИИ = 8 задач → только MAX_CALLS вызовов.
  const dir2 = makeRepo();
  const b0 = g(dir2, 'rev-parse', 'HEAD');
  for (let i = 0; i < 4; i++) addHumanMessage(dir2, `@все вопрос ${i}`);
  const m2 = mockFetch(url => url.includes('anthropic')
    ? { body: { content: [{ type: 'text', text: '{"reply":"Ок"}' }] } }
    : { body: { choices: [{ message: { content: '{"reply":"Да"}' } }] } });
  try {
    const state = await run({ root: dir2, log: () => {}, env: { DRY_RUN: '1', BEFORE: b0, AFTER: g(dir2, 'rev-parse', 'HEAD'), ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' } });
    assert.equal(state.calls, MAX_CALLS); assert.equal(m2.calls.length, MAX_CALLS);
  } finally { m2.restore(); }
  rmSync(dir2, { recursive: true, force: true });
});

test('e2e DRY_RUN: ручной запуск (workflow_dispatch)', async () => {
  const dir = makeRepo();
  const { msg } = addHumanMessage(dir, 'Посмотрите стойки');
  const m = mockFetch(() => ({ body: { choices: [{ message: { content: '{"reply":"Стойки 900 мм — ок.","mentions":["Дмитрий"]}' } }] } }));
  try { await run({ root: dir, log: () => {}, env: { DRY_RUN: '1', INPUT_PROJECT: SLUG, INPUT_WHO: 'ChatGPT', OPENAI_API_KEY: 'o' } }); } finally { m.restore(); }
  const last = chatMessages(dir).at(-1).m;
  assert.equal(last.author, 'ChatGPT'); assert.equal(last.replyTo, msg.id); assert.deepEqual(last.mentions, ['Дмитрий']);
  rmSync(dir, { recursive: true, force: true });
});
