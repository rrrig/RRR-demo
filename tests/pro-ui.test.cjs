// ИГНИС ПРО: сквозная проверка интерфейса в jsdom с поддельным GitHub.
const test = require('node:test'); const assert = require('node:assert/strict');
const { launch, until } = require('./fixtures/pro-dom.cjs');
const P = 'projects/primer-ograzhdenie/';
const chatFiles = gh => gh.paths().filter(p => p.startsWith(P + 'chat/'));

test('без токена — экран настроек; после ввода токена — список проектов', async () => {
  const h = await launch({ settings: {} });
  try {
    await until(() => h.w.location.hash === '#/settings' && h.text().includes('Подключение к хранилищу'), 'настройки');
    assert.match(h.text(), /Как получить токен/);
    h.$('conn').querySelector('[name=token]').value = 'tok';
    h.$('conn').requestSubmit();
    await until(() => h.w.location.hash === '#/', 'переход к проектам');
    await until(() => h.text().includes('Пример: ограждение Ø3000'), 'проект в списке');
    assert.match(h.text(), /1 документ · 2 открытые задачи/);
    assert.equal(JSON.parse(h.w.localStorage.getItem('ignis-pro-settings')).token, 'tok');
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test('неверный токен — понятная ошибка', async () => {
  const h = await launch({ settings: { token: 'bad' } });
  try {
    await until(() => !h.$('banner').hidden, 'баннер');
    assert.match(h.$('banner').textContent, /Токен не принят GitHub/);
  } finally { h.close(); }
});

test('чат: сообщения трёх участников, отправка попадает в репозиторий, поле очищается', async () => {
  const h = await launch();
  try {
    await h.idle();
    await h.go('#/p/primer-ograzhdenie/chat', 'Беру раскрой');
    const view = h.$('view');
    assert.equal(view.querySelectorAll('.msg').length, 3);
    assert.equal(view.querySelectorAll('.msg.mine').length, 1);
    assert.ok(view.querySelector('.msg.claude .who').textContent.includes('Claude'));
    assert.ok(view.querySelector('.msg.gpt'));
    assert.ok(view.querySelector('.quote'), 'цитата ответа');
    const before = chatFiles(h.gh).length;
    h.$('msg').value = "@Claude проверь раскрой, it's #1"; h.$('msg').dispatchEvent(new h.w.Event('input'));
    h.$('composer').requestSubmit();
    assert.equal(h.$('msg').value, '', 'поле очищено сразу');
    await until(() => chatFiles(h.gh).length === before + 1, 'сообщение в репозитории');
    const file = chatFiles(h.gh).find(p => p.includes('-dmitriy-m-') && !p.includes('2c7e9a1f4b06'));
    const msg = h.gh.json(file);
    assert.equal(msg.author, 'Дмитрий'); assert.deepEqual(msg.mentions, ['Claude']); assert.equal(msg.text, "@Claude проверь раскрой, it's #1");
    assert.match(h.gh.log()[0].message, /^\[Дмитрий\] Сообщение в чате/);
    await until(() => h.$('view').querySelectorAll('.msg').length === 4, '4 сообщения');
    assert.equal(h.$('msg').value, '', 'после обновления черновик не вернулся');
    const last = [...h.$('view').querySelectorAll('.msg .text')].find(x => x.textContent.includes('it\'s')).innerHTML;
    assert.match(last, /it's <a href="#\/inbox\/1">#1<\/a>$/, 'апостроф не ломает ссылки');
    // ИИ отвечает — чат обновляется без пересоздания поля ввода
    const composer = h.$('composer'); h.$('msg').value = 'черновик'; h.$('msg').dispatchEvent(new h.w.Event('input'));
    h.gh.aiCommit({ author: 'Claude', message: '[Claude] Чат: ответ', files: { [P + 'chat/20261109T235900Z-claude-m-cccccccccccc.json']: JSON.stringify({ schema: 1, id: 'm-cccccccccccc', author: 'Claude', date: '2026-11-09T23:59:00Z', text: 'Готово, раскрой в work/raskroy.csv' }) } });
    h.$('sync').click();
    await until(() => h.text().includes('Готово, раскрой'), 'ответ Claude');
    assert.equal(h.$('composer'), composer, 'поле ввода то же самое'); assert.equal(h.$('msg').value, 'черновик');
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test('без связи: изменения в очереди, при появлении связи отправляются', async () => {
  const h = await launch();
  try {
    await h.idle();
    await h.go('#/p/primer-ograzhdenie/chat', 'Беру раскрой');
    h.gh.offline = true;
    h.$('msg').value = 'Пишу без связи'; h.$('composer').requestSubmit();
    await until(() => h.text().includes('⏳ ждёт отправки'), 'ожидающее сообщение');
    await until(() => /Нет связи с GitHub/.test(h.$('banner').textContent) && /Ждут отправки: 1/.test(h.$('banner').textContent), 'баннер без связи');
    // ещё одно изменение без связи — задача
    await h.go('#/p/primer-ograzhdenie/tasks', 'Принятые решения');
    h.$('addTask').click(); await h.sheet({ title: 'Купить трубу', due: '2026-11-25' });
    await until(() => /Ждут отправки: 2/.test(h.$('banner').textContent), 'две операции');
    assert.match(h.text(), /Купить трубу/, 'задача видна до отправки');
    const before = h.gh.log().length;
    h.gh.offline = false;
    h.w.dispatchEvent(new h.w.Event('online'));
    await until(() => h.gh.log().length === before + 2, 'обе операции отправлены');
    await until(() => h.$('banner').hidden, 'баннер скрыт');
    assert.ok(h.gh.json(P + 'tasks.json').tasks.some(t => t.title === 'Купить трубу' && t.due === '2026-11-25'));
    assert.ok(chatFiles(h.gh).some(p => h.gh.json(p).text === 'Пишу без связи'));
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test('задача: очищенные срок и подробности удаляются из файла', async () => {
  const h = await launch();
  try {
    await h.idle();
    await h.go('#/p/primer-ograzhdenie/tasks', 'Рассчитать развёртку');
    await h.click('[data-task="t-3d9f2a7c5e18"]');
    await h.sheet({ due: '', note: '', status: 'В работе' });
    await until(() => h.gh.json(P + 'tasks.json').tasks[0].status === 'В работе', 'сохранено');
    const t = h.gh.json(P + 'tasks.json').tasks[0];
    assert.ok(!('due' in t) && !('note' in t), JSON.stringify(t));
  } finally { h.close(); }
});

test('ошибка данных не выдаётся за отсутствие связи', async () => {
  const h = await launch();
  try {
    await h.idle();
    await h.go('#/p/primer-ograzhdenie/docs', 'сборочный чертёж');
    await h.click('[data-addrev]');
    await h.sheet({ rev: 'R01' });
    await until(() => /Редакция R01 уже есть/.test(h.$('toast').textContent), 'сообщение об ошибке');
    assert.equal(h.$('banner').hidden, true, 'нет баннера «нет связи»');
    assert.equal(h.$('sheet').hidden, false, 'форма не закрылась');
  } finally { h.close(); }
});

test('предложения ИИ: список, просмотр, принять', async () => {
  const h = await launch();
  try {
    const pr = h.gh.openPR({ author: 'ChatGPT', title: '[ChatGPT] Цены поставщиков', body: 'Обновил цены.', check: 'success', files: {
      [P + 'cost.json']: h.gh.read(P + 'cost.json').replace('"price": 95', '"price": 98'),
      [P + 'chat/20261109T110000Z-chatgpt-m-dddddddddddd.json']: JSON.stringify({ schema: 1, id: 'm-dddddddddddd', author: 'ChatGPT', date: '2026-11-09T11:00:00Z', text: 'Предложение #1: цены' }, null, 2) } });
    await h.idle();
    await until(() => h.$('inboxBadge').textContent === '1', 'значок');
    await h.go('#/inbox', 'Цены поставщиков');
    assert.match(h.text(), /проверка пройдена/);
    await h.go('#/p/primer-ograzhdenie/chat', 'Предложение #1: цены');
    assert.match(h.text(), /в предложении #1/);
    await h.go('#/inbox/' + pr.number, 'Изменённые файлы (2)');
    await h.click('#accept');
    await until(() => h.gh.pulls[0].merged, 'принято');
    assert.match(h.gh.log()[0].message, /^\[Дмитрий\] Принято предложение #1 от ChatGPT: Цены поставщиков$/);
    assert.equal(h.gh.json(P + 'cost.json').items[0].price, 98);
  } finally { h.close(); }
});
