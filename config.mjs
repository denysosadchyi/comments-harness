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
  executor: {
    /* Чим сторож запускає правку. Порожній рядок = `~/.local/bin/claude`. */
    command: '',
    /* Аргументи. `{{BRIEF}}` підставляється текстом брифу. */
    args: ['-p', '{{BRIEF}}', '--dangerously-skip-permissions'],
    /* Підпис у колонці «Агент» історії правок. */
    label: 'Opus 5',
  },
  watchdog: {
    /* Стеля одночасних виконавців: кожен — повноцінна сесія з правками файлів. */
    maxWorkers: 2,
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
  executor: {
    /* `WATCHDOG_CLAUDE` лишено назвою заради сумісності зі старими скриптами
       й юнітами, які її вже передають. */
    command:
      envStr('WATCHDOG_CLAUDE', fileExec.command || d.executor.command) ||
      join(homedir(), '.local/bin/claude'),
    args: Array.isArray(fileExec.args) && fileExec.args.length ? fileExec.args : d.executor.args,
    label: envStr('WATCHDOG_AGENT_LABEL', fileExec.label || d.executor.label),
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
