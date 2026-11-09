#!/usr/bin/env python3
"""Проверка ИГНИС ПРО в настоящем браузере (Chromium, экран iPhone 14) с поддельным GitHub.

Запуск (из корня репозитория):
    python3 -m http.server 8765 &   # раздать /home/claude/rrr-demo
    python3 tests/fixtures/pro-browser-qa.py [папка-для-снимков]
Снимки экранов сохраняются в qa-shots/. Ошибки консоли печатаются в конце; код выхода 1, если они есть.
"""
import base64, json, pathlib, re, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'qa-shots')
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'http://localhost:8765/r05/index.html'

fake_src = (ROOT / 'tests/fixtures/fake-github.mjs').read_text()
fake_src = re.sub(r'^export \{[^}]*\};?\s*$', '', fake_src, flags=re.M)
seed_files = {}
for p in (ROOT / 'data-template').rglob('*'):
    rel = p.relative_to(ROOT / 'data-template').as_posix()
    if p.is_file() and (rel.startswith('projects/') or rel == 'AGENTS.md'):
        seed_files[rel] = base64.b64encode(p.read_bytes()).decode()
photo = (ROOT / 'tests/fixtures/photo.jpg') if (ROOT / 'tests/fixtures/photo.jpg').exists() else (ROOT / 'assets/ignis-pro-512.png')
seed = {'files': seed_files, 'photo': base64.b64encode(photo.read_bytes()).decode()}
seed_js = (ROOT / 'tests/fixtures/pro-browser-seed.js').read_text()
INIT = f'window.__SEED = {json.dumps(seed)};\n{fake_src}\n{seed_js}'

problems = []
shots = []


def device(p):
    d = dict(p.devices['iPhone 14'])
    d.pop('default_browser_type', None)
    return d


def new_page(browser, p, token=True):
    ctx = browser.new_context(**device(p), locale='ru-RU', timezone_id='Europe/Moscow')
    ctx.add_init_script(INIT)
    if token:
        ctx.add_init_script("localStorage.setItem('ignis-pro-settings', JSON.stringify({owner:'rrrig', repo:'ignis-projects', token:'tok', me:'Дмитрий'}))")
    page = ctx.new_page()
    page.clock.set_fixed_time('2026-11-09T15:00:00+03:00')
    page.on('console', lambda m: m.type in ('error', 'warning') and problems.append(f'console {m.type}: {m.text}'))
    page.on('pageerror', lambda e: problems.append(f'pageerror: {e}'))
    return ctx, page


def shot(page, name, full=False):
    page.wait_for_timeout(250)
    path = OUT / f'{len(shots) + 1:02d}-{name}.png'
    page.screenshot(path=str(path), full_page=full)
    shots.append(path.name)
    # Горизонтальная прокрутка страницы — признак вылезающей вёрстки.
    over = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    if over > 0:
        problems.append(f'{name}: страница шире экрана на {over}px')


def idle(page):
    page.wait_for_function("!document.getElementById('sync').classList.contains('spin')")
    page.wait_for_timeout(150)


with sync_playwright() as p:
    browser = p.chromium.launch()

    # 1. Первый запуск без токена
    ctx, page = new_page(browser, p, token=False)
    page.goto(BASE)
    page.wait_for_selector('#conn')
    shot(page, 'first-run-settings')
    shot(page, 'first-run-settings-full', full=True)
    ctx.close()

    # 2. Основные экраны
    ctx, page = new_page(browser, p)
    page.goto(BASE)
    page.wait_for_selector('#plist .row')
    idle(page)
    page.wait_for_function("document.getElementById('inboxBadge').textContent === '2'")
    shot(page, 'projects')

    page.click('#newProject')
    shot(page, 'new-project-sheet')
    page.click('#sheet [data-close].link')

    page.goto(BASE + '#/p/primer-ograzhdenie/chat')
    page.wait_for_selector('.msg')
    page.wait_for_timeout(400)
    shot(page, 'chat-bottom')
    page.evaluate('window.scrollTo(0, 0)')
    shot(page, 'chat-top')
    # перекрытие последнего сообщения панелью ввода
    ov = page.evaluate("""() => { const m = [...document.querySelectorAll('.msg')].at(-1).getBoundingClientRect();
      window.scrollTo(0, document.documentElement.scrollHeight);
      const m2 = [...document.querySelectorAll('.msg')].at(-1).getBoundingClientRect(), c = document.getElementById('composer').getBoundingClientRect();
      return { msgBottom: m2.bottom, composerTop: c.top }; }""")
    if ov['msgBottom'] > ov['composerTop']:
        problems.append(f'chat: последнее сообщение под панелью ввода {ov}')
    page.click('#msg')
    page.fill('#msg', '@Claude проверь, пожалуйста, длину стоек — 900 мм от земли или от кольца?')
    shot(page, 'chat-typing')
    page.click('#sendBtn')
    page.wait_for_function("[...document.querySelectorAll('.msg .text')].some(x => x.textContent.includes('длину стоек'))")
    idle(page)
    page.evaluate('document.activeElement && document.activeElement.blur()')
    page.wait_for_timeout(300)
    shot(page, 'chat-sent')
    page.click('[data-reply]')
    shot(page, 'chat-reply')
    page.click('#noReply')
    page.click('#manual')
    shot(page, 'chat-manual-help')
    page.click('#sheet [data-close].link')
    page.click('.att')
    page.wait_for_selector('#sheetBody .btns')
    shot(page, 'chat-attachment-sheet')
    page.click('#sheet [data-close].link')

    for tab in ['over', 'docs', 'files', 'tasks', 'cost', 'src', 'log']:
        page.goto(BASE + f'#/p/primer-ograzhdenie/{tab}')
        page.wait_for_timeout(500)
        shot(page, f'tab-{tab}')
        if tab in ('over', 'docs', 'cost'):
            shot(page, f'tab-{tab}-full', full=True)

    page.goto(BASE + '#/p/primer-ograzhdenie/files')
    page.wait_for_selector('[data-kind="work"]')
    page.click('[data-kind="work"] >> nth=0')
    page.wait_for_selector('#sheetBody textarea, #sheetBody pre')
    shot(page, 'file-viewer-editable')
    page.fill('#sheetBody textarea', 'Хлыст;Длина, мм\n1;6000\n')
    page.click('#sheetOk')
    page.wait_for_function("document.getElementById('sheet').hidden")
    content = page.evaluate("window.__gh.read('projects/primer-ograzhdenie/files/work/raskroy-truby.csv')")
    if content != 'Хлыст;Длина, мм\n1;6000\n':
        problems.append(f'сохранение файла: в репозитории {content!r}')
    idle(page)
    page.click('#newText')
    shot(page, 'new-text-file-sheet')
    page.click('#sheet [data-close].link')

    page.goto(BASE + '#/p/primer-ograzhdenie/src')
    page.wait_for_timeout(400)
    page.click('.grid button')
    page.wait_for_selector('#sheetBody img')
    shot(page, 'photo-viewer')
    page.click('#sheet [data-close].link')

    page.goto(BASE + '#/p/primer-ograzhdenie/tasks')
    page.wait_for_selector('[data-task]')
    page.click('[data-task]')
    shot(page, 'task-sheet')
    page.click('#sheet [data-close].link')
    page.click('#addDec')
    shot(page, 'decision-sheet')
    page.click('#sheet [data-close].link')

    page.goto(BASE + '#/p/primer-ograzhdenie/cost')
    page.wait_for_selector('[data-item]')
    page.click('[data-item]')
    shot(page, 'cost-item-sheet')
    page.click('#sheet [data-close].link')

    page.goto(BASE + '#/p/primer-ograzhdenie/docs')
    page.wait_for_selector('[data-status]')
    page.click('[data-addrev]')
    shot(page, 'revision-sheet')
    page.click('#sheet [data-close].link')
    page.click('[data-status]')
    shot(page, 'status-sheet')
    page.click('#sheet [data-close].link')

    page.goto(BASE + '#/inbox')
    page.wait_for_selector('.row')
    shot(page, 'inbox')
    page.click('.row')
    page.wait_for_selector('#accept')
    shot(page, 'pr-detail')
    shot(page, 'pr-detail-full', full=True)
    page.click('#reject')
    shot(page, 'pr-reject-sheet')
    page.click('#sheet [data-close].link')

    page.goto(BASE + '#/log')
    page.wait_for_selector('.row')
    shot(page, 'log')

    page.goto(BASE + '#/settings')
    page.wait_for_selector('#conn')
    page.wait_for_timeout(300)
    shot(page, 'settings')
    shot(page, 'settings-full', full=True)

    # 3. Без связи
    page.goto(BASE + '#/p/primer-ograzhdenie/chat')
    page.wait_for_selector('.msg')
    page.evaluate('window.__gh.offline = true')
    page.click('#sync')
    page.wait_for_selector('#banner:not([hidden])')
    page.fill('#msg', 'Без связи: проверю на объекте завтра.')
    page.click('#sendBtn')
    page.wait_for_function("document.getElementById('view').textContent.includes('ждёт отправки')")
    page.evaluate('document.activeElement && document.activeElement.blur()')
    shot(page, 'offline-chat')
    page.goto(BASE + '#/')
    page.wait_for_timeout(300)
    shot(page, 'offline-projects')
    page.goto(BASE + '#/inbox')
    page.wait_for_timeout(300)
    shot(page, 'offline-inbox')
    page.evaluate("window.__gh.offline = false; window.dispatchEvent(new Event('online'))")
    page.wait_for_function("document.getElementById('banner').hidden", timeout=10000)
    page.goto(BASE + '#/')
    page.wait_for_timeout(300)
    shot(page, 'back-online')
    ctx.close()

    # 4. Первый запуск без связи и без копии
    ctx, page = new_page(browser, p)
    page.add_init_script('window.__gh && (window.__gh.offline = true)')
    page.goto(BASE)
    page.wait_for_selector('#banner:not([hidden])')
    shot(page, 'offline-no-copy')
    ctx.close()

    browser.close()

print('Снимки:', *shots, sep='\n  ')
print('Замечания:' if problems else 'Замечаний нет', *problems, sep='\n  ')
sys.exit(1 if problems else 0)
