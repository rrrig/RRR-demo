// ИГНИС ПРО: модель данных (r05/pro/model.js) — проверка файлов, путей, чата, сметы.
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('node:path');
const { loadESModule } = require('./load-module.cjs');
const M = () => loadESModule(path.join(__dirname, '../r05/pro/model.js'));

test('validDate: только существующие даты ГГГГ-ММ-ДД', async () => {
  const { validDate } = await M();
  for (const d of ['2026-11-09', '2024-02-29', '2000-02-29']) assert.ok(validDate(d), d);
  for (const d of ['2026-02-29', '2026-13-01', '2026-11-31', '2026-1-09', '09.11.2026', '', null, 20261109, '2026-11-09T00:00:00Z', '1900-02-29']) assert.equal(validDate(d), false, String(d));
});

test('validFilePath: только files/<docs|sources|chat|work>/<имя> своего проекта', async () => {
  const { validFilePath } = await M();
  assert.ok(validFilePath('projects/abc/files/docs/r-1-x.pdf'));
  assert.ok(validFilePath('projects/abc/files/work/raschet.txt', 'abc'));
  assert.equal(validFilePath('projects/abc/files/work/raschet.txt', 'other'), false);
  for (const p of ['projects/abc/files/work/../x', 'projects/abc/files/work/..', 'projects/abc/files/work/.', 'projects/abc/files/work/a/b.txt', 'projects/abc/files/tmp/x', 'projects/abc/project.json', 'projects/ABC/files/work/x', '/projects/abc/files/work/x', 'projects/abc/files/work/', '', undefined])
    assert.equal(validFilePath(p), false, String(p));
});

test('validateFile: пример проекта из data-template проходит, ошибки описаны по-русски', async () => {
  const { validateProject, validateFile, PROJECT_FILES } = await M();
  const fs = require('node:fs'); const dir = path.join(__dirname, '../data-template/projects/primer-ograzhdenie');
  const files = Object.fromEntries(PROJECT_FILES.map(n => [n, JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))]));
  assert.deepEqual(validateProject('primer-ograzhdenie', files), []);
  const bad = structuredClone(files['tasks.json']); bad.tasks[0].due = '2026-02-30'; bad.tasks[1].status = 'Сделано';
  const errs = validateFile('tasks.json', bad);
  assert.equal(errs.length, 2); assert.match(errs[0], /due.*существующей датой/); assert.match(errs[1], /допустимо: Открыта, В работе, Готово/);
  const docs = structuredClone(files['documents.json']);
  docs.documents[0].revisions.push({ ...docs.documents[0].revisions[0], id: 'r-bbbbbb', rev: ' r01 ' });
  assert.match(validateFile('documents.json', docs).join('\n'), /повтор редакции/);
  docs.documents[0].revisions[1] = { ...docs.documents[0].revisions[1], rev: 'R02', file: { path: 'projects/other/files/docs/x.pdf', name: 'x.pdf', size: 1 } };
  assert.match(validateFile('documents.json', docs, 'primer-ograzhdenie').join('\n'), /файл должен лежать в projects\/primer-ograzhdenie\/files/);
  assert.match(validateProject('Пример', files).join('\n'), /только латиница/);
  const noFile = { ...files }; delete noFile['cost.json'];
  assert.match(validateProject('primer-ograzhdenie', noFile).join('\n'), /cost\.json: файл отсутствует/);
  const two = structuredClone(files['documents.json']);
  two.documents[0].revisions = [{ ...two.documents[0].revisions[0], status: 'Разрешено к выдаче' }, { ...two.documents[0].revisions[0], id: 'r-cccccc', rev: 'R02', status: 'Разрешено к выдаче' }];
  assert.match(validateFile('documents.json', two).join('\n'), /только у одной редакции/);
});

test('чат: имя файла, проверка сообщения, упоминания', async () => {
  const { chatFileName, validateChatMessage, newChatMessage, mentionsIn } = await M();
  const m = { schema: 1, id: 'm-8f1d3b6e0a92', author: 'Claude', date: '2026-11-09T09:40:25.123Z', text: 'Привет' };
  assert.equal(chatFileName(m), '20261109T094025Z-claude-m-8f1d3b6e0a92.json');
  assert.equal(chatFileName({ ...m, author: 'Дмитрий' }), '20261109T094025Z-dmitriy-m-8f1d3b6e0a92.json');
  assert.deepEqual(validateChatMessage(m), []);
  assert.match(validateChatMessage({ ...m, date: '2026-11-09 09:40' }).join(), /date должна быть временем ISO/);
  assert.match(validateChatMessage({ ...m, date: '2026-02-30T09:40:25Z' }).join(), /date/);
  assert.match(validateChatMessage({ ...m, text: '' }).join(), /«text» обязательно/);
  assert.deepEqual(validateChatMessage({ ...m, text: '', files: [{ path: 'projects/a/files/chat/m-1-x.pdf', name: 'x.pdf', size: 3 }] }, 'a'), []);
  assert.match(validateChatMessage({ ...m, files: [{ path: 'projects/a/files/chat/m-1-x.pdf', name: 'x.pdf', size: 3 }] }, 'b').join(), /файл должен лежать в projects\/b/);
  assert.match(validateChatMessage({ ...m, replyTo: 'nope' }).join(), /replyTo/);
  assert.match(validateChatMessage({ ...m, id: 'x-123456' }).join(), /неверный id/);
  const n = newChatMessage({ author: 'Дмитрий', text: 'тест' });
  assert.deepEqual(validateChatMessage(n), []); assert.equal(n.files, undefined); assert.equal(n.mentions, undefined);
  assert.deepEqual(mentionsIn('@Claude посчитай, @gpt проверь'), ['Claude', 'ChatGPT']);
  assert.deepEqual(mentionsIn('@все смотрите'), ['Claude', 'ChatGPT']);
  assert.deepEqual(mentionsIn('без обращений'), []);
});

test('смета в копейках: без ошибок округления float', async () => {
  const { costTotals, lineKop, kop, rub } = await M();
  assert.equal(lineKop({ qty: 3, price: 0.1 }), 30);           // 0.1*3 = 0.30000000000000004
  assert.equal(lineKop({ qty: 1, price: 1.005 }), 101);        // 1.005*100 = 100.49999999999999
  assert.equal(lineKop({ qty: 0.7, price: 0.1 }), 7);
  assert.equal(lineKop({ qty: 1.15, price: 100 }), 11500);     // 1.15*100 = 114.99999999999999
  assert.equal(kop(1.005), 101); assert.equal(kop(0.29), 29); assert.equal(kop(19.99), 1999);
  const t = costTotals({ overheadPct: 15, marginPct: 20, items: [
    { group: 'Материалы', qty: 80, price: 95 }, { group: 'Материалы', qty: 4, price: 650 }, { group: 'Работы', qty: 12, price: 1200 }, { group: 'Прочее', qty: 3, price: 0.1 }] });
  assert.equal(t.groups['Материалы'], 1020000); assert.equal(t.groups['Работы'], 1440000); assert.equal(t.groups['Прочее'], 30);
  assert.equal(t.direct, 2460030); assert.equal(t.overhead, Math.round(2460030 * 0.15)); assert.equal(t.total, t.direct + t.overhead);
  assert.equal(t.price, t.total + t.margin);
  const sp = s => s.replace(/\s/g, ' '); // разряды разделены неразрывным пробелом
  assert.equal(sp(rub(2829035)), '28 290,35 ₽'); assert.equal(sp(rub(5)), '0,05 ₽'); assert.equal(sp(rub(-100)), '−1,00 ₽'); assert.equal(sp(rub(123456789)), '1 234 567,89 ₽');
  assert.match(rub(2829035), /^28\u00a0290,35\u00a0₽$/);
  assert.deepEqual(costTotals({ items: [] }).price, 0);
});

test('slugify, safeFileName, authorOf, approvalChanges', async () => {
  const { slugify, safeFileName, authorOf, approvalChanges } = await M();
  assert.equal(slugify('Звезда на ёлку 6 м'), 'zvezda-na-elku-6-m');
  assert.equal(slugify('Ограждение Ø3000'), 'ograzhdenie-d3000');
  assert.equal(slugify('Звезда', new Set(['zvezda', 'zvezda-2'])), 'zvezda-3');
  assert.equal(slugify('!!!'), 'proekt');
  assert.equal(safeFileName('Сборочный чертёж.PDF'), 'sborochnyy-chertezh.pdf');
  assert.ok(!safeFileName('../../etc/passwd').includes('/'));
  assert.equal(authorOf('[Claude] Раскрой'), 'Claude');
  assert.equal(authorOf('Merge', 'chatgpt-codex[bot]'), 'ChatGPT');
  const before = { documents: [{ revisions: [{ id: 'r-1', status: 'Разрешено к выдаче' }, { id: 'r-2', status: 'Не проверено' }] }] };
  assert.deepEqual(approvalChanges(before, before), []);
  assert.deepEqual(approvalChanges(before, { documents: [{ revisions: [{ id: 'r-2', status: 'Разрешено к выдаче' }] }] }).sort(), ['r-1', 'r-2']);
});
