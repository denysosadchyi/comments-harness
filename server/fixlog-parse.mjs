// Розбір рукописного `data/fixlog.md` у структуру, з якої робляться теки правок.
//
// Лог писався руками місяць, тож формат неоднорідний: у старих секціях колонка
// виконавця зветься «Маршрут», у нових «Агент»; колонка «Трив.» то є, то немає;
// час буває приблизним (`10:0x`) або відсутнім (`—`); таблиця може продовжитись
// після порожнього рядка вже без шапки. Тому:
//
//   * колонки шукаємо ЗА НАЗВОЮ В ШАПЦІ, не за позицією;
//   * остання побачена шапка діє, доки не зустрінеться нова;
//   * рядок, який не розпізнали, не гине мовчки — він їде у `unparsed`;
//   * шапка без обов'язкової колонки — теж `unparsed`, а не рядок даних;
//   * `id` записів унікальні в межах прогону: повтор дістає суфікс `-2`.
//
// Модуль нічого не пише на диск: віддає розібрані записи, і вже виклик вирішує,
// що з ними робити.

/** Назви колонок → канонічні ключі. Синоніми — це історія файлу, не помилка. */
const COLUMN_ALIASES = {
  'час': 'time',
  'трив.': 'duration',
  'трив': 'duration',
  'роут': 'route',
  'запит': 'note',
  'маршрут': 'agent', // стара назва колонки виконавця
  'агент': 'agent', // нова назва тієї ж колонки
  'що зроблено': 'did',
};

/** Обов'язковий мінімум, без якого рядок не має сенсу як правка. */
const REQUIRED_COLUMNS = ['time', 'route', 'note', 'agent', 'did'];

/**
 * Розбиває рядок таблиці на комірки по `|`, поважаючи екранований `\|`.
 * Markdown-таблиця має провідну й хвостову вертикальну риску — їх відкидаємо.
 */
function splitRow(line) {
  const cells = [];
  let buf = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      buf += '\\|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf);
  // Перша й остання комірки — порожні хвости від крайніх рисок.
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

const isSeparatorRow = (line) => /^\|[\s:|-]+\|?$/.test(line) && line.includes('-');

/**
 * Схоже на шапку? Дві й більше комірок, які є назвами колонок — людина не пише
 * такого в рядку даних. Потрібне окремо від `parseHeader`, бо шапка, у якій
 * бракує обов'язкової колонки, дає `null` — і без цієї перевірки поїхала б у
 * розбір як звичайний рядок під ПОПЕРЕДНЬОЮ шапкою, породивши фальшиву правку
 * з нотою «Запит» і результатом «Що зроблено». Рівно той провал, якого шапка
 * модуля обіцяє не допускати.
 */
function looksLikeHeader(cells) {
  const named = cells.filter((c) => COLUMN_ALIASES[c.toLowerCase().trim()] !== undefined);
  return named.length >= 2;
}

/** Шапка? Тоді віддаємо мапу «канонічний ключ → індекс комірки». */
function parseHeader(cells) {
  const map = {};
  cells.forEach((cell, i) => {
    const key = COLUMN_ALIASES[cell.toLowerCase().trim()];
    if (key && map[key] === undefined) map[key] = i;
  });
  const ok = REQUIRED_COLUMNS.every((k) => map[k] !== undefined);
  return ok ? map : null;
}

/**
 * Ідентифікатор ноти в кінці запиту: `(n-msu2ap8uz2sj)` або старий `(msq5y4gw-od621f)`.
 * Обидві частини base36-подібні, тож вимагаємо цифру в кожній — інакше під шаблон
 * підпадають людські дужки на кшталт `(product-register)`.
 */
const ID_SUFFIX = /\(((?:n-)?[a-z0-9]+-[a-z0-9]+)\)\s*$/i;

function extractNoteId(noteCell) {
  const m = noteCell.match(ID_SUFFIX);
  if (!m) return { note: noteCell, noteId: null };
  const id = m[1];
  const ok = /^n-/i.test(id)
    ? // новий формат: `n-` + один base36-токен
      /^n-[a-z0-9]{8,}$/i.test(id) && /\d/.test(id.slice(2))
    : // старий: два токени через дефіс, у кожному є цифра
      id.split('-').length === 2 &&
      id.split('-').every((p) => p.length >= 4 && /\d/.test(p));
  if (!ok) return { note: noteCell, noteId: null };
  return { note: noteCell.slice(0, m.index).trim(), noteId: id };
}

/** `/booking/detail` з комірки роуту — перший шлях у бектиках або голий слеш-шлях. */
function extractRoute(cell) {
  const backticked = cell.match(/`(\/[^`]*)`/);
  if (backticked) return backticked[1].trim();
  const bare = cell.match(/(^|\s)(\/[^\s,()`]+)/);
  return bare ? bare[2] : null;
}

/** `6хв` → 360000. Приблизні (`~25хв`, `<1хв`) і `—` → null; сирий текст лишається. */
function parseDuration(cell) {
  if (!cell) return null;
  const m = cell.match(/^(\d+)\s*хв$/);
  if (m) return Number(m[1]) * 60000;
  const sec = cell.match(/^(\d+)\s*с$/);
  if (sec) return Number(sec[1]) * 1000;
  return null;
}

/** `10:37` + `2026-08-12` → ISO. Приблизний час (`10:0x`) не конвертується. */
function parseCreatedAt(date, time) {
  const m = time.match(/^(\d{2}):(\d{2})$/);
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // Лог писався в локальному часі Києва (UTC+3 влітку) — фіксуємо зсув явно,
  // бо інакше ISO поїде разом із таймзоною машини, що перегенеровує індекс.
  return `${date}T${m[1]}:${m[2]}:00.000+03:00`;
}

/**
 * Смуга виконавця. `opencode` у будь-якому написанні (в т.ч. `**opencode**`,
 * `opencode→sonnet`) — це opencode; «сам» — правка руками користувача; решта
 * (agent, opus, sonnet, Opus 5, claude…) — claude.
 */
function deriveLane(agentCell) {
  const plain = agentCell.replace(/\*/g, '').toLowerCase().trim();
  if (plain.includes('opencode')) return 'opencode';
  if (plain === 'сам' || plain.startsWith('сам ')) return 'self';
  return 'claude';
}

/** «Не зроблено», «Змін не робив», «доробка» → правка не доїхала. */
function deriveOutcome(didCell) {
  const plain = didCell.replace(/\*/g, '').toLowerCase();
  if (/^не зроблено|^змін не роб|^відхилен|^не робив/.test(plain.trim())) return 'dismissed';
  return 'done';
}

/**
 * @param {string} md  вміст fixlog.md
 * @returns {{ entries: object[], unparsed: {line:number, text:string, why:string}[], preamble: string }}
 */
export function parseFixlog(md) {
  const lines = md.split('\n');
  const entries = [];
  const unparsed = [];

  let date = null;
  let section = null;
  let header = null;
  let preambleEnd = lines.findIndex((l) => /^##\s/.test(l));
  if (preambleEnd < 0) preambleEnd = lines.length;
  const preamble = lines.slice(0, preambleEnd).join('\n').trimEnd();

  const perDateCounter = new Map();
  /* Контракт модуля — «один запис = одна тека», отже id мусить бути унікальним
     ТУТ, а не в тому, хто потім пише теки. Повтори бувають справжні: та сама
     скарга подана двічі писалась окремим рядком із тим самим `(n-…)` суфіксом,
     і в лозі таких пар п'ять. Другий і далі отримують `-2`, `-3`, а звідки вони
     родом — лишається в `source.duplicateOf`. Без цього наступний споживач
     просто перезапише перший запис другим і не помітить. */
  const seenIds = new Map();
  function uniqueId(base) {
    const n = (seenIds.get(base) || 0) + 1;
    seenIds.set(base, n);
    if (n === 1) return { id: base, duplicateOf: null };
    let candidate = `${base}-${n}`;
    // Малоймовірно, але суфіксований варіант міг уже трапитись сам по собі.
    for (let k = n; seenIds.has(candidate); k += 1) candidate = `${base}-${k + 1}`;
    seenIds.set(candidate, 1);
    return { id: candidate, duplicateOf: base };
  }

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();

    const dateHead = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (dateHead) {
      date = dateHead[1];
      section = null;
      header = null; // нова дата — шапку треба побачити наново
      continue;
    }
    if (/^###\s+/.test(line)) {
      section = line.replace(/^###\s+/, '').trim();
      continue;
    }
    if (!line.startsWith('|')) continue;
    if (isSeparatorRow(line)) continue;

    const cells = splitRow(line);
    const maybeHeader = parseHeader(cells);
    if (maybeHeader) {
      header = maybeHeader;
      continue;
    }
    if (looksLikeHeader(cells)) {
      // Це шапка, але неповна. Ані даними її брати не можна, ані діючою шапкою
      // ставити — тож попередня лишається, а рядок їде в `unparsed` з причиною.
      const missing = REQUIRED_COLUMNS.filter(
        (k) => !cells.some((c) => COLUMN_ALIASES[c.toLowerCase().trim()] === k),
      );
      unparsed.push({
        line: i + 1,
        text: line,
        why: `шапка без обов'язкових колонок: ${missing.join(', ')}`,
      });
      continue;
    }

    if (!header) {
      unparsed.push({ line: i + 1, text: line, why: 'рядок таблиці до будь-якої шапки' });
      continue;
    }
    if (!date) {
      unparsed.push({ line: i + 1, text: line, why: 'рядок поза секцією дати' });
      continue;
    }
    const need = Math.max(...Object.values(header)) + 1;
    if (cells.length < need) {
      unparsed.push({
        line: i + 1,
        text: line,
        why: `комірок ${cells.length}, шапка вимагає ${need}`,
      });
      continue;
    }

    const cell = (key) => (header[key] === undefined ? '' : cells[header[key]]);
    const timeRaw = cell('time');
    const durationRaw = header.duration === undefined ? null : cell('duration');
    const routeCell = cell('route');
    const agentRaw = cell('agent');
    const did = cell('did');
    const { note, noteId } = extractNoteId(cell('note'));

    if (!note && !did) {
      unparsed.push({ line: i + 1, text: line, why: 'порожні і запит, і результат' });
      continue;
    }

    const n = (perDateCounter.get(date) || 0) + 1;
    perDateCounter.set(date, n);
    const { id, duplicateOf } = uniqueId(noteId || `f-${date}-${String(n).padStart(2, '0')}`);

    entries.push({
      id,
      createdAt: parseCreatedAt(date, timeRaw),
      closedAt: null,
      durationMs: parseDuration(durationRaw),

      note,
      url: null,
      route: extractRoute(routeCell),
      selector: null,
      fullPath: null,
      tagName: null,
      classes: null,
      components: [],
      rect: null,
      viewport: null,

      lane: deriveLane(agentRaw),
      agent: agentRaw,
      did,
      files: [],
      shot: null,
      outcome: deriveOutcome(did),

      // Сира форма рядка лога. Тримаємо її, бо індекс — похідний файл: без
      // сирих комірок його не зібрати назад символ у символ (приблизний час
      // `10:0x`, «~25хв», уточнення в дужках біля роуту в ISO не лягають).
      source: {
        file: 'fixlog.md',
        line: i + 1,
        date,
        section,
        timeRaw,
        durationRaw,
        routeCell,
        noteIdSuffix: noteId,
        agentRaw,
        // Заповнене лише в повторах: id з лога, який уже був зайнятий.
        ...(duplicateOf ? { duplicateOf } : {}),
      },
    });
  }

  return { entries, unparsed, preamble };
}
