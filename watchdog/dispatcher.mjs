#!/usr/bin/env node
/*
  Сторож черги нотаток — довгоживучий процес, який замінює людину на кінці
  `notes_watch`.

  Проблема, яку він знімає. Сервер нот (:4747) уміє довге опитування, MCP-міст
  уміє на ньому висіти, але висить він тільки поки в терміналі сидить жива
  Claude-сесія і хтось свідомо викликав `notes_watch`. Тобто нота лежала не
  тому, що її нікому виконати, а тому, що нікому помітити. Сторож прибирає з
  цього ланцюга людину: він сам висить на watch, сам бере ноту й сам запускає
  headless-виконавця `claude -p`.

  Хвіст конвеєра теж його: коли виконавець поставив `resolved`, сторож складає
  теку правки `data/fixes/<id>/` (метадані, запит із тредом, кадр, лог прогону),
  перезбирає з тек індекс `data/fixlog.md` — і аж тоді видаляє ноту. Порядок
  саме такий: тека і є пам'ять про правку, і поки вона не записана, ноту
  чіпати не можна. Проміжного стану «зроблено, чекає на перевірку» немає навмисно — користувач дивиться на екран, а не клікає кнопку
  в таблиці, тож тримати закриту правку в сторі нема кому і нема навіщо.

  Що він НЕ робить — так само важливо:
  - не видаляє нот ніде, крім гілки `ГОТОВО`. На `ЗБІЙ`, `ТАЙМАУТ` і `ПИТАННЯ`
    нота лишається у сторі: там ще є що робити людині або роботу;
  - не чіпає нот, у яких останнє слово в треді за агентом. Такий стан означає
    «чекаємо відповіді користувача», і взяти таку ноту в роботу — це почати
    гадати замість того, щоб дочекатися відповіді;
  - не тримає ноту у `working` мовчки. Виконавець упав або переліз таймаут —
    нота вертається в `pending`, а в тред лягає рядок від агента. Користувач
    має бачити поломку, а не порожню тишу під написом «в роботі».

  Друга черга — доробки. Кнопка Send back на рев'ю-сторінці кладе на :4748
  ітерацію «правку зроблено не так», і це не нова нота, а другий підхід до вже
  закритої правки: ноти давно немає, зате є тека `data/fixes/<id>/` з усім, що
  про ту правку знали. Сторож опитує `GET :4748/rework`, збирає з теки й
  тексту ітерації окремий бриф (`rework-template.md`) і запускає виконавця тим
  самим механізмом, що й на ноті — спільна стеля, той самий таймаут, той самий
  `state.json`. Успіх закриває ітерацію через `POST :4748/rework-done`,
  записуючи в неї, що саме переробили; будь-який інший кінець лишає ітерацію
  ВІДКРИТОЮ. Закрити недороблену ітерацію — це стерти єдиний слід того, що
  роботу треба доробити.

  Нуль npm-залежностей — навмисно. `npm install` у цьому репозиторії періодично
  вирізає extraneous-пакети, і сторож, який від такого вмирає, не сторож.

  Дані сторожу не належать: усе через HTTP до :4747. На диску він тримає лише
  лог і `state.json` — pid та час взяття для кожного живого прогону. Стан цей
  не про дані, а про процеси: без нього нота у `working` після ребуту
  нерозрізненна з нотою, чий виконавець нас пережив (юніт іде з
  KillMode=process). Рестарт — це новий підбір беклогу плюс звірка цього
  файлу з тим, які процеси досі живі.
*/

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { buildIndex } from '../server/build-index.mjs'
import config, { configComplaints } from '../config.mjs'
import { readTemplate, renderTemplate } from './template.mjs'

const HERE = import.meta.dirname
/* Корінь проєкту-господаря: там стартує виконавець. Береться з конфіга, а не
   від cwd — юніт systemd має свій WorkingDirectory, а запуск руками свій, і
   виконавець мусить стартувати в репозиторії в обох випадках. Дефолт конфіга
   («на рівень вище за harness») вірний для звичайного розкладу. */
const REPO = config.projectRoot

const NOTES_URL = process.env.NOTES_URL || `http://127.0.0.1:${config.notesPort}`
/* Другий сервер, друга черга. Ноти знають відкриту роботу, сервер вердиктів —
   вже закриту (`data/fixlog-ratings.json`). Кнопка Send back на рев'ю-сторінці
   кладе доробку саме туди, і поки сюди ніхто не ходив, вона рапортувала успіх
   у порожнечу: черга є, читача немає. */
const RATINGS_URL = process.env.RATINGS_URL || `http://127.0.0.1:${config.ratingsPort}`
const LOG_FILE = path.join(HERE, 'dispatcher.log')
const RUNS_DIR = path.join(HERE, 'runs')
const TEMPLATE_FILE = path.join(HERE, 'brief-template.md')
const REWORK_TEMPLATE_FILE = path.join(HERE, 'rework-template.md')

/* Числа беруться з конфіга (`config.mjs`), який їх уже провалідував: env-
   перевизначення читаються там же, і криве значення там відкочується до
   дефолту зі скаргою. Скарги друкуємо першим рядком після старту, бо лог тут
   ще не готовий у мить читання конфіга. */
const envComplaints = configComplaints

/* Стеля одночасних виконавців. Двох досить: кожен — це повноцінна Claude-сесія
   з файловими правками, і четверо таких на одному репозиторії частіше заважають
   одне одному, ніж пришвидшують. */
const MAX_WORKERS = config.watchdog.maxWorkers
/* Прогін без стелі — це процес, який висить до кінця світу і тримає ноту
   у `working`. П'ятнадцять хвилин — це вже точно не «думає», а «застряг». */
const RUN_TIMEOUT_MS = config.watchdog.runTimeoutMin * 60_000
const WATCH_TIMEOUT_S = config.watchdog.watchTimeoutS
/* Періодичне перепрочитування стору: watch віддає лише створення нот і
   репліки людини, а зміну статусу не віддає взагалі. Тобто «виконавець, що
   пережив рестарт сторожа, поставив resolved» без опитування не буде помічено
   ніколи. Хвилина — компроміс між затримкою й зайвими GET-ами. */
const SWEEP_MS = config.watchdog.sweepS * 1000
/* Пауза перед виходом на зайнятому замку — щоб рестарт юніта не молотив
   кожні п'ять секунд, поки живий ручний сторож. */
const BUSY_WAIT_MS = config.watchdog.busyWaitS * 1000
/* Доробки не мають свого watch: :4748 уміє тільки `GET /rework`, тож черга
   опитується. Гарячою вона не буває — між «користувач подивився правку» і
   «натиснув Send back» проходять хвилини, і будити опитування частіше, ніж
   прохід по сирітках, немає сенсу. Тому та сама хвилина. */
const REWORK_POLL_MS = config.watchdog.reworkPollS * 1000
/* Скільки разів пробувати одну й ту саму ітерацію. Ітерація лишається
   відкритою після провалу — і без стелі сторож ганяв би виконавця по колу
   щохвилини на брифі, який уже один раз не спрацював. Друга спроба має сенс
   (упав інструмент, сплив таймаут), третя — ні: це вже не випадковість, а
   бриф, з яким виконавцю нема чого робити, і далі потрібна людина. Стеля
   привʼязана до тексту ітерації: користувач переписав зауваження — лічильник
   з нуля, бо це вже інший запит. */
const REWORK_MAX_ATTEMPTS = config.watchdog.reworkAttempts
/* Виконавці: не один, а набір профілів із конфіга (`executors.order` —
   від слабкого до сильного, `executors.profiles` — чим і як запускати).
   Профіль обирає класифікатор; сторож лише запускає обраний. Усе, що
   міняється в чужому проєкті (шлях до бінарника, модель, набір прапорців),
   лишається в конфізі. `{{BRIEF}}` в аргументах — місце під текст брифу,
   `{{MODEL}}` — під імʼя моделі профілю. */
const EXECUTOR_ORDER = config.executors.order
const EXECUTOR_PROFILES = config.executors.profiles
/* Сильний профіль — останній у порядку. Він же дефолт на всі випадки, коли
   маршрутизувати нема чим: класифікатор вимкнено, впав, віддав сміття, або
   спрацювала ескалація. Помилятись у бік якості дешевше, ніж у бік ціни. */
const STRONG = EXECUTOR_PROFILES[EXECUTOR_ORDER[EXECUTOR_ORDER.length - 1]]
const executorArgv = (profile, brief) =>
  profile.args.map((a) => a.replaceAll('{{BRIEF}}', brief).replaceAll('{{MODEL}}', profile.model))

/* Коди виходу розведені навмисно, бо на них дивиться systemd
   (`RestartPreventExitStatus=0` у юніті):
     0  — свідома зупинка (SIGTERM/SIGINT). Підіймати назад не треба;
     3  — замок зайнято. Обставина тимчасова, юніт МУСИТЬ спробувати ще;
     1  — падіння (ФАТАЛЬНО). Підіймати. */
const EXIT_STOPPED = 0
const EXIT_BUSY = 3

const LOG_MAX_BYTES = 5 * 1024 * 1024
const LOG_KEEP_BYTES = 1024 * 1024

/* Історія правок. Джерело істини — тека `data/fixes/<id>/`, а `fixlog.md` це
   похідний індекс, який перезбирається з тек (`server/build-index.mjs`).
   Дописувати в індекс не можна: наступна перегенерація затре дописане. */
const HARNESS = path.resolve(HERE, '..')
const DATA_DIR = path.join(HARNESS, 'data')
const FIXES_DIR = path.join(DATA_DIR, 'fixes')
/* Колонка «Агент» — смуга виконавця, а не назва процесу. Підпис береться з
   профілю, яким правку зробили: відколи профілів кілька, константа тут
   означала б, що історія бреше про половину правок. */

/* ────────────────────────────── лог ────────────────────────────── */

/* Лог читає людина, коли щось пішло не так, тож формат рядковий і однаковий:
   час, подія, id ноти, суть. Одна подія — один рядок; багатослівний вивід
   виконавця сюди не тече, для нього окремі файли в runs/. */
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    rotate()
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    /* Лог не має права вбити сторожа. */
  }
  process.stdout.write(line)
}

function rotate() {
  let size = 0
  try {
    size = fs.statSync(LOG_FILE).size
  } catch {
    return
  }
  if (size <= LOG_MAX_BYTES) return
  const fd = fs.openSync(LOG_FILE, 'r')
  const buf = Buffer.alloc(LOG_KEEP_BYTES)
  fs.readSync(fd, buf, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES)
  fs.closeSync(fd)
  fs.writeFileSync(LOG_FILE, `--- лог обрізано ${new Date().toISOString()} ---\n${buf.toString()}`)
}

/* ───────────────────────── замок інстансу ───────────────────────── */

/*
  Захист «одна нота — один виконавець» у сторожі процесний: мапа `running`
  живе в памʼяті. Два сторожі (юніт і запущений руками) висять на одному
  `/notes/watch`, бачать ту саму подію — і нота дістає двох виконавців, які
  правлять один файл за одним брифом. Тож захист має бути машинний, а не
  процесний: другий інстанс просто не стартує.

  Механізм — абстрактний unix-сокет (`\0`-namespace Linux). Ключове: він не
  має імені у файловій системі, і ядро звільняє його разом із процесом. Після
  `kill -9` наступний старт бере замок без ручного прибирання — на відміну від
  pidfile, який лишає по собі сирітку, і від sockfile у /tmp, який лишає inode.
  Бонусом сокет відповідає своїм pid: другий інстанс не гадає, хто його
  випередив, а називає в лозі конкретний процес.

  Замок іменований по uid: абстрактний namespace спільний на всю мережеву
  namespace, тож без uid сторож одного користувача блокував би іншого.
*/
const LOCK_NAME = process.env.WATCHDOG_LOCK || `${config.prefix}-watchdog.${os.userInfo().uid}`
const LOCK_ADDR = `\0${LOCK_NAME}`

/* Хто тримає замок: підключаємось і читаємо pid, який власник віддає першим
   же рядком. Не вийшло (старий інстанс без цієї відповіді, гонка на закритті)
   — повертаємо null, це не привід падати. */
function probeLockHolder() {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (pid) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(pid)
    }
    const sock = net.connect(LOCK_ADDR)
    sock.setTimeout(2000, () => finish(null))
    sock.on('data', (chunk) => {
      data += chunk
    })
    sock.on('end', () => finish(Number(data.trim()) || null))
    sock.on('error', () => finish(null))
  })
}

function acquireLock() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => sock.end(`${process.pid}\n`))
    server.once('error', (err) => {
      if (err.code !== 'EADDRINUSE') {
        /* Не Linux або ядро не дало сокет — сторож важливіший за замок:
           працюємо без нього, але кажемо про це вголос. */
        resolve({ ok: true, degraded: err.message })
        return
      }
      void probeLockHolder().then((pid) => resolve({ ok: false, pid }))
    })
    server.listen(LOCK_ADDR, () => {
      /* unref: замок не має сам по собі тримати event loop живим. */
      server.unref()
      resolve({ ok: true, server })
    })
  })
}

/* ──────────────────────────── тека правки ──────────────────────────── */

/* Закриття ноти = створення теки `data/fixes/<id>/`. Це і є пам'ять про
   правку: у ній лежить усе, що знали про неї нота (запит, селектор, ланцюг
   компонентів, кадр) і прогін (лог виконавця, тривалість). Індекс
   `fixlog.md` після цього перезбирається з тек — дописувати в нього рядок
   більше не можна, бо він похідний.

   Текст «що зроблено» сторож не вигадує: його пише виконавець у тред ноти
   перед тим, як поставити `resolved` (див. `brief-template.md`). Сторож знає
   прогін і його тривалість, виконавець — зміст правки. */

const two = (n) => String(n).padStart(2, '0')
const localStamp = (d) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`

/* Перенос рядка в `did`/`note` знімаємо вже тут: комірка Markdown-таблиці
   однорядкова, і багаторядковий звіт виконавця ламає таблицю. А от пайп тут
   НЕ екрануємо: тека — джерело істини й має тримати текст незайманим,
   екранування для Markdown робить рендер індексу (`server/build-index.mjs`).
   Подвійне екранування зсувало колонки, і сторінка читала з рядка сміття
   замість `id`. Повний, неторканий текст лишається в `note.md` поруч. */
const flat = (s) =>
  String(s ?? '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()

/* Опис правки беремо лише з реплік агента, що лягли ПІСЛЯ останнього слова
   людини. Інакше нота, де агент колись питав, а потім мовчки зарезолвив,
   записала б у історію старе питання замість того, що зроблено. */
function doneText(note) {
  const thread = note.thread || []
  let lastHuman = -1
  thread.forEach((m, i) => {
    if (m.role === 'human') lastHuman = i
  })
  const said = thread.slice(lastHuman + 1).filter((m) => m.role === 'agent')
  if (said.length) return said.map((m) => m.content).join(' ')
  return 'Виконавець не лишив опису правки в треді — деталі в `run.log`.'
}

/* Файли беремо з того самого тексту: виконавець називає їх шляхом від кореня
   репозиторію. Не знайшлось — порожній список, вигадувати нема з чого. */
const FILE_RE = /(?:src|public|comments-harness|docs|scripts)\/[\w./@-]*\.\w{1,6}/g
function filesFrom(text) {
  return [...new Set(String(text || '').match(FILE_RE) || [])]
}

function routeOf(note) {
  try {
    return new URL(note.url).pathname
  } catch {
    /* кривий url — роуту немає, це не привід не записати правку */
    return null
  }
}

function noteMarkdown(note, fix) {
  const parts = [
    `# ${fix.id}`,
    '',
    `**Коли:** ${localStamp(new Date(fix.createdAt))}`,
    `**Роут:** ${fix.route ? `\`${fix.route}\`` : '—'}${fix.url ? ` (${fix.url})` : ''}`,
    `**Виконавець:** ${fix.agent} (${fix.lane})`,
    fix.durationMs == null ? '**Тривалість:** невідома' : `**Тривалість:** ${(fix.durationMs / 60000).toFixed(1)}хв`,
    '',
    '## Запит',
    '',
    note.note || '—',
    '',
    '## Елемент',
    '',
    `- селектор: \`${fix.selector || '—'}\``,
    `- повний шлях: \`${fix.fullPath || '—'}\``,
    `- тег/класи: \`${fix.tagName || '—'}\` · \`${fix.classes || '—'}\``,
    `- компоненти: ${fix.components.length ? fix.components.join(' → ') : '—'}`,
    `- rect: ${fix.rect ? `${fix.rect.w}×${fix.rect.h} @ ${fix.rect.x},${fix.rect.y}` : '—'}`,
    `- viewport: ${fix.viewport ? `${fix.viewport.w}×${fix.viewport.h}` : '—'}`,
    note.text ? `- текст: ${note.text}` : '- текст: —',
    '',
    '## Тред',
    '',
  ]
  const thread = note.thread || []
  if (thread.length) for (const m of thread) parts.push(`- **${m.role}** (${m.at}): ${m.content}`)
  else parts.push('_порожній — користувач нічого не уточнював_')
  if (note.outerHTML) {
    parts.push('', '## outerHTML', '', '```html', note.outerHTML, '```')
  }
  return `${parts.join('\n')}\n`
}

/* Кадр і лог прогону саме ПЕРЕНОСИМО, а не копіюємо: осиротілі файли в
   `shots/` і `runs/` — одна з причин, чому теку взагалі завели. Копія в теку
   йде до коміту (перейменування tmp → `<id>`), а оригінал зникає аж після
   успішного `DELETE` ноти: поки нота жива, вона посилається на кадр полем
   `shot`, і прибраний оригінал дав би битий `<img>` на рев'ю-сторінці й
   неіснуючий PNG у брифі, якби ноту повернули в роботу. */
function carry(src, dstDir, name, staged) {
  if (!src || !fs.existsSync(src)) return null
  fs.copyFileSync(src, path.join(dstDir, name))
  staged.push(src)
  return name
}

/* Тека створюється атомарно: збираємо у `.tmp-…` поруч і перейменовуємо.
   Читач індексу або рев'ю-сторінка не мають спіймати напівтеку. */
/* Слід консультацій, які виконавець устиг зробити за цей прогін. Пише його
   `ask-consultant.mjs` поруч зі стором, бо теки правки в той момент ще немає;
   підбираємо тут і кладемо в `fix.json` поруч із рішенням класифікатора —
   щоб питання ціни закривалося цифрами, а не здогадкою. */
const CONSULTS_DIR = path.join(DATA_DIR, 'consults')

function readConsults(id) {
  const file = path.join(CONSULTS_DIR, `${id}.json`)
  try {
    const all = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(all) && all.length ? { file, all } : null
  } catch {
    return null
  }
}

function writeFix(note, { ms, runLog, closedAt = new Date(), profile = STRONG, triage = null }) {
  const dir = path.join(FIXES_DIR, note.id)
  if (fs.existsSync(dir)) {
    log(`УВАГА ${note.id} · тека правки вже існує — не переписую (тека незмінна після створення)`)
    return { dir, staged: [] }
  }
  const tmp = path.join(FIXES_DIR, `.tmp-${note.id}-${process.pid}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })

  const staged = []
  try {
    const shotSrc = note.shot ? path.join(DATA_DIR, note.shot) : null
    const shot = carry(shotSrc, tmp, 'shot.png', staged)
    carry(runLog, tmp, 'run.log', staged)
    /* Слід консультацій — у `staged`, тобто прибереться разом із оригіналом
       кадру, після того як ноти вже не буде. */
    const consults = readConsults(note.id)
    if (consults) staged.push(consults.file)

    const did = flat(doneText(note))
    const fix = {
      id: note.id,
      createdAt: note.createdAt,
      closedAt: closedAt.toISOString(),
      durationMs: ms == null ? null : Math.round(ms),
      note: flat(note.note),
      url: note.url || null,
      route: routeOf(note),
      selector: note.selector || null,
      fullPath: note.fullPath || null,
      tagName: note.tagName || null,
      classes: note.classes || null,
      components: note.components || [],
      rect: note.rect || null,
      viewport: note.viewport || null,
      lane: 'claude',
      agent: profile.label,
      /* Рішення маршрутизації лягає в теку разом із правкою — інакше правило
         нема як уточнювати: видно, що чим зроблено, і де класифікатор
         помилився. `source` каже, хто вирішив: сам класифікатор, ескалація
         поверх нього, чи запасний варіант після його відмови. */
      triage: triage || {
        level: profile.name,
        why: 'маршрутизації не було',
        source: 'default',
        model: null,
      },
      /* Скільки разів виконавець ходив до консультанта, по скільки секунд і
         що вирішено. Порожній список — теж відповідь: правку зробили без
         жодної консультації. */
      consults: consults ? consults.all : [],
      did,
      files: filesFrom(did),
      shot,
      outcome: 'done',
    }
    fs.writeFileSync(path.join(tmp, 'fix.json'), `${JSON.stringify(fix, null, 2)}\n`)
    fs.writeFileSync(path.join(tmp, 'note.md'), noteMarkdown(note, fix))
    fs.renameSync(tmp, dir)
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw err
  }

  /* Оригінали НЕ прибираємо тут: тека закомічена, але нота ще жива й на кадр
     посилається. Список віддаємо нагору — прибере `closeNote` після `DELETE`. */
  return { dir, staged }
}

/* Прибирання оригіналів після того, як ноти вже немає. Не вдалось — не біда:
   копія вже в теці, а сирота в `shots/` максимум займає місце. ENOENT тут
   узагалі штатний: `DELETE /notes/:id` прибирає кадр ноти сам, і рядок про це
   в лозі був би шумом на кожну закриту правку. */
function dropOriginals(id, staged) {
  for (const src of staged || []) {
    try {
      fs.rmSync(src)
    } catch (err) {
      if (err.code === 'ENOENT') continue
      log(`УВАГА ${id} · не прибрали ${src}: ${err.message}`)
    }
  }
}

/* Осколки `.tmp-<id>-<pid>/` лишає смерть у щілину між `mkdir` і `rename`:
   прибрати їх нема кому, бо той процес уже не існує. Тека правки атомарна,
   тож будь-який `.tmp-*` на старті — це гарантовано сміття. */
function sweepTmpDirs() {
  let entries
  try {
    entries = fs.readdirSync(FIXES_DIR, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.name.startsWith('.tmp-')) continue
    try {
      fs.rmSync(path.join(FIXES_DIR, e.name), { recursive: true, force: true })
      log(`ПРИБРАНО осколок data/fixes/${e.name}`)
    } catch (err) {
      log(`УВАГА · не прибрали осколок ${e.name}: ${err.message}`)
    }
  }
}

/* Запис серіалізований ланцюжком промісів: виконавців двоє, фінішувати вони
   можуть одночасно, а перегенерація індексу читає всі теки разом. */
let closeChain = Promise.resolve()

function saveFix(note, opts) {
  const run = closeChain.then(() => {
    const written = writeFix(note, opts)
    const res = buildIndex()
    log(`ІНДЕКС · ${res.count} правок · ${res.bytes} Б`)
    return written
  })
  /* Помилка одного запису не має отруїти чергу наступним: у ланцюг кладемо
     проковтнутий проміс, а справжній віддаємо тому, хто закриває ноту. */
  closeChain = run.catch(() => {})
  return run
}

/* ────────────────────────────── HTTP ────────────────────────────── */

async function http(base, method, urlPath, body, timeoutMs = 15_000) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

const api = (method, urlPath, body, timeoutMs) => http(NOTES_URL, method, urlPath, body, timeoutMs)
/* Той самий транспорт до сервера вердиктів. Окрема функція, а не параметр у
   кожному виклику: переплутати два сервери місцями — це PATCH ноти, який
   пішов у файл оцінок, і навпаки. */
const ratingsApi = (method, urlPath, body, timeoutMs) =>
  http(RATINGS_URL, method, urlPath, body, timeoutMs)

const getNote = async (id) => (await api('GET', '/notes')).find((n) => n.id === id) || null
const setStatus = (id, status) => api('PATCH', `/notes/${id}`, { status })
const reply = (id, content) => api('PATCH', `/notes/${id}`, { reply: { role: 'agent', content } })
const removeNote = (id) => api('DELETE', `/notes/${id}`)

/* ───────────────────────── правила відбору ───────────────────────── */

/* Останнє слово в треді за агентом = агент щось запитав і чекає людину.
   Брати таку ноту в роботу не можна: питання поставили саме тому, що
   механічної відповіді немає, і повторний запуск дасть те саме питання
   або, гірше, здогадку. Це те правило, завдяки якому підбір беклогу не
   чіпає нот, які насправді чекають на користувача, а не на робота. */
function waitingForHuman(note) {
  const thread = note.thread || []
  return thread.length > 0 && thread[thread.length - 1].role === 'agent'
}

function dispatchable(note) {
  return note.status === 'pending' && !waitingForHuman(note)
}

/* Момент події для ноти відносно курсора `since` — рівно ті дві події, що
   їх знає сервер: створення ще-не-взятої ноти й дописка від людини. Курсор
   рухаємо по максимуму з них, інакше та сама відповідь користувача будила б
   сторожа вічно. */
function eventTime(note, sinceMs) {
  let ts = 0
  if (note.status === 'pending') {
    const created = Date.parse(note.createdAt)
    if (created > sinceMs) ts = Math.max(ts, created)
  }
  for (const m of note.thread || []) {
    if (m.role !== 'human') continue
    const at = Date.parse(m.at)
    if (at > sinceMs) ts = Math.max(ts, at)
  }
  return ts
}

/* ────────────────────────────── бриф ────────────────────────────── */

/* Шаблон читаємо на кожен запуск, а не один раз на старті: бриф правитимуть
   частіше за логіку, і правка тексту не має вимагати рестарту юніта. */
function buildBrief(note) {
  const tpl = readTemplate(TEMPLATE_FILE)
  const thread = (note.thread || []).length
    ? note.thread.map((m) => `- **${m.role}** (${m.at}): ${m.content}`).join('\n')
    : '_порожній — користувач нічого не уточнював_'
  let route = '—'
  try {
    route = new URL(note.url).pathname
  } catch {
    /* url може бути кривим — тоді просто немає роуту, це не привід падати */
  }
  /* Кадр елемента. У ноті лежить шлях відносно `data/` (або нічого — старі
     ноти поля не мають). Виконавцю потрібен абсолютний: він відкриває файл
     `Read`, а cwd у нього корінь репозиторію, не тека сторожа. Шлях беремо
     від `DATA_DIR`, а не складаємо руками з назв тек: перейменування harness
     інакше ламало б бриф мовчки.

     Наявність файлу перевіряємо: нота може посилатись на кадр, якого вже
     немає (прибрали руками, не доїхав аплоад). Бриф, що впевнено каже
     «відкрий цей PNG», коштує виконавцю кількох марних `Read` і здогадки
     замість кадру — краще взагалі без згадки про знімок. */
  let shotAbs = note.shot ? path.join(DATA_DIR, note.shot) : null
  if (shotAbs && !fs.existsSync(shotAbs)) {
    log(`УВАГА ${note.id} · кадр ${note.shot} у ноті є, а файлу немає — бриф без кадру`)
    shotAbs = null
  }
  const values = {
    ID: note.id,
    URL: note.url,
    ROUTE: route,
    VIEWPORT: note.viewport ? `${note.viewport.w}×${note.viewport.h}` : '—',
    SELECTOR: note.selector,
    FULLPATH: note.fullPath,
    TAGNAME: note.tagName,
    CLASSES: note.classes,
    TEXT: note.text,
    OUTERHTML: note.outerHTML,
    COMPONENTS: (note.components || []).join(' → '),
    NOTE: note.note,
    THREAD: thread,
    NOTES_URL: NOTES_URL,
  }
  /* Гілка «незрозуміло» — рівно одна з двох, і вибирає її конфіг. Дві одразу
     означали б бриф, який радить і питати консультанта, і зупинитись. */
  if (config.consultant.enabled) {
    values.CONSULT = 'yes'
    /* Шлях від кореня проєкту: виконавець стартує саме там. */
    values.CONSULT_CMD = path.relative(REPO, path.join(HERE, 'ask-consultant.mjs'))
  } else {
    values.ASKHUMAN = 'yes'
  }
  if (shotAbs) values.SHOT = shotAbs
  Object.assign(values, spacingValues(note))

  return renderTemplate(tpl, values)
}

/* Проміжок. Поля `spacing` у звичайної ноти немає взагалі, і саме його
   відсутність вимикає весь блок у шаблоні: ключ `SPACING` лишається
   невизначеним, `{{#SPACING}}…{{/SPACING}}` викидається цілком, прочерків у
   брифі не з'являється. Список джерел збираємо тут, а не в шаблоні: шаблон
   уміє лише підставляти рядок, а джерел від нуля до дюжини. */
function spacingValues(note) {
  const sp = note.spacing
  if (!sp || typeof sp !== 'object') return {}
  const between = Array.isArray(sp.between) ? sp.between : [null, null]
  const side = (v) => (v ? `\`${v}\`` : '`(кромка)`')
  const sources = Array.isArray(sp.sources) ? sp.sources : []
  const list = sources.length
    ? sources
        .map(
          (s) =>
            `- \`${s.kind}\` на ${s.selector ? `\`${s.selector}\`` : '(селектор невідомий)'} — ` +
            `\`${s.property}: ${s.value}\``,
        )
        .join('\n')
    : '_оверлей не зміг назвати джерело — шукай по коду сам_'
  return {
    /* Гейт умовного блока. Значення сюди ж і друкується не буде — у шаблоні
       вживаються лише вкладені ключі, — але воно мусить бути непорожнім. */
    SPACING: 'yes',
    SPACING_PX: sp.px,
    SPACING_AXIS: sp.axis,
    SPACING_BETWEEN: `${side(between[0])} і ${side(between[1])}`,
    SPACING_SOURCES: list,
  }
}

/* ─────────────────────────── бриф доробки ─────────────────────────── */

/*
  Доробка — не нова нота, а ДРУГИЙ підхід до вже закритої правки, і бриф у неї
  інший по суті, а не по формулюванню. Нова нота починається з чистого аркуша:
  ось елемент, ось зауваження, роби. Доробка починається з того, що одна
  спроба вже була, користувач її бачив і вона його не влаштувала — і головна
  цінність тут не в описі елемента, а в тому, ЧОМУ не влаштувала.

  Звідси і джерела. Ноти вже немає (сторож видалив її, закриваючи правку), тож
  контекст береться з теки `data/fixes/<id>/`: `fix.json` тримає початковий
  запит, селектор, ланцюг компонентів, що зробив попередній виконавець і в
  яких файлах, а поруч може лежати `shot.png`. Текст ітерації приходить з
  :4748 — це слова користувача, заради яких усе й затіяно.

  Теку ми при цьому НЕ чіпаємо: правка вже сталася, і історію заднім числом
  не переписують.
*/
function fixDirOf(id) {
  return path.join(FIXES_DIR, id)
}

function readFixJson(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(fixDirOf(id), 'fix.json'), 'utf8'))
  } catch {
    return null
  }
}

/* Закриті ітерації — це вже готові пари «чому не влаштувало → що переробили».
   Виконавцю третього підходу вони кажуть найважливіше: що вже пробували і
   чим це скінчилось. Відкрита (остання) сюди не йде — вона і є завдання. */
function reworkHistory(rating) {
  const list = Array.isArray(rating?.reworks) ? rating.reworks : rating?.rework ? [rating.rework] : []
  const closed = list.filter((r) => r && r.done)
  if (!closed.length) return ''
  return closed
    .map((r, i) => `${i + 1}. Не влаштувало: ${flat(r.note)}\n   Переробили: ${flat(r.result) || '— (виконавець не лишив опису)'}`)
    .join('\n')
}

/* Скільки разів правку повертали, рахуючи цей раз. Те саме число йде в
   бриф доробки і в контекст класифікатора. */
const reworkRound = (rating) =>
  (Array.isArray(rating?.reworks) ? rating.reworks : rating?.rework ? [rating.rework] : []).length

function buildReworkBrief(fix, rating, iteration) {
  const tpl = readTemplate(REWORK_TEMPLATE_FILE)
  const dir = fixDirOf(fix.id)
  /* Кадр перевіряємо на наявність так само, як у брифі правки: посилання на
     неіснуючий PNG коштує виконавцю кількох марних `Read` і здогадки замість
     кадру. */
  let shotAbs = path.join(dir, 'shot.png')
  if (!fs.existsSync(shotAbs)) shotAbs = null

  const files = (fix.files || []).length ? fix.files.map((f) => `\`${f}\``).join(', ') : ''
  const values = {
    ID: fix.id,
    FIXDIR: dir,
    URL: fix.url,
    ROUTE: fix.route,
    VIEWPORT: fix.viewport ? `${fix.viewport.w}×${fix.viewport.h}` : '',
    SELECTOR: fix.selector,
    FULLPATH: fix.fullPath,
    TAGNAME: fix.tagName,
    CLASSES: fix.classes,
    COMPONENTS: (fix.components || []).join(' → '),
    REQUEST: fix.note,
    PREV_DID: fix.did,
    PREV_FILES: files,
    WHY: iteration.note,
    WHEN: iteration.at,
    /* Номер підходу: скільки разів правку вже повертали, рахуючи цей раз. */
    ROUND: String(reworkRound(rating)),
    HISTORY: reworkHistory(rating),
    RATINGS_URL,
  }
  if (shotAbs) values.SHOT = shotAbs
  return renderTemplate(tpl, values)
}

/* ──────────────────────────── класифікатор ──────────────────────────── */

/*
  Вибір виконавця перед запуском. Досі профіль був один, і «прибери лінію»
  їхало тим самим, що й «перебудуй адмінську таблицю в картки»; більшість
  реальних нот — акуратність, а не міркування, і сильна модель там платиться
  дарма. Тому перед виконавцем іде короткий дешевий прогін, який читає ноту й
  каже, котрий профіль брати.

  Критерій той самий, за яким маршрутизувала людина: чи можна виконати правку,
  НЕ ухвалюючи рішень. Живе він у `triage-template.md`, не тут — уточнювати
  його доведеться частіше, ніж цей код.

  Три речі, які роблять це надійним:
  - таймаут свій і короткий (`triage.timeoutS`). Класифікатор, який думає
    хвилину, зʼїдає ту саму економію, заради якої він є;
  - будь-яка його відмова — не зупинка конвеєра, а сильний профіль і рядок у
    лог. Помилятись у бік якості дешевше, ніж у бік ціни;
  - рішення з причиною їде в лог і в теку правки. Без цього правило нема як
    уточнювати: не видно, що чим зроблено і де маршрутизація помилилась.
*/
const TRIAGE_TEMPLATE_FILE = path.join(HERE, config.triage.template)
const TRIAGE_TIMEOUT_MS = config.triage.timeoutS * 1000

/* Профіль за імʼям рівня. Невідоме імʼя — не привід падати: класифікатор
   міг вигадати рівень, якого в конфізі немає, і це рівно той випадок, коли
   треба взяти сильний. */
const profileFor = (level) => EXECUTOR_PROFILES[level] || null

function buildTriagePrompt(note, { rework = null } = {}) {
  const tpl = readTemplate(TRIAGE_TEMPLATE_FILE)
  const values = {
    NOTE: note.note,
    ROUTE: routeOf(note) || note.url,
    SELECTOR: note.selector,
    COMPONENTS: (note.components || []).join(' → '),
    LEVELS: EXECUTOR_ORDER.join('|'),
  }
  /* Гейти умовних блоків. Порожнє поле краще викинути разом із підписом:
     «кадр: —» читається як загублений файл, а не як «кадру немає». */
  if (note.spacing && typeof note.spacing === 'object') values.SPACING = 'yes'
  if (note.shot) values.SHOT = 'yes'
  if (rework) {
    values.REWORK = 'yes'
    values.ROUND = String(rework.round || 1)
  }
  return renderTemplate(tpl, values)
}

/* Строгий JSON, але модель — це модель: вона може обгорнути відповідь у
   ```json, дописати рядок до чи після. Тому беремо ПЕРШИЙ обʼєкт у виводі, а
   не парсимо весь текст: сміття навколо не має коштувати нам маршрутизації. */
function parseTriage(text) {
  const raw = String(text || '')
  const at = raw.indexOf('{')
  if (at === -1) return null
  const end = raw.indexOf('}', at)
  if (end === -1) return null
  let parsed
  try {
    parsed = JSON.parse(raw.slice(at, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const level = typeof parsed.level === 'string' ? parsed.level.trim() : ''
  if (!profileFor(level)) return null
  return { level, why: flat(parsed.why).slice(0, 200) || 'без пояснення' }
}

/* Прогін класифікатора. Ніколи не кидає: будь-який кінець, крім чистого
   JSON із відомим рівнем, — це `null`, і викликач бере сильний профіль. */
function runTriage(prompt) {
  return new Promise((resolve) => {
    const t = config.triage
    const argv = t.args.map((a) => a.replaceAll('{{PROMPT}}', prompt).replaceAll('{{MODEL}}', t.model))
    let child
    try {
      child = spawn(t.command, argv, {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: `${config.prefix}-triage` },
      })
    } catch (err) {
      resolve({ ok: false, why: `не запустився: ${err.message}` })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* уже помер сам */
      }
      finish({ ok: false, why: `не вклався у ${t.timeoutS} с` })
    }, TRIAGE_TIMEOUT_MS)
    child.stdout.on('data', (b) => {
      out += b
      /* Стеля на вивід: відповідь — один рядок JSON, і мегабайти тут можуть
         означати лише те, що модель пішла писати твір. */
      if (out.length > 8192) out = out.slice(0, 8192)
    })
    child.stderr.on('data', (b) => {
      err += b
      if (err.length > 2048) err = err.slice(0, 2048)
    })
    child.on('error', (e) => finish({ ok: false, why: `не запустився: ${e.message}` }))
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, why: `вийшов з кодом ${code}${err ? `: ${oneLine(err)}` : ''}` })
        return
      }
      const parsed = parseTriage(out)
      if (!parsed) {
        finish({ ok: false, why: `не розібрали відповідь: «${oneLine(out) || 'порожньо'}»` })
        return
      }
      finish({ ok: true, ...parsed })
    })
  })
}

/*
  Рішення про виконавця цілком: класифікатор плюс ескалація поверх нього.

  Ескалація не питає класифікатора. Незалежно від його рішення сильний
  профіль береться, коли користувач уже сказав «не влаштувало» (доробка) або
  коли нота повертається вдруге після питання агента — у треді є його репліка,
  тобто механічної відповіді тут не знайшлось уже раз. Це дешева страховка на
  випадок, коли класифікатор помилився в бік «просто».

  Класифікатор при цьому все одно біжить: його рішення записується поруч із
  фактичним, і саме на цій парі видно, де критерії брешуть.
*/
async function decideProfile(note, { rework = null, escalate = null } = {}) {
  if (!config.triage.enabled) {
    return {
      profile: STRONG,
      triage: { level: STRONG.name, why: 'класифікатор вимкнено', source: 'default', model: null },
    }
  }
  let verdict
  try {
    verdict = await runTriage(buildTriagePrompt(note, { rework }))
  } catch (err) {
    verdict = { ok: false, why: `прогін упав: ${err.message}` }
  }
  const model = config.triage.model
  if (!verdict.ok) {
    log(`МАРШРУТ ${note.id} · класифікатор не відповів (${verdict.why}) · беру ${STRONG.label}`)
    return {
      profile: STRONG,
      triage: { level: STRONG.name, why: `класифікатор не відповів: ${verdict.why}`, source: 'fallback', model },
    }
  }
  if (escalate && verdict.level !== STRONG.name) {
    log(
      `МАРШРУТ ${note.id} · класифікатор: ${verdict.level} («${verdict.why}») · ескалація: ${escalate} · беру ${STRONG.label}`,
    )
    return {
      profile: STRONG,
      triage: {
        level: STRONG.name,
        why: `${escalate}; класифікатор казав ${verdict.level}: ${verdict.why}`,
        source: 'escalation',
        model,
      },
    }
  }
  const profile = profileFor(verdict.level)
  log(`МАРШРУТ ${note.id} · рівень ${verdict.level} · ${profile.label} · «${verdict.why}»`)
  return {
    profile,
    triage: { level: verdict.level, why: verdict.why, source: escalate ? 'escalation' : 'classifier', model },
  }
}

/* ─────────────────────────── черга й прогін ─────────────────────────── */

/* id → { child, timer, runLog, startedAt }. Мапа і є захистом «одна нота —
   один виконавець»: повторна подія по вже взятій ноті просто не проходить. */
const running = new Map()
const queue = []
/* Прогін закінчився (`close`), але фіналізація ще йде: перечитування ноти,
   запис теки, `DELETE`. У цьому вікні ноти вже немає в `running`, а брати її
   в роботу так само не можна. */
const finalizing = new Set()
/* Ноту вже взяли в роботу, але виконавця ще не запустили: `startWorker` між
   перечитуванням ноти, `working` і `spawn` двічі чекає мережу. У цьому вікні
   ноти ще немає в `running`, і без окремої позначки її міг би підхопити
   другий `enqueue` — або прохід по сирітках порахував би її «working без
   виконавця». */
const starting = new Set()

/* Нота «у нас в руках»: взята, працює або доробляється. Три множини замість
   однієї, бо кожна закриває своє вікно, а питання до них завжди спільне. */
const inFlight = (id) => running.has(id) || starting.has(id) || finalizing.has(id)

/* ── Замки за екраном ──────────────────────────────────────────────────────
   Стеля виконавців піднята до чотирьох, і наосліп це не можна: два виконавці
   в одному файлі — це зіпсована робота, а не подвоєна. Точного критерію
   «той самий файл» наперед немає (які файли зачепить виконавець, відомо лише
   постфактум), тож беремо грубу, але чесну проксі: РОУТ. Правки на одному
   екрані майже завжди сходяться в один компонент і його CSS.

   Другий ключ — верхній компонент ланцюга (`components[0]`). Він ловить те,
   чого не ловить роут: два різні екрани, які тицьнули в один спільний
   компонент. Обходиться дешево, а колізій знімає більше.

   Зайнятий ключ не проганяє ноту з черги — вона паркується і повертається,
   щойно попередній прогін закінчився. Викинути її означало б втратити;
   лишити в черзі — крутити цикл на місці. */
const busyKeys = new Map()
const heldKeys = new Map()
/* Завдання, чий екран зайнятий. У черзі їм не місце: `pump` брав би їх по
   колу, поки вільні місця не скінчаться. */
const parked = []

const routeKeyOf = (url) => {
  try {
    return `r:${new URL(url).pathname}`
  } catch {
    return null
  }
}

/* Ключі завдання: екран і верхній компонент. Обидва можуть бути невідомі —
   тоді замка просто немає, і це краще за вигаданий ключ, який зчепив би між
   собою непов'язані ноти. */
function jobKeys({ url, components }) {
  const keys = []
  const route = routeKeyOf(url)
  if (route) keys.push(route)
  const top = Array.isArray(components) && components.length ? components[0] : null
  if (top) keys.push(`c:${top}`)
  return keys
}

const blockedBy = (id, keys) => {
  for (const k of keys) {
    const holder = busyKeys.get(k)
    if (holder && holder !== id) return { key: k, holder }
  }
  return null
}

function lockKeys(id, keys) {
  heldKeys.set(id, keys)
  for (const k of keys) busyKeys.set(k, id)
}

function unlockKeys(id) {
  const keys = heldKeys.get(id)
  if (!keys) return
  heldKeys.delete(id)
  for (const k of keys) if (busyKeys.get(k) === id) busyKeys.delete(k)
}

/* Звільнився екран — паркування скінчилось. Повертаємо ВСІХ і даємо `pump`
   розібратись: він однаково перевіряє ключі перед стартом, а вибирати тут
   «кого саме розбудити» означало б тримати другу копію тієї самої логіки. */
function releaseParked(why) {
  if (!parked.length) return
  const back = parked.splice(0, parked.length)
  for (const job of back) {
    if (!inFlight(job.id) && !queued(job.id)) queue.push(job)
  }
  log(`РОЗПАРКОВАНО ${back.length} · ${why} · у черзі ${queue.length}`)
}
/* «Брудні» ноти: подія прийшла, коли нота вже була в роботі. Курсор watch за
   такою подією вже зсунуто, тобто вдруге сервер її не віддасть — якщо просто
   викинути, відповідь користувача, написана під час прогону, зникне назовсім.
   Тож запам'ятовуємо і кладемо ноту в чергу знову, коли прогін закриється. */
const dirty = new Set()

/* У черзі лежать не голі id, а завдання: `note` (правка з оверлея) і `rework`
   (доробка з рев'ю-сторінки). Черга одна навмисно — стеля виконавців у них
   спільна, бо спільний у них репозиторій, і «дві правки плюс дві доробки»
   означало б чотири Claude-сесії, що правлять одні файли. */
const queued = (id) => queue.some((j) => j.id === id) || parked.some((j) => j.id === id)

function enqueue(id, why) {
  if (inFlight(id)) {
    dirty.add(id)
    log(`ВІДКЛАДЕНО ${id} · ${why} · нота в роботі — повернуся до неї після прогону`)
    return
  }
  if (queued(id)) {
    log(`ПРОПУСК ${id} · ${why} · вже в черзі`)
    return
  }
  queue.push({ kind: 'note', id })
  log(`ЧЕРГА ${id} · ${why} · у черзі ${queue.length}, в роботі ${running.size}`)
  pump()
}

/* Доробка в чергу йде без `dirty`: подія тут не одноразова, як у watch, а
   стан на :4748. Не взяли зараз — ітерація лишається відкритою, і наступне
   опитування побачить її знову. Губити нема чого. */
function enqueueRework(id, iteration, why) {
  if (inFlight(id) || queued(id)) return false
  queue.push({ kind: 'rework', id, iteration })
  log(`ЧЕРГА-ДОРОБКА ${id} · ${why} · у черзі ${queue.length}, в роботі ${running.size}`)
  pump()
  return true
}

function pump() {
  /* Стеля рахується разом із тими, кого вже беруть: `startWorker` потрапляє в
     `running` не одразу, а після двох звернень до мережі, і без `starting`
     цикл устигав роздати всю чергу — десять нот беклогу означали десять
     одночасних Claude-сесій в одному репозиторії замість двох. */
  while (queue.length && running.size + starting.size < MAX_WORKERS) {
    const job = queue.shift()
    const { id } = job
    /* `.catch` тут не косметика: без нього будь-який виняток у `startWorker`
       (зіпсутий `brief-template.md`, `mkdir` без прав, `spawn` без бінаря)
       ставав необробленим реджектом і валив весь сторож, лишаючи ноту у
       `working`. Одна помилка в шаблоні перетворювала чергу на купу мертвих
       нот. Сам `startWorker` прибирає за собою всередині, тут лишається
       підхопити чергу далі. */
    const started = job.kind === 'rework' ? startRework(id, job.iteration) : startWorker(id)
    void started.then(
      /* Ноту могли й не взяти (видалили, зарезолвили, чекає людину) — тоді
         місце звільнилось, і чергу треба підштовхнути. */
      () => pump(),
      (err) => {
        log(`ПОМИЛКА ${id} · виконавця не вдалось запустити: ${err.stack || err.message}`)
        pump()
      },
    )
  }
}

async function startWorker(id) {
  /* Позначку «беремо» ставимо до першого запиту: далі два звернення до
     мережі, і все це вікно нота вже не вільна. */
  starting.add(id)
  /* Ноту перечитуємо перед стартом: поки вона чекала в черзі, її могли
     видалити, зарезолвити або взяти інакше. */
  let note
  try {
    note = await getNote(id)
  } catch (err) {
    starting.delete(id)
    log(`ПОМИЛКА ${id} · не змогли перечитати ноту: ${err.message}`)
    return
  }
  if (!note) {
    starting.delete(id)
    log(`ПРОПУСК ${id} · ноти вже немає`)
    return
  }
  if (!dispatchable(note)) {
    starting.delete(id)
    log(`ПРОПУСК ${id} · статус ${note.status}${waitingForHuman(note) ? ', чекає відповіді людини' : ''}`)
    return
  }

  /* Замок екрана — до `working`, а не після: нота, що чекає на звільнення
     сусіда, не має мигати «в роботі» на рев'ю-сторінці. Беремо його ТУТ, а
     не перед `spawn`: між перевіркою і стартом лежать і мережа, і прогін
     класифікатора, і в це вікно другий `pump` устигав пропустити сусідню
     ноту на той самий екран — перевірка без захоплення нічого не захищає. */
  const keys = jobKeys(note)
  const clash = blockedBy(id, keys)
  if (clash) {
    starting.delete(id)
    parked.push({ kind: 'note', id })
    log(`ПАРКУЮ ${id} · ${clash.key} зайнято нотою ${clash.holder} · візьму після її прогону`)
    return
  }
  lockKeys(id, keys)

  try {
    await setStatus(id, 'working')
  } catch (err) {
    starting.delete(id)
    unlockKeys(id)
    releaseParked(`${id} не взято в роботу`)
    log(`ПОМИЛКА ${id} · не поставили working: ${err.message}`)
    return
  }

  /* Усе після `working` — під захистом. Статус у сторі вже змінено, тож
     будь-яке падіння звідси й далі лишає ноту у «в роботі» без виконавця, і
     розібрати такий стан ззовні нічим. Тому: закрити fd, повернути ноту в
     `pending` з рядком у тред — і аж тоді віддати помилку нагору. */
  let fd = null
  let runLog = null
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    runLog = path.join(RUNS_DIR, `${id}-${stamp}.log`)
    fs.mkdirSync(RUNS_DIR, { recursive: true })
    fd = fs.openSync(runLog, 'a')
    fs.writeSync(fd, `=== ${new Date().toISOString()} нота ${id}\n=== ${note.url}\n=== «${note.note}»\n\n`)

    /* Вибір виконавця — тут, перед запуском, і більше ніде. Ескалація:
       нота, у треді якої вже є репліка агента, повертається до нас ВДРУГЕ
       після питання — механічної відповіді тут одного разу не знайшлось. */
    const asked = (note.thread || []).some((m) => m.role === 'agent')
    const route = await decideProfile(note, {
      escalate: asked ? 'нота повернулась після питання агента' : null,
    })

    const brief = buildBrief(note)
    const child = spawn(route.profile.command, executorArgv(route.profile, brief), {
      cwd: REPO,
      stdio: ['ignore', fd, fd],
      /* Своя група процесів: `claude` плодить дітей (node, tsc, vite), і по
         таймауту треба вбити гілку, а не тільки батька. */
      detached: true,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: `${config.prefix}-watchdog` },
    })

    const startedAt = Date.now()
    const entry = { child, timer: null, runLog, startedAt, timedOut: false, route }
    const timer = setTimeout(() => {
      /* Перевірка перед `kill(-pid)`: `clearTimeout` стоїть в обробнику
         `close`, тобто між смертю процесу і подією є вікно, у якому pid уже
         міг дістатись комусь іншому. Вбити чужу групу процесів по
         перевикористаному pid — рівно те, чого не можна робити ніколи. */
      if (running.get(id) !== entry || child.exitCode !== null || child.signalCode !== null) {
        log(`ТАЙМАУТ ${id} · процес уже завершився — групу не чіпаю`)
        return
      }
      entry.timedOut = true
      log(`ТАЙМАУТ ${id} · ${RUN_TIMEOUT_MS / 60000}хв · вбиваю групу ${child.pid}`)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* процес уже помер сам */
      }
    }, RUN_TIMEOUT_MS)
    entry.timer = timer

    running.set(id, entry)
    starting.delete(id)
    /* pid і час взяття — на диск. Без них «нота у working» нерозрізненна:
       чи виконавець пережив рестарт сторожа (KillMode=process, це штатно),
       чи машину перезавантажили посеред прогону і виконавця давно немає.
       Разом із boot-id це відрізняє одне від одного (див. `sweepOrphans`). */
    rememberRun(id, child.pid, startedAt)
    log(
      `СТАРТ ${id} · pid ${child.pid} · ${route.profile.label} · ${note.url} · «${oneLine(note.note)}» · лог ${path.basename(runLog)}`,
    )

    child.on('error', (err) => log(`ПОМИЛКА ${id} · не запустився виконавець: ${err.message}`))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      try {
        fs.closeSync(fd)
      } catch {
        /* fd могли вже закрити — це не привід шуміти */
      }
      running.delete(id)
      forgetRun(id)
      /* Нота лишається «зайнятою» до кінця фіналізації: інакше подія, що
         прилетить у це вікно, пройшла б повз `dirty` і повз чергу. */
      finalizing.add(id)
      void finish(id, code, signal, runLog, Date.now() - startedAt, entry.timedOut, route).finally(
        () => {
          finalizing.delete(id)
          unlockKeys(id)
          releaseParked(`прогін ${id} закінчився`)
          if (dirty.delete(id)) enqueue(id, 'подія, що прийшла під час прогону')
          pump()
        },
      )
    })
  } catch (err) {
    starting.delete(id)
    unlockKeys(id)
    releaseParked(`старт ${id} не вдався`)
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* нічого не вдієш */
      }
    }
    running.delete(id)
    forgetRun(id)
    const where = runLog ? ` Лог прогону: comments-harness/watchdog/runs/${path.basename(runLog)}.` : ''
    try {
      await reply(id, `Сторож не зміг запустити виконавця (${err.message}).${where} Нота повернута в pending — правку ніхто не починав.`)
      await setStatus(id, 'pending')
    } catch (e2) {
      log(`ПОМИЛКА ${id} · не змогли повернути ноту в pending після збою старту: ${e2.message}`)
    }
    throw err
  }
}

/* ──────────────────────── прогін доробки ──────────────────────── */

/*
  Маркери, якими виконавець доробки звітує. Нота має статус, доробка — ні:
  :4748 знає про ітерацію рівно два стани, «відкрита» і «закрита», і закриває
  її сторож. Тобто відрізнити «переробив» від «не зрозумів» і від «упав»
  можна лише по тому, що виконавець сказав уголос.

  Тому контракт простий і письмовий (див. `rework-template.md`): останнім
  рядком або `ДОРОБЛЕНО: …`, або `НЕ ЗРОЗУМІВ: …`. Немає маркера — значить
  прогін не дійшов до кінця, і ітерація лишається відкритою. Мовчання ніколи
  не читається як успіх: закрити ітерацію, якої ніхто не доробив, гірше за
  зайвий рядок у лозі, бо тоді пропадає і робота, і сигнал про неї.
*/
const DONE_MARK = 'ДОРОБЛЕНО:'
const ASK_MARK = 'НЕ ЗРОЗУМІВ:'
/* Хвіст лога, а не весь файл: прогін пише туди мегабайти інструментального
   виводу, а звіт завжди в кінці. */
const LOG_TAIL_BYTES = 64 * 1024

function readLogTail(file) {
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - LOG_TAIL_BYTES)
    const len = size - start
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

/* Беремо ОСТАННЄ входження маркера. Перше могло приїхати з даних: шапка лога
   містить текст зауваження користувача, а він цілком міг написати туди слово
   «ДОРОБЛЕНО». Звіт виконавця завжди нижче за шапку. */
function markerText(text, mark) {
  const at = text.lastIndexOf(mark)
  if (at === -1) return null
  return flat(text.slice(at + mark.length)).slice(0, 3500)
}

async function startRework(id, iteration) {
  starting.add(id)

  /* Перечитуємо чергу доробок перед стартом: поки завдання чекало, користувач
     міг переписати зауваження (тоді бриф застарів) або ітерацію могли
     закрити. */
  let fresh
  try {
    const open = await ratingsApi('GET', '/rework')
    fresh = (open.items || []).find((r) => r.id === id)
  } catch (err) {
    starting.delete(id)
    log(`ПОМИЛКА ${id} · не перечитали чергу доробок: ${err.message}`)
    return
  }
  if (!fresh || !fresh.rework || fresh.rework.done) {
    starting.delete(id)
    log(`ПРОПУСК-ДОРОБКА ${id} · ітерації вже немає у відкритих`)
    return
  }
  if (fresh.rework.at !== iteration.at) {
    starting.delete(id)
    log(`ПРОПУСК-ДОРОБКА ${id} · зауваження переписали — візьму нову ітерацію наступним проходом`)
    return
  }

  /* Контекст доробки живе в теці правки. Немає теки — немає ні початкового
     запиту, ні того, що робив попередній виконавець, і бриф вийшов би
     «переробіть щось». Такий прогін не запускаємо взагалі: ітерація лишається
     відкритою, а в лозі рядок, з яким людина розбереться за хвилину. */
  const fix = readFixJson(id)
  if (!fix) {
    starting.delete(id)
    blockRework(id, iteration.at, 'немає теки правки')
    log(`ЗБІЙ-ДОРОБКА ${id} · немає data/fixes/${id}/fix.json — брифу нема з чого зібрати · ітерація лишається відкритою`)
    return
  }

  /* Замок екрана — той самий, що й у ноти, тільки контекст беремо з теки
     правки: доробка чіпає рівно той екран, який чіпала правка. */
  const keys = jobKeys({ url: fix.url, components: fix.components })
  const clash = blockedBy(id, keys)
  if (clash) {
    starting.delete(id)
    parked.push({ kind: 'rework', id, iteration })
    log(`ПАРКУЮ-ДОРОБКУ ${id} · ${clash.key} зайнято нотою ${clash.holder} · візьму після її прогону`)
    return
  }
  lockKeys(id, keys)

  let fd = null
  let runLog = null
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    runLog = path.join(RUNS_DIR, `${id}-rework-${stamp}.log`)
    fs.mkdirSync(RUNS_DIR, { recursive: true })
    fd = fs.openSync(runLog, 'a')
    fs.writeSync(fd, `=== ${new Date().toISOString()} доробка ${id}\n=== «${oneLine(iteration.note)}»\n\n`)

    /* Доробка — завжди сильний профіль: користувач уже сказав «не
       влаштувало», і другий підхід тією ж моделлю статистично дає те саме.
       Класифікатор при цьому все одно біжить — його рішення записується
       поруч, і саме на цій парі буде видно, чи ескалація виправдана. */
    const route = await decideProfile(
      { id, note: fresh.rework.note, url: fix.url, selector: fix.selector, components: fix.components },
      { rework: { round: Number(reworkRound(fresh)) || 1 }, escalate: 'доробка: попередня спроба не влаштувала' },
    )

    const brief = buildReworkBrief(fix, fresh, fresh.rework)
    const child = spawn(route.profile.command, executorArgv(route.profile, brief), {
      cwd: REPO,
      stdio: ['ignore', fd, fd],
      detached: true,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: `${config.prefix}-watchdog` },
    })

    const startedAt = Date.now()
    const entry = { child, timer: null, runLog, startedAt, timedOut: false, kind: 'rework' }
    const timer = setTimeout(() => {
      if (running.get(id) !== entry || child.exitCode !== null || child.signalCode !== null) {
        log(`ТАЙМАУТ ${id} · процес уже завершився — групу не чіпаю`)
        return
      }
      entry.timedOut = true
      log(`ТАЙМАУТ ${id} · ${RUN_TIMEOUT_MS / 60000}хв · вбиваю групу ${child.pid}`)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* процес уже помер сам */
      }
    }, RUN_TIMEOUT_MS)
    entry.timer = timer

    running.set(id, entry)
    starting.delete(id)
    rememberRun(id, child.pid, startedAt, 'rework')
    /* Спробу рахуємо на СТАРТІ, не на провалі. Інакше прогін, обірваний
       ребутом, не лишає по собі сліду — а ітерація лишається відкритою, і
       після рестарту сторож бере її знову, і так по колу. */
    countAttempt(id, iteration.at)
    log(
      `СТАРТ-ДОРОБКА ${id} · pid ${child.pid} · ${route.profile.label} · підхід ${(runState.reworks[id] || {}).attempts} · «${oneLine(iteration.note)}» · лог ${path.basename(runLog)}`,
    )

    child.on('error', (err) => log(`ПОМИЛКА ${id} · не запустився виконавець доробки: ${err.message}`))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      try {
        fs.closeSync(fd)
      } catch {
        /* fd могли вже закрити */
      }
      running.delete(id)
      forgetRun(id)
      finalizing.add(id)
      void finishRework(id, iteration, code, signal, runLog, Date.now() - startedAt, entry.timedOut).finally(
        () => {
          finalizing.delete(id)
          unlockKeys(id)
          releaseParked(`доробка ${id} закінчилась`)
          if (dirty.delete(id)) enqueue(id, 'подія, що прийшла під час прогону')
          pump()
        },
      )
    })
  } catch (err) {
    starting.delete(id)
    unlockKeys(id)
    releaseParked(`старт доробки ${id} не вдався`)
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* нічого не вдієш */
      }
    }
    running.delete(id)
    forgetRun(id)
    /* Ітерацію НЕ закриваємо: її ніхто не доробив. Вона лишається відкритою,
       і наступне опитування або спробує ще раз, або впреться в стелю спроб. */
    log(`ЗБІЙ-ДОРОБКА ${id} · виконавця не вдалось запустити: ${err.message} · ітерація лишається відкритою`)
    throw err
  }
}

/*
  Кінцівок так само три, і жодна з них не закриває ітерацію «про всяк
  випадок»:
    — виконавець сказав `ДОРОБЛЕНО:` і вийшов чисто → закриваємо ітерацію,
      кладучи його опис у `result`. Саме ця пара «чому не влаштувало → що
      переробили» і є те, заради чого файл оцінок існує;
    — виконавець сказав `НЕ ЗРОЗУМІВ:` → ітерація відкрита, спроби вичерпані.
      Повторний запуск дасть те саме питання, тож чекаємо людину;
    — усе інше (падіння, таймаут, мовчазний вихід) → ітерація відкрита, у лог
      рядок; наступний прохід спробує ще раз, поки не впреться в стелю.
*/
async function finishRework(id, iteration, code, signal, runLog, ms, timedOut = false) {
  const mins = (ms / 60000).toFixed(1)
  const tail = readLogTail(runLog)
  const done = code === 0 ? markerText(tail, DONE_MARK) : null
  const asked = markerText(tail, ASK_MARK)

  if (done) {
    try {
      await ratingsApi('POST', '/rework-done', { id, result: done })
      clearRework(id)
      log(`ГОТОВО-ДОРОБКА ${id} · ${mins}хв · ітерація закрита · «${oneLine(done)}»`)
    } catch (err) {
      /* Робота зроблена, а закрити не вийшло. Ітерація лишається відкритою —
         і це правильний бік помилки: наступний прохід або закриє її повторним
         підходом, або впреться в стелю й покличе людину. Гірший бік — тихо
         вважати закритою те, що на :4748 досі відкрите. */
      log(`ПОМИЛКА ${id} · доробка зроблена, але /rework-done не пройшов: ${err.message} · ітерація лишається відкритою`)
    }
    return
  }

  if (asked) {
    blockRework(id, iteration.at, 'виконавець не зрозумів завдання')
    log(`ПИТАННЯ-ДОРОБКА ${id} · ${mins}хв · виконавець не зрозумів: «${oneLine(asked)}» · ітерація відкрита, чекає людину`)
    return
  }

  const cause = timedOut
    ? `сплила стеля прогону ${RUN_TIMEOUT_MS / 60000}хв, виконавця знято по таймауту`
    : signal
      ? `виконавця вбито сигналом ${signal}`
      : code === 0
        ? 'виконавець вийшов чисто, але не сказав ДОРОБЛЕНО — вважаю, що доробки не було'
        : `виконавець вийшов з кодом ${code}`
  const left = REWORK_MAX_ATTEMPTS - ((runState.reworks[id] || {}).attempts || 0)
  log(
    `${timedOut ? 'ТАЙМАУТ-ДОРОБКА' : 'ЗБІЙ-ДОРОБКА'} ${id} · ${mins}хв · ${cause} · лог ${path.basename(runLog)} · ітерація лишається відкритою${left > 0 ? `, спроб лишилось ${left}` : ', спроби вичерпано — чекає людину'}`,
  )
}

/* Закриття ноти — три кроки в жорсткому порядку: тека, індекс, `DELETE`.
   Тека і є пам'ять про правку, тож видаляти ноту можна лише після того, як
   вона записана. Не записалась — нота лишається у сторі, краще хай повисить,
   ніж зникне безслідно. */
async function closeNote(note, { ms, runLog, profile, triage }) {
  let written
  try {
    written = await saveFix(note, { ms, runLog, profile, triage })
  } catch (err) {
    log(`ПОМИЛКА ${note.id} · не записали теку правки: ${err.message} · ноту лишаю у сторі`)
    return false
  }
  try {
    await removeNote(note.id)
    /* Аж тепер оригінали кадру й лога: до `DELETE` нота на них посилалась. */
    dropOriginals(note.id, written.staged)
    log(`ЗАКРИТО ${note.id} · тека data/fixes/${note.id}/, індекс перезібрано, нота видалена`)
    return true
  } catch (err) {
    log(`ПОМИЛКА ${note.id} · не видалили ноту після запису теки: ${err.message}`)
    return false
  }
}

/* Що б не сталося, нота не лишається у `working` мовчки. Три чесні кінцівки:
   виконавець сам поставив `resolved`; виконавець сам повернув `pending`,
   дописавши питання; або він упав — і тоді `pending` та рядок у треді
   ставить сторож, щоб користувач бачив поломку, а не гадав. */
async function finish(id, code, signal, runLog, ms, timedOut = false, route = null) {
  const mins = (ms / 60000).toFixed(1)
  let note
  try {
    note = await getNote(id)
  } catch (err) {
    log(`ПОМИЛКА ${id} · не перечитали ноту після прогону: ${err.message}`)
    return
  }
  if (!note) {
    log(`КІНЕЦЬ ${id} · ${mins}хв · ноту видалили під час прогону`)
    return
  }
  if (note.status === 'resolved') {
    log(`ГОТОВО ${id} · ${mins}хв · виконавець поставив resolved`)
    await closeNote(note, { ms, runLog, profile: route?.profile, triage: route?.triage })
    return
  }
  if (note.status === 'pending' && code === 0) {
    const asked = waitingForHuman(note)
    log(`ПИТАННЯ ${id} · ${mins}хв · виконавець повернув pending${asked ? ', питання в треді' : ' без питання'}`)
    return
  }

  /* Таймаут — не падіння, і казати про нього треба інакше. «Вбито сигналом
     SIGKILL» відправляє користувача шукати неіснуючу поломку, тоді як
     причина рівно одна: сплила стеля прогону. Друга річ, про яку тут мовчати
     не можна, — напівстан: виконавця вбили посеред роботи, частина правок уже
     у файлах, і нота вертається в pending з уже зміненим репозиторієм. */
  const cause = timedOut
    ? `сплила стеля прогону ${RUN_TIMEOUT_MS / 60000}хв, виконавця знято по таймауту`
    : signal
      ? `виконавця вбито сигналом ${signal}`
      : code === 0
        ? `виконавець вийшов чисто, але лишив статус ${note.status}`
        : `виконавець вийшов з кодом ${code}`
  log(`${timedOut ? 'ТАЙМАУТ' : 'ЗБІЙ'} ${id} · ${mins}хв · ${cause} · лог ${path.basename(runLog)}`)
  const warning = timedOut
    ? ' Увага: правку зупинено посеред роботи, частина змін могла вже лягти у файли — перевір `git status` перед повторним запуском.'
    : ''
  try {
    await reply(id, `Виконавець не доробив правку (${cause}).${warning} Деталі в лозі: comments-harness/watchdog/runs/${path.basename(runLog)}. Нота повернута в pending.`)
    await setStatus(id, 'pending')
  } catch (err) {
    log(`ПОМИЛКА ${id} · не змогли повернути ноту в pending: ${err.message}`)
  }
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 80)

/* ──────────────────────── памʼять про прогони ──────────────────────── */

/*
  Єдиний стан сторожа на диску — і заведений він рівно заради одного питання:
  нота у `working`, виконавця в мапі немає. Він нас пережив (юніт іде з
  KillMode=process, це штатно) — чи машину перезавантажили посеред прогону, і
  вже ніхто нічого не доробить? Без pid і часу взяття ці два стани не
  розрізнити, і другий давав ноту, яка висить у «в роботі» тижнями.

  Boot-id відрізняє «той самий boot» від «після ребуту»: pid після
  перезавантаження нічого не значить — його вже носить хтось інший, тож
  перевіряти живість процесу можна лише в межах одного boot.
*/
const STATE_FILE = path.join(HERE, 'state.json')

function readBootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null
  } catch {
    /* не Linux — тоді boot-id немає, лишається критерій за віком */
    return null
  }
}
const BOOT_ID = readBootId()

/* `runs`: id ноти → { pid, startedAt }. Переживає рестарт сторожа в межах
   одного boot саме тому, що виконавці його теж переживають. */
let runState = { bootId: BOOT_ID, runs: {}, reworks: {} }

function loadState() {
  try {
    const prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    /* Лічильники доробок переживають і рестарт, і ребут — на відміну від
       `runs`. Це різні за природою речі: `runs` про живі процеси, а тому
       безглузді після ребуту, а `reworks` — про те, скільки разів ми вже
       намагалися виконати конкретне зауваження. Ітерація на :4748 лишається
       відкритою через ребут так само, як була, і забути про дві невдалі
       спроби означало б почати ганяти виконавця по колу заново. */
    if (prev && prev.reworks) runState.reworks = { ...prev.reworks }
    if (prev && prev.bootId === BOOT_ID && prev.runs) {
      runState = { ...runState, bootId: BOOT_ID, runs: { ...prev.runs } }
      const n = Object.keys(runState.runs).length
      if (n) log(`СТАН · підхопив ${n} прогін(ів) із попереднього сторожа (той самий boot)`)
    } else if (prev && prev.runs && Object.keys(prev.runs).length) {
      log(`СТАН · у файлі прогони з іншого boot (${prev.bootId || '—'}) — виконавців тих уже немає`)
    }
  } catch {
    /* немає файлу або він побитий — починаємо з чистого стану */
  }
  saveState()
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(runState, null, 2)}\n`)
  } catch (err) {
    log(`УВАГА · не записали ${path.basename(STATE_FILE)}: ${err.message}`)
  }
}

function rememberRun(id, pid, startedAt, kind = 'note') {
  runState.runs[id] = { pid, startedAt: new Date(startedAt).toISOString(), kind }
  saveState()
}

/*
  Памʼять про доробки. Питання, на яке вона відповідає, у ноти вирішує статус
  (`pending`/`working`), а в ітерації статусу немає й не буде: :4748 міняти не
  можна, і «взяту в роботу» ітерацію там від «нової» нічим не відрізнити.
  Тому це знання тримає сторож у себе — і тримає на диску, бо після рестарту
  воно має лишитись правильним.

  Ключ — id правки, значення привʼязане до `at` ітерації, тобто до моменту,
  коли користувач написав це зауваження. Переписав його (POST /rework по
  відкритій ітерації міняє текст і `at`) — це вже інше завдання, лічильник
  спроб з нуля.
*/
function countAttempt(id, at) {
  const prev = runState.reworks[id]
  const attempts = prev && prev.at === at ? (prev.attempts || 0) + 1 : 1
  runState.reworks[id] = { at, attempts, lastAt: new Date().toISOString() }
  saveState()
}

/* Ітерація, яку більше не пробуємо: спроб не лишилось або пробувати немає
   сенсу (виконавець не зрозумів завдання, теки правки немає). Сама ітерація
   на :4748 при цьому ВІДКРИТА — так і має бути, її ще ніхто не доробив. */
function blockRework(id, at, why) {
  runState.reworks[id] = {
    at,
    attempts: REWORK_MAX_ATTEMPTS,
    blocked: why,
    lastAt: new Date().toISOString(),
  }
  saveState()
}

function clearRework(id) {
  if (!(id in runState.reworks)) return
  delete runState.reworks[id]
  saveState()
}

function forgetRun(id) {
  if (!(id in runState.runs)) return
  delete runState.runs[id]
  saveState()
}

/* Другий, незалежний спосіб побачити живого виконавця — і потрібен він там,
   де запису про прогін немає взагалі: сторож із попередньої версії, ручний
   запуск, побитий `state.json`. Виконавця запускають як `claude -p <бриф>`, а
   бриф починається з id ноти, тож id видно прямо в командному рядку процесу.
   Ціна помилки тут несиметрична: лишити зависле working — незручність,
   а віддати в роботу ноту, над якою хтось працює, — це два виконавці в одному
   репозиторії, рівно те, від чого стоїть замок інстансу. Тож перевіряємо
   двічі. */
function processCarryingNote(id) {
  let pids
  try {
    pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))
  } catch {
    /* не Linux — цієї перевірки просто немає */
    return null
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue
    let cmd
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    } catch {
      /* процес помер між readdir і читанням — звичайна річ */
      continue
    }
    if (cmd.includes(id)) return Number(pid)
  }
  return null
}

/* Живий процес чи ні. `kill(pid, 0)` нічого не шле, лише перевіряє, що процес
   існує і що ми маємо право його чіпати. EPERM теж означає «живий». */
function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/* ────────────────────────── прибирання сиріток ────────────────────────── */

/*
  Періодичне, а не разове на старті. Причина в тому, чого `watch` не вміє: він
  віддає створення нот і репліки людини, але НЕ зміну статусу. Виконавець, що
  пережив рестарт сторожа й поставив `resolved` через хвилину після підбору
  беклогу, не буде помічений жодним іншим шляхом: у `running` його немає,
  подія не прийде — тека не запишеться, індекс не оновиться, зроблена робота
  зависне назавжди. Тож стор треба переопитувати.
*/
let sweeping = false
/* Про яких живих чужих виконавців уже сказали в лозі — щоб не повторюватись
   на кожному проході. */
const aliveReported = new Set()

async function sweepOrphans(reason) {
  if (sweeping) return
  sweeping = true
  try {
    /* Сирітка №1: `resolved` без виконавця. Робота зроблена — записуємо теку
       звичайним шляхом і закриваємо ноту. */
    const done = (await api('GET', '/notes?status=resolved')).filter(
      (n) => !inFlight(n.id),
    )
    for (const n of done) {
      log(`ГОТОВО ${n.id} · осиротіла у resolved (${reason}) · закриваю`)
      await closeNote(n, { ms: null, runLog: lastRunLog(n.id) })
    }

    /* Сирітка №2: `working` без виконавця в мапі. Три різні стани під одним
       написом, і розрізняє їх памʼять про прогони:
       — виконавець живий і нас пережив: не чіпати, це штатний KillMode=process;
       — процес помер (або був ребут) і нота молодша за стелю прогону: ще
         зачекати, `close` міг просто не долетіти;
       — процес мертвий і нота старша за стелю: повернути в `pending` з рядком
         у тред, бо інакше вона висітиме з лічильником, що росте днями. */
    const stuck = (await api('GET', '/notes?status=working')).filter(
      (n) => !inFlight(n.id),
    )
    for (const n of stuck) {
      const known = runState.runs[n.id]
      if (known && processAlive(known.pid)) {
        /* Прохід повторюється щохвилини, тож про кожного такого виконавця
           кажемо один раз: інакше лог перетворюється на стрічку однакових
           рядків, у якій не видно справжніх подій. */
        if (!aliveReported.has(n.id)) {
          aliveReported.add(n.id)
          log(`УВАГА ${n.id} · working, виконавець pid ${known.pid} живий і пережив сторожа — не чіпаю`)
        }
        continue
      }
      /* Запису немає — питаємо систему: чи не крутиться десь процес із цим id
         у командному рядку. */
      if (!known) {
        const pid = processCarryingNote(n.id)
        if (pid) {
          if (!aliveReported.has(n.id)) {
            aliveReported.add(n.id)
            log(`УВАГА ${n.id} · working, запису про прогін немає, але pid ${pid} тримає цю ноту в командному рядку — не чіпаю`)
          }
          continue
        }
      }
      aliveReported.delete(n.id)
      const sinceMs = Date.parse(n.updatedAt || n.createdAt || 0) || 0
      const ageMs = Date.now() - sinceMs
      if (!(ageMs > RUN_TIMEOUT_MS)) {
        log(`УВАГА ${n.id} · working без живого виконавця, але лише ${(ageMs / 60000).toFixed(1)}хв — чекаю до стелі`)
        continue
      }
      const why = known
        ? `виконавець pid ${known.pid} не існує`
        : BOOT_ID && runState.bootId !== BOOT_ID
          ? 'машину перезавантажили посеред прогону'
          : 'сторож нічого не знає про його виконавця'
      log(`ЗАВИСЛО ${n.id} · working ${(ageMs / 60000).toFixed(1)}хв · ${why} · повертаю в pending`)
      try {
        await reply(
          n.id,
          `Нота висіла у working ${(ageMs / 60000).toFixed(0)}хв без живого виконавця (${why}) — найімовірніше, процес не пережив перезавантаження. Правку могли почати й не доробити: перевір \`git status\`. Нота повернута в pending.`,
        )
        await setStatus(n.id, 'pending')
        forgetRun(n.id)
      } catch (err) {
        log(`ПОМИЛКА ${n.id} · не змогли зняти зависле working: ${err.message}`)
      }
    }

    /* Записи про прогони, яких уже немає ні в сторі, ні в мапі, тільки
       засмічують стан і плутають наступний прохід. */
    for (const id of Object.keys(runState.runs)) {
      if (inFlight(id)) continue
      if (stuck.some((n) => n.id === id)) continue
      forgetRun(id)
    }
  } finally {
    sweeping = false
  }
}

/* ────────────────────────── черга доробок ────────────────────────── */

/*
  Друга черга сторожа. Кнопка Send back на рев'ю-сторінці кладе ітерацію на
  :4748 — і доти, доки сюди ніхто не ходив, вона показувала користувачу успіх,
  а робота не починалась ніколи.

  Опитування, а не watch: :4748 довгого очікування не вміє, а міняти його в
  цій задачі не можна. Хвилина затримки тут нічого не коштує — доробка
  зʼявляється після того, як людина подивилась на екран і сформулювала
  претензію, тобто вимірюється хвилинами сама.
*/
let pollingReworks = false
/* Про заблоковані ітерації кажемо в лог один раз: прохід повторюється
   щохвилини, а стан не міняється, доки користувач не перепише зауваження.
   Ключ із `at`, щоб переписане зауваження знову себе показало. */
const reworkReported = new Set()

function reportOnce(key, msg) {
  if (reworkReported.has(key)) return
  reworkReported.add(key)
  log(msg)
}

async function pollReworks(reason) {
  if (pollingReworks) return
  pollingReworks = true
  try {
    const open = await ratingsApi('GET', '/rework')
    const items = open.items || []
    if (!items.length) return
    for (const item of items) {
      const id = item.id
      const rw = item.rework
      if (!rw || !rw.note || rw.done) continue
      const key = `${id}@${rw.at}`

      /* Один виконавець на одну правку. Якщо на цей же id саме зараз іде
         нота, доробка почекає наступного проходу: два процеси в одному
         репозиторії з тим самим файлом — рівно те, від чого стоїть замок. */
      if (inFlight(id) || queued(id)) continue

      const memo = runState.reworks[id]
      if (memo && memo.at === rw.at && (memo.attempts || 0) >= REWORK_MAX_ATTEMPTS) {
        reportOnce(
          key,
          `ЧЕКАЄ-ЛЮДИНУ ${id} · доробка відкрита, але ${memo.blocked ? memo.blocked : `спроби вичерпано (${memo.attempts})`} · не беру, доки зауваження не перепишуть`,
        )
        continue
      }

      /* Виконавець, що пережив рестарт сторожа. У мапі `running` його немає
         (мапа в памʼяті), а прогін триває — беручи ітерацію вдруге, ми дали б
         двох виконавців на один файл. Ті самі дві перевірки, що й для нот:
         запис про прогін і командний рядок процесу, у якому видно id. */
      const known = runState.runs[id]
      if (known && processAlive(known.pid)) {
        reportOnce(key, `УВАГА ${id} · доробка відкрита, але виконавець pid ${known.pid} ще живий — не чіпаю`)
        continue
      }
      if (!known) {
        const pid = processCarryingNote(id)
        if (pid) {
          reportOnce(key, `УВАГА ${id} · доробка відкрита, але pid ${pid} тримає цей id у командному рядку — не чіпаю`)
          continue
        }
      }

      reworkReported.delete(key)
      enqueueRework(id, rw, `${reason}, підхід ${((memo && memo.at === rw.at && memo.attempts) || 0) + 1}`)
    }
  } finally {
    pollingReworks = false
  }
}

/* ────────────────────────── беклог і цикл ────────────────────────── */

/* `watch` без `since` віддає лише те, що станеться далі — це правильно для
   нього й катастрофічно для рестарту: усе, що лежало до старту, лишилось би
   лежати вічно. Тому перший крок завжди — підбір беклогу. */
async function pickUpBacklog() {
  const pending = await api('GET', '/notes?status=pending')
  const take = pending.filter(dispatchable)
  const waiting = pending.length - take.length
  log(`БЕКЛОГ · pending ${pending.length} · беру ${take.length} · чекають людину ${waiting}`)
  for (const n of take) enqueue(n.id, 'беклог')

  /* Сирітки (`resolved` і `working` без виконавця) розбирає той самий прохід,
     що потім крутиться періодично: разово на старті їх ловити мало — див.
     коментар до `sweepOrphans`. */
  await sweepOrphans('сторожа рестартували')
}

/* Лог прогону осиротілої ноти шукаємо в `runs/` за іменем: воно починається
   з id. Кілька прогонів — беремо найновіший; немає — теку зробимо без
   `run.log`, це чесніше за підкладений чужий. */
function lastRunLog(id) {
  try {
    const hits = fs
      .readdirSync(RUNS_DIR)
      /* Логи доробок сюди не годяться: теку правки складають із прогону, що
         її зробив, а доробка — це вже наступна серія, яка теку не переписує. */
      .filter((f) => f.startsWith(`${id}-`) && !f.startsWith(`${id}-rework-`) && f.endsWith('.log'))
      .sort()
    return hits.length ? path.join(RUNS_DIR, hits[hits.length - 1]) : null
  } catch {
    return null
  }
}

async function watchOnce(sinceMs) {
  return api(
    'GET',
    `/notes/watch?since=${sinceMs}&timeout=${WATCH_TIMEOUT_S}`,
    null,
    (WATCH_TIMEOUT_S + 20) * 1000,
  )
}

async function main() {
  /* Замок беремо ПЕРШИМ ділом — до беклогу, до watch, до будь-якого HTTP.
     Другий інстанс не має встигнути навіть побачити чергу. */
  const lock = await acquireLock()
  if (!lock.ok) {
    const who = lock.pid ? `pid ${lock.pid}` : 'pid невідомий'
    log(`ЗАЙНЯТО · замок ${LOCK_NAME} тримає інший сторож (${who}) — чекаю ${BUSY_WAIT_MS / 1000}с і виходжу з кодом ${EXIT_BUSY}`)
    /* Рядок у stderr пишемо синхронно: одразу за ним `exit`, а асинхронний
       stdout/stderr у трубу systemd може не встигнути злитись. */
    fs.writeSync(2, `Сторож уже працює, ${who} — виходжу.\n`)
    /* Код виходу тут НЕ нуль. Нуль означає «зупинили свідомо» і глушить
       Restart назавжди (`RestartPreventExitStatus=0`) — а «замок зайнято» це
       тимчасова обставина: ручний сторож помре, і юніт мусить підхопити
       чергу сам, інакше система лишається без диспетчера, а `inactive (dead)`
       з нулем виглядає штатно й нікого не насторожує. Пауза перед виходом —
       щоб рестарт кожні RestartSec не молотив у лог, поки той сторож живий. */
    await sleep(BUSY_WAIT_MS)
    process.exit(EXIT_BUSY)
  }

  log(`СТАРТ сторожа · pid ${process.pid} · ноти ${NOTES_URL} · доробки ${RATINGS_URL} · репо ${REPO} · стеля ${MAX_WORKERS} · таймаут прогону ${RUN_TIMEOUT_MS / 60000}хв`)
  for (const c of envComplaints) log(`УВАГА env · ${c}`)
  if (lock.degraded) log(`ЗАМОК недоступний (${lock.degraded}) · працюю без захисту від другого інстансу`)
  else log(`ЗАМОК ${LOCK_NAME} захоплено · pid ${process.pid} · другий інстанс не стартує`)

  loadState()
  sweepTmpDirs()

  /* Курсор знімаємо ДО першого запиту в стор, а не після підбору беклогу.
     Беклог — це два GET-и, а на гілці осиротілих `resolved` ще й запис тек,
     перезбирання індексу й `DELETE` на кожну, тобто секунди. Нота, що
     прилетіла в цю щілину, у беклог уже не потрапила, а watch із пізнішим
     курсором її не віддасть — і вона лежала б до наступного рестарту без
     жодного рядка в лозі. Зайве перекриття нічого не коштує: `enqueue` тримає
     захист від дубля, а `startWorker` перечитує ноту перед стартом. */
  let since = Date.now()

  let backoff = 2000
  /* Беклог пробуємо, доки сервер не відповість: сторож піднімається разом із
     машиною і цілком може випередити сервер нот. */
  for (;;) {
    try {
      await pickUpBacklog()
      break
    } catch (err) {
      log(`СЕРВЕР недоступний на підборі беклогу: ${err.message} · повтор через ${backoff / 1000}с`)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 60_000)
    }
  }

  /* Періодичний прохід по сирітках. `unref` не ставимо навмисно: сторож і так
     висить вічно на watch, а таймер із unref у мить простою міг би дати
     процесу вийти. */
  setInterval(() => {
    void sweepOrphans('періодичний прохід').catch((err) =>
      log(`ПОМИЛКА · прохід по сирітках: ${err.message}`),
    )
  }, SWEEP_MS)

  /* Черга доробок опитується окремим таймером, а не разом із сирітками:
     сервери різні, і недоступний :4748 не має відкладати роботу з нотами.
     Перший прохід — одразу після беклогу, з тієї ж причини: доробки, покладені
     поки сторожа не було, мають початись зараз, а не за хвилину. */
  void pollReworks('старт').catch((err) => log(`ЧЕРГА-ДОРОБОК недоступна: ${err.message}`))
  setInterval(() => {
    void pollReworks('періодичне опитування').catch((err) =>
      log(`ЧЕРГА-ДОРОБОК недоступна: ${err.message}`),
    )
  }, REWORK_POLL_MS)

  backoff = 2000
  for (;;) {
    /* Курсор рухаємо на момент ПЕРЕД запитом: якщо watch віддасть порожньо,
       це доказ, що подій у [since, зараз] не було, і зсув безпечний. */
    const tick = Date.now()
    let batch
    try {
      batch = await watchOnce(since)
      backoff = 2000
    } catch (err) {
      log(`СЕРВЕР недоступний на watch: ${err.message} · повтор через ${backoff / 1000}с`)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 60_000)
      continue
    }

    if (!batch.length) {
      since = tick
      continue
    }

    let maxTs = since
    for (const note of batch) {
      const ts = eventTime(note, since)
      if (ts > maxTs) maxTs = ts
      const why = (note.thread || []).some((m) => m.role === 'human' && Date.parse(m.at) > since)
        ? 'відповідь користувача'
        : 'нова нота'
      /* Нота, що вже в роботі, приходить сюди зі статусом `working`, тобто
         повз `dispatchable`. Просто написати ПРОПУСК означало б викинути
         подію: курсор за нею вже зсунуто, вдруге сервер її не віддасть, і
         відповідь користувача, написана під час прогону, зникла б назовсім.
         Тож спершу питання «чи це наша нота», і аж потім — чи вона придатна. */
      if (inFlight(note.id)) enqueue(note.id, why)
      else if (dispatchable(note)) enqueue(note.id, why)
      else log(`ПРОПУСК ${note.id} · ${why} · статус ${note.status}${waitingForHuman(note) ? ', чекає відповіді людини' : ''}`)
    }
    since = maxTs
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* Зупинка сторожа не має вбивати правку, що вже в роботі: юніт іде з
   KillMode=process, виконавці доживають прогін і самі закривають свої ноти. */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`СТОП сторожа по ${sig} · в роботі ${running.size}, у черзі ${queue.length} — виконавців не чіпаю`)
    process.exit(EXIT_STOPPED)
  })
}

main().catch((err) => {
  log(`ФАТАЛЬНО · ${err.stack || err.message}`)
  process.exit(1)
})
