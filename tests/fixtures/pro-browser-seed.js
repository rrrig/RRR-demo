// Наполнение поддельного GitHub для проверки в браузере (подключается после fake-github.mjs).
// window.__SEED = { files: {path: base64}, photo: base64 } задаётся скриптом Playwright.
(function () {
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const files = {};
  for (const [p, b] of Object.entries(window.__SEED.files)) files[p] = unb64(b);
  const P = 'projects/primer-ograzhdenie/';
  const iso = (h, m) => `2026-11-09T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
  const msg = (id, author, at, text, extra = {}) => {
    const m = { schema: 1, id, author, date: at, text, ...extra };
    const t = at.replace(/[-:]/g, '');
    const who = { 'Дмитрий': 'dmitriy', Claude: 'claude', ChatGPT: 'chatgpt' }[author];
    files[`${P}chat/${t}-${who}-${id}.json`] = new TextEncoder().encode(JSON.stringify(m, null, 2) + '\n');
  };
  const photo = unb64(window.__SEED.photo);
  const csv = new TextEncoder().encode('Хлыст;Длина, мм;Детали\n1;6000;Кольцо верхнее, сегмент 1\n2;6000;Кольцо верхнее, сегмент 2\n3;6000;Стойки ×6\n');
  files[P + 'files/work/raskroy-truby.csv'] = csv;
  files[P + 'files/work/zametki.md'] = new TextEncoder().encode('# Заметки по ограждению\n\n- Высота 900 мм\n- Шаг стоек ≈ 393 мм по оси\n');
  files[P + 'files/sources/s-photo000001-mesto.jpg'] = photo;
  files[P + 'files/chat/m-attach000001-raskroy.csv'] = csv;
  const src = JSON.parse(new TextDecoder().decode(files[P + 'sources.json']));
  src.sources.push({ id: 's-photo000001', type: 'Фото', title: 'Место установки, вид сверху', origin: 'Дмитрий', date: '2026-11-08', file: { path: P + 'files/sources/s-photo000001-mesto.jpg', name: 'Место установки.jpg', size: photo.length } });
  src.sources.push({ id: 's-model000001', type: '3D-модель', title: 'Модель ели (заказчик)', origin: 'Дмитрий', date: '2026-11-08', url: 'https://example.com/el.step', note: 'Высота 6 м, нижний ярус Ø2600.' });
  files[P + 'sources.json'] = new TextEncoder().encode(JSON.stringify(src, null, 2) + '\n');
  const docs = JSON.parse(new TextDecoder().decode(files[P + 'documents.json']));
  docs.documents[0].revisions.push({ id: 'r-b2d6f0a4c8e1', rev: 'R02', status: 'Разрешено к выдаче', date: '2026-11-09', author: 'Дмитрий', note: 'Уточнены размеры стоек.' });
  docs.documents.push({ id: 'd-9c3e7a1b5f20', name: 'Раскрой трубы 40×20×2', format: 'XLSX', revisions: [{ id: 'r-c3e7a1b5f209', rev: 'R01', status: 'На проверке', date: '2026-11-09', author: 'Claude', file: { path: P + 'files/work/raskroy-truby.csv', name: 'Раскрой трубы.csv', size: csv.length } }] });
  files[P + 'documents.json'] = new TextEncoder().encode(JSON.stringify(docs, null, 2) + '\n');
  msg('m-today0000001', 'Дмитрий', iso(11, 20), 'Стойки привариваем, разборный вариант не нужен. @Claude обнови раскрой, @ChatGPT — смету.', { mentions: ['Claude', 'ChatGPT'], replyTo: 'm-8f1d3b6e0a92' });
  msg('m-today0000002', 'Claude', iso(11, 24), 'Принято, стойки привариваем. Раскрой обновил: 8 хлыстов по 6 м, отход 4,1 %. Файл приложил.', { replyTo: 'm-today0000001', files: [{ path: P + 'files/chat/m-attach000001-raskroy.csv', name: 'Раскрой трубы.csv', size: csv.length }] });
  msg('m-today0000003', 'ChatGPT', iso(11, 31), 'Смету обновлю через предложение #1. Подробности — https://example.com/prices?region=msk&v=2. @Дмитрий проверьте, пожалуйста.', { mentions: ['Дмитрий'] });

  const gh = createFakeGitHub({ files, token: 'tok' });
  const cost = JSON.parse(new TextDecoder().decode(files[P + 'cost.json']));
  cost.items[0].price = 98; cost.items[0].note = 'Металлобаза «Пример», прайс от 09.11.2026, без НДС.';
  cost.items.push({ id: 'c-7d1a5e9b3f40', group: 'Покупное', name: 'Хомут трубный 40 мм', unit: 'шт', qty: 24, price: 85.5, note: 'Ориентировочно, проверить.' });
  gh.openPR({ author: 'ChatGPT', title: '[ChatGPT] Цены на трубу и хомуты по Москве', body: '**Что изменено:** cost.json — цена трубы 98 ₽/кг, добавлены хомуты.\n**Почему:** задача t-8c1e6b4f0a27.\n**Открытые вопросы:** нужны ли хомуты при сварной конструкции?', check: 'success', files: { [P + 'cost.json']: JSON.stringify(cost, null, 2) + '\n' } });
  gh.openPR({ author: 'Claude', title: '[Claude] Раскрой трубы: 8 хлыстов', body: 'Обновлён раскрой.', check: 'pending', files: { [P + 'tasks.json']: new TextDecoder().decode(files[P + 'tasks.json']).replace('"status": "Открыта"', '"status": "Готово"') } });
  window.__gh = gh;
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => (String(url).startsWith('https://api.github.com/') ? gh.fetch(String(url), init) : realFetch(url, init));
})();
