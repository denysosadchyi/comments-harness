/* Єдине джерело налаштувань harness.
   ────────────────────────────────────────────────────────────────────────
   Досі частина значень була константами в коді (порти, стеля виконавців),
   частина — змінними оточення (`WATCHDOG_*`), а корінь проєкту вгадувався
   від розташування файлу. Для однієї інсталяції це працювало; для теки, яку
   клонують у чужий проєкт, — ні: людина не має шукати по трьох файлах, де
   поміняти шлях до `claude`.

   Тепер порядок такий, від слабкого до сильного:

       дефолт у цьому файлі  →  harness.config.json  →  змінна оточення

   `harness.config.json` створює `setup.mjs`, у git він не їде (машинозалежні
   шляхи), а env лишається як разове перевизначення — зручно для «підняти
   другий екземпляр на інших портах, щоб не зачепити живий».

   Файл читається СИНХРОННО на імпорті й навмисно: усі споживачі (два сервери,
   MCP-міст, сторож) читають конфіг першою дією, ще до відкриття портів, і
   асинхронність тут дала б лише вікно, у якому значення ще немає.

   Нуль залежностей, як і всюди в цій теці. */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/* Корінь самої теки harness — від розташування цього файлу, ніколи від cwd:
   сервери піднімаються то з кореня проєкту, то з юніта systemd зі своїм
   WorkingDirectory, і шлях, що залежить від cwd, створив би другий стор. */
export const HARNESS_ROOT = resolve(import.meta.dirname)
export const CONFIG_FILE = join(HARNESS_ROOT, 'harness.config.json')

/* Проєкт-господар — тека, у яку клонували harness. Дефолт «на рівень вище»
   вірний для звичайного розкладу `<проєкт>/comments-harness/`; якщо у когось
   інакше, `setup.mjs` запише реальний шлях у конфіг. */
const DEFAULT_PROJECT_ROOT = resolve(HARNESS_ROOT, '..')

/* Префікс імен юнітів systemd і замка інстансу. Виводиться з назви теки
   проєкту: зашите імʼя в чужому репозиторії — чуже імʼя, за яким
   людина не впізнає свій процес. Санітизація мінімальна: systemd не любить
   у назві юніта нічого, крім букв, цифр, дефіса й підкреслення. */
export function derivePrefix(projectRoot) {
  const raw = basename(resolve(projectRoot)).toLowerCase()
  const clean = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return clean || 'harness'
}

/* ── Дефолти ──────────────────────────────────────────────────────────────
   Кожне поле тут — це те, що побачить людина, яка відкриє згенерований
   `harness.config.json`. Перелік навмисно повний: значення, якого немає у
   файлі, доводиться шукати в коді, а це рівно та проблема, яку конфіг знімає. */
export const DEFAULTS = {
  /* Корінь проєкту-господаря. Виконавець стартує саме тут (`cwd`), і сюди ж
     дивляться юніти systemd. */
  projectRoot: DEFAULT_PROJECT_ROOT,
  /* Префікс імен юнітів і замка; порожній рядок = вивести з projectRoot. */
  prefix: '',
  /* Сервер нот. Браузерні клієнти (оверлей і рев'ю-сторінка) цього файлу не
     читають, але порти з нього дістають самі: дефолт продубльований у
     `client/endpoints.js` (єдине місце на обох клієнтів), нестандартний —
     приїжджає з `harness-ports.json`, який кладе setup, і з `GET /config`
     самого сервера нот. Міняєш тут — перезапусти setup.mjs, більше нічого. */
  notesPort: 4747,
  /* Сервер вердиктів і черги доробок. Клієнти дізнаються цей порт виключно з
     `GET /config` — другого дефолту в браузері свідомо немає. */
  ratingsPort: 4748,
  /* Обидва сервери слухають усі інтерфейси: рев'ю відкривають з телефона й
     з іншої машини. Хочеш замкнути на локальну — став '127.0.0.1'. */
  host: '0.0.0.0',
  /* Виконавці. Не один, а набір профілів: «прибери лінію» і «перебудуй
     адмінську таблицю в картки» — різна робота, і платити за них однаково
     немає причин. Профіль обирає класифікатор (див. `triage` нижче), а
     сторож лише запускає обраний.

     `order` — це і перелік профілів, і шкала: від слабкого до сильного.
     ОСТАННІЙ у списку — сильний профіль, і саме він береться, коли
     класифікатор упав, віддав сміття або спрацювала ескалація. Додати
     третій рівень — це дописати профіль сюди й назвати його в `order`
     та в шаблоні класифікатора; коду це не чіпає. */
  executors: {
    order: ['simple', 'complex'],
    profiles: {
      /* Детермінована правка: названий елемент, зрозуміла дія, відомий
         токен, один-два селектори. Sonnet 5 тут акуратний і вчетверо
         дешевший за Opus; більшість реальних нот саме такі. */
      simple: {
        /* Чим запускати. Порожній рядок = `~/.local/bin/claude`. */
        command: '',
        /* Аргументи. `{{BRIEF}}` — текст брифу, `{{MODEL}}` — поле `model`. */
        args: ['-p', '{{BRIEF}}', '--model', '{{MODEL}}', '--dangerously-skip-permissions'],
        /* Ім'я моделі йде в CLI аргументом, а не зашите в код. */
        model: 'sonnet',
        /* Підпис у колонці «Агент» історії правок. */
        label: 'Sonnet 5',
      },
      /* У правці є рішення: формулювання без «як», спільний компонент із
         багатьма споживачами, зміна композиції, або спершу треба зʼясувати
         причину. Тут сильна модель окупається — і сюди ж падає все, у чому
         класифікатор не впевнений. */
      complex: {
        command: '',
        args: ['-p', '{{BRIEF}}', '--model', '{{MODEL}}', '--dangerously-skip-permissions'],
        model: 'opus',
        label: 'Opus 5',
      },
    },
  },
  /* Класифікатор — дешевий прогін перед виконавцем, який читає ноту й каже,
     котрий профіль брати. Модель маленька, промпт короткий, таймаут у
     секундах: це не робота, а рішення про роботу, і воно не має коштувати
     як сама правка. Критерії живуть у `template`, не в коді. */
  triage: {
    /* Вимкнути = завжди брати сильний профіль (поведінка до маршрутизації). */
    enabled: true,
    command: '',
    /* `{{PROMPT}}` — текст промпта класифікатора, `{{MODEL}}` — поле `model`. */
    args: ['-p', '{{PROMPT}}', '--model', '{{MODEL}}'],
    model: 'haiku',
    /* Свій таймаут, короткий. Класифікатор, який думає хвилину, з'їдає ту
       саму економію, заради якої він є. Шістдесят — бо на живому прогін
       класифікатора займав 14–38 с, і верхня межа там була саме тоді, коли
       поруч працювали чотири виконавці. */
    timeoutS: 60,
    /* Файл шаблона поруч із `brief-template.md`. */
    template: 'triage-template.md',
  },
  /* Консультант. Раніше виконавець, якому неясно, дописував питання в тред і
     повертав ноту в `pending` — і вона стояла, доки людина не відповість.
     Тобто конвеєр, збудований щоб прибрати людину з кінця `notes_watch`,
     повертав її ж у середину. Тепер питання йде до консультанта: сильна
     модель, яка нічого не править, а лише ухвалює рішення, і виконавець це
     рішення виконує в тому ж прогоні.

     Ім'я моделі окремим полем навмисно: питання ціни відкрите, і замінити
     `fable` на `opus` має бути одним рядком у конфізі, а не правкою коду.
     Таймаут теж свій — консультант, що думає довше за саму правку, це не
     консультація, а зупинка. */
  consultant: {
    /* `false` = стара поведінка: питання → `pending` → чекаємо людину. */
    enabled: true,
    command: '',
    /* `{{PROMPT}}` — текст запиту до консультанта, `{{MODEL}}` — поле `model`. */
    args: ['-p', '{{PROMPT}}', '--model', '{{MODEL}}'],
    model: 'fable',
    timeoutS: 300,
    template: 'consultant-template.md',
  },
  watchdog: {
    /* Стеля одночасних виконавців: кожен — повноцінна сесія з правками файлів.
       Чотири безпечні лише тому, що сторож не пускає два прогони на один
       екран (замок за роутом і верхнім компонентом), інакше вони правили б
       одні файли одночасно. */
    maxWorkers: 4,
    /* Прогін без стелі висить вічно й тримає ноту в `working`. */
    runTimeoutMin: 15,
    /* Довжина одного довгого опитування нот. */
    watchTimeoutS: 60,
    /* Перепрочитування стору: watch не віддає зміну статусу. */
    sweepS: 60,
    /* Пауза перед виходом, коли замок тримає інший сторож. */
    busyWaitS: 30,
    /* Черга доробок watch не вміє, тож опитується. */
    reworkPollS: 60,
    /* Скільки разів пробувати одну й ту саму ітерацію доробки. */
    reworkAttempts: 2,
  },
}

/* ── Читання ──────────────────────────────────────────────────────────────
   Битий конфіг зупиняє процес, а не відкочується до дефолтів мовчки: тихий
   відкат означав би сервер на іншому порту, ніж чекає оверлей, і година
   пошуків «чому нота не зберігається». */
function readFile() {
  if (!existsSync(CONFIG_FILE)) return {}
  let raw
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8')
  } catch (err) {
    console.error(`[harness] не прочитати ${CONFIG_FILE}: ${err.message}`)
    process.exit(1)
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('очікувався обʼєкт')
    }
    return parsed
  } catch (err) {
    console.error(`[harness] ${CONFIG_FILE} невалідний: ${err.message}`)
    process.exit(1)
  }
}

/* Дрібні хелпери під env-перевизначення. Числа валідуємо, бо `Number('x')`
   це NaN, а NaN далі тихо ламає геть різні речі: стеля в NaN не пускає
   жодного виконавця, таймаут у NaN гасить прогін за мілісекунду. */
const complaints = []
function envInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    complaints.push(`${name}="${raw}" не ціле в [${min}, ${max}] — беру ${fallback}`)
    return fallback
  }
  return parsed
}
const envStr = (name, fallback) => process.env[name] || fallback
const num = (v, fallback) => (Number.isInteger(v) && v > 0 ? v : fallback)

const file = readFile()
const fileExec = file.executor && typeof file.executor === 'object' ? file.executor : {}
const fileWd = file.watchdog && typeof file.watchdog === 'object' ? file.watchdog : {}
const d = DEFAULTS

/* ── Виконавці ────────────────────────────────────────────────────────────
   Профілі збираються по одному: дефолт → однойменний профіль із файлу.
   Старий однопрофільний ключ `executor` (він лежить у вже згенерованих
   `harness.config.json`) не викидаємо, а читаємо як налаштування СИЛЬНОГО
   профілю: до маршрутизації ним ішло все, тож саме таке успадкування нічого
   нікому не ламає. */
const DEFAULT_CLAUDE = join(homedir(), '.local/bin/claude')

const fileExecutors =
  file.executors && typeof file.executors === 'object' ? file.executors : {}
const fileProfiles =
  fileExecutors.profiles && typeof fileExecutors.profiles === 'object'
    ? fileExecutors.profiles
    : {}

/* Порядок — джерело істини про те, який профіль сильний (останній). Крива
   послідовність тут коштувала б дорожче за скаргу: маршрутизація мовчки
   поїхала б не туди, і зрозуміти це можна було б лише за рахунком. */
function resolveOrder() {
  const raw = Array.isArray(fileExecutors.order) ? fileExecutors.order : d.executors.order
  const names = raw.filter((n) => typeof n === 'string' && n)
  const known = names.filter((n) => n in d.executors.profiles || n in fileProfiles)
  if (!known.length) {
    complaints.push(
      `executors.order=${JSON.stringify(raw)} не називає жодного відомого профілю — беру [${d.executors.order}]`,
    )
    return [...d.executors.order]
  }
  for (const n of names) {
    if (!known.includes(n)) complaints.push(`executors.order містить невідомий профіль "${n}" — пропускаю`)
  }
  return known
}

const executorOrder = resolveOrder()
const strongestName = executorOrder[executorOrder.length - 1]

function buildProfile(name) {
  const base = d.executors.profiles[name] || d.executors.profiles[d.executors.order.at(-1)]
  const over = fileProfiles[name] && typeof fileProfiles[name] === 'object' ? fileProfiles[name] : {}
  /* Спадок від старого `executor`: тільки сильному профілю й тільки там,
     де новий ключ мовчить. */
  const legacy = name === strongestName ? fileExec : {}
  const pick = (key) => (over[key] !== undefined ? over[key] : legacy[key])
  const args = pick('args')
  return {
    name,
    command: envStr('WATCHDOG_CLAUDE', pick('command') || base.command) || DEFAULT_CLAUDE,
    args: Array.isArray(args) && args.length ? args : base.args,
    model: pick('model') || base.model,
    label:
      (name === strongestName ? envStr('WATCHDOG_AGENT_LABEL', pick('label') || base.label) : null) ||
      pick('label') ||
      base.label,
  }
}

const executorProfiles = Object.fromEntries(executorOrder.map((n) => [n, buildProfile(n)]))

const fileTriage = file.triage && typeof file.triage === 'object' ? file.triage : {}
const triageArgs = Array.isArray(fileTriage.args) && fileTriage.args.length ? fileTriage.args : d.triage.args
const fileCons = file.consultant && typeof file.consultant === 'object' ? file.consultant : {}
const consArgs = Array.isArray(fileCons.args) && fileCons.args.length ? fileCons.args : d.consultant.args

const projectRoot = resolve(
  envStr('HARNESS_PROJECT_ROOT', file.projectRoot || d.projectRoot),
)

export const config = {
  harnessRoot: HARNESS_ROOT,
  projectRoot,
  prefix: envStr('HARNESS_PREFIX', file.prefix || '') || derivePrefix(projectRoot),
  notesPort: envInt('HARNESS_NOTES_PORT', num(file.notesPort, d.notesPort), {
    min: 1,
    max: 65535,
  }),
  ratingsPort: envInt('HARNESS_RATINGS_PORT', num(file.ratingsPort, d.ratingsPort), {
    min: 1,
    max: 65535,
  }),
  host: envStr('HARNESS_HOST', file.host || d.host),
  executors: {
    order: executorOrder,
    profiles: executorProfiles,
  },
  /* Читабельний скорочений доступ: `executor` — це сильний профіль. Він же
     дефолт на випадок, коли маршрутизувати нема чим (класифікатор вимкнено,
     упав, або взагалі не було чого класифікувати). Друга причина лишити
     ключ — `setup.mjs` і старі скрипти вже його читають. */
  executor: executorProfiles[strongestName],
  triage: {
    enabled: fileTriage.enabled === undefined ? d.triage.enabled : Boolean(fileTriage.enabled),
    /* Той самий `WATCHDOG_CLAUDE`: бінарник у класифікатора і виконавця один. */
    command: envStr('WATCHDOG_CLAUDE', fileTriage.command || d.triage.command) || DEFAULT_CLAUDE,
    args: triageArgs,
    model: fileTriage.model || d.triage.model,
    timeoutS: envInt('WATCHDOG_TRIAGE_TIMEOUT_S', num(fileTriage.timeoutS, d.triage.timeoutS), {
      min: 5,
      max: 600,
    }),
    template: fileTriage.template || d.triage.template,
  },
  consultant: {
    enabled: fileCons.enabled === undefined ? d.consultant.enabled : Boolean(fileCons.enabled),
    command: envStr('WATCHDOG_CLAUDE', fileCons.command || d.consultant.command) || DEFAULT_CLAUDE,
    args: consArgs,
    model: fileCons.model || d.consultant.model,
    timeoutS: envInt(
      'WATCHDOG_CONSULTANT_TIMEOUT_S',
      num(fileCons.timeoutS, d.consultant.timeoutS),
      { min: 10, max: 3600 },
    ),
    template: fileCons.template || d.consultant.template,
  },
  watchdog: {
    maxWorkers: envInt('WATCHDOG_MAX_WORKERS', num(fileWd.maxWorkers, d.watchdog.maxWorkers), {
      min: 1,
      max: 32,
    }),
    runTimeoutMin: envInt(
      'WATCHDOG_RUN_TIMEOUT_MIN',
      num(fileWd.runTimeoutMin, d.watchdog.runTimeoutMin),
      { min: 1, max: 24 * 60 },
    ),
    watchTimeoutS: envInt(
      'WATCHDOG_WATCH_TIMEOUT_S',
      num(fileWd.watchTimeoutS, d.watchdog.watchTimeoutS),
      { min: 1, max: 600 },
    ),
    sweepS: envInt('WATCHDOG_SWEEP_S', num(fileWd.sweepS, d.watchdog.sweepS), {
      min: 5,
      max: 3600,
    }),
    busyWaitS: envInt('WATCHDOG_BUSY_WAIT_S', num(fileWd.busyWaitS, d.watchdog.busyWaitS), {
      min: 0,
      max: 600,
    }),
    reworkPollS: envInt('WATCHDOG_REWORK_POLL_S', num(fileWd.reworkPollS, d.watchdog.reworkPollS), {
      min: 5,
      max: 3600,
    }),
    reworkAttempts: envInt(
      'WATCHDOG_REWORK_ATTEMPTS',
      num(fileWd.reworkAttempts, d.watchdog.reworkAttempts),
      { min: 1, max: 10 },
    ),
  },
}

/* Скарги на криві env віддаємо споживачу, а не друкуємо звідси: у сторожа
   свій лог-файл, у серверів — stdout, і рядок у чужому форматі загубиться. */
export const configComplaints = complaints

export const NOTES_URL = `http://127.0.0.1:${config.notesPort}`
export const RATINGS_URL = `http://127.0.0.1:${config.ratingsPort}`

export default config
