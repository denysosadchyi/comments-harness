#!/usr/bin/env node
// Генератор `data/fixlog.md` з тек правок.
//
// Після переїзду на `data/fixes/<id>/` джерело істини — тека, а fixlog.md став
// ПОХІДНИМ індексом: один файл, який людина гортає й грепає. Руками його більше
// не редагують — правка тут переживе рівно до наступного прогону генератора.
//
// Запуск: `node server/build-index.mjs` (з кореня comments-harness) або
// імпорт `buildIndex()` зі сторожа після закриття ноти.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXES_DIR = path.join(ROOT, 'data', 'fixes');
const INDEX_FILE = path.join(ROOT, 'data', 'fixlog.md');

const PREAMBLE = `# Fix log

Правки, що прийшли з нотаток оверлея (\`overlay/\`, сервер на :4747).

**Файл похідний — руками не редагувати.** Джерело істини це теки
\`data/fixes/<id>/\`; цей індекс перезбирається з них
(\`node server/build-index.mjs\`). Локальний файл — у git не потрапляє
(\`.git/info/exclude\`).

Колонка \`ID\` — ім'я теки правки: \`data/fixes/<ID>/\`.

---`;

const COLUMNS = ['Час', 'Трив.', 'Роут', 'Запит', 'Агент', 'Що зроблено', 'ID'];

// Читає всі fix.json у теках правок. Тека без валідного fix.json — не правка.
export function readFixes(dir = FIXES_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    // Сторож збирає теку в `.tmp-<id>-<pid>/` і кладе туди `fix.json` ДО
    // перейменування. Помер у цю щілину — тека лишилась, і рядок індексу з неї
    // вказував би на теку, якої не існує під тим ID. Крапка на початку — це
    // «ще не правка» (або взагалі не наше), і в індекс воно не їде.
    if (name.startsWith('.')) continue;
    const file = path.join(dir, name, 'fix.json');
    if (!fs.existsSync(file)) continue;
    try {
      const fix = JSON.parse(fs.readFileSync(file, 'utf8'));
      fix.__dir = name;
      out.push(fix);
    } catch (err) {
      process.stderr.write(`build-index: ${name}/fix.json не читається — ${err.message}\n`);
    }
  }
  return out;
}

/** Дата секції: з мігрованого сирцю, інакше з createdAt. */
function dateOf(fix) {
  if (fix.source?.date) return fix.source.date;
  if (fix.createdAt) return new Date(fix.createdAt).toISOString().slice(0, 10);
  return 'без дати';
}

/** Час у комірці: сирий рядок мігрованих (може бути `10:0x` чи `—`), інакше HH:MM. */
function timeCell(fix) {
  if (fix.source?.timeRaw) return fix.source.timeRaw;
  if (!fix.createdAt) return '—';
  const d = new Date(fix.createdAt);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function durationCell(fix) {
  if (fix.source?.durationRaw != null) return fix.source.durationRaw || '—';
  if (!fix.durationMs) return '—';
  const min = Math.round(fix.durationMs / 60000);
  return min < 1 ? '<1хв' : `${min}хв`;
}

/** Роут: у мігрованих комірка часто несе уточнення (компонент, селектор) — беремо її. */
function routeCell(fix) {
  if (fix.source?.routeCell) return fix.source.routeCell;
  if (fix.route) return `\`${fix.route}\``;
  return '—';
}

/** Запит + суфікс `(id)`, якщо він там був у рукописному лозі. */
function noteCell(fix) {
  const suffix = fix.source?.noteIdSuffix ? ` (${fix.source.noteIdSuffix})` : '';
  return `${fix.note || ''}${suffix}`;
}

const agentCell = (fix) => fix.source?.agentRaw || fix.agent || fix.lane || '—';

/**
 * Порядок усередині дня: мігровані тримають порядок рядків оригіналу, нові
 * (без `source`) сортуються за часом і йдуть після мігрованих того ж дня.
 */
function orderKey(fix) {
  if (typeof fix.source?.line === 'number') return [0, fix.source.line];
  return [1, fix.createdAt ? Date.parse(fix.createdAt) : 0];
}

/* Комірка Markdown-таблиці не переживає ані `|`, ані переносу рядка: перший
   ріже комірку навпіл і зсуває всі наступні, другий обриває рядок таблиці.
   Текст сюди приходить з ноти й зі звіту виконавця, тобто з двох джерел, які
   про Markdown нічого не знають. Екранування живе САМЕ ТУТ, у рендері індексу,
   а не в тому, хто пише теку: тека — джерело істини й тримає текст незайманим,
   покалічити його заради формату похідного файлу було б переплутати ролі. */
const cell = (v) =>
  String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();

export function renderIndex(fixes) {
  const byDate = new Map();
  for (const fix of fixes) {
    const d = dateOf(fix);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(fix);
  }

  const parts = [PREAMBLE];
  for (const date of [...byDate.keys()].sort()) {
    const rows = byDate.get(date).sort((a, b) => {
      const [ka, va] = orderKey(a);
      const [kb, vb] = orderKey(b);
      return ka - kb || va - vb;
    });
    parts.push(`## ${date}`);
    parts.push(
      [
        `| ${COLUMNS.join(' | ')} |`,
        `|${COLUMNS.map(() => '---').join('|')}|`,
        ...rows.map((fix) => {
          const cells = [
            timeCell(fix),
            durationCell(fix),
            routeCell(fix),
            noteCell(fix),
            agentCell(fix),
            fix.did || '',
            `\`${fix.id}\``,
          ].map(cell);
          return `| ${cells.join(' | ')} |`;
        }),
      ].join('\n'),
    );
  }
  return `${parts.join('\n\n')}\n`;
}

/* Скільки рядків правок у вже наявному індексі. Рядок правки — це рядок
   таблиці, який не шапка й не роздільник; рахуємо його по останній колонці
   `ID` у бектиках, бо тільки вона є в кожному рядку даних і в жодній шапці. */
function countIndexRows(indexFile) {
  if (!fs.existsSync(indexFile)) return 0;
  const md = fs.readFileSync(indexFile, 'utf8');
  let n = 0;
  for (const line of md.split('\n')) {
    if (line.startsWith('|') && /\|\s*`[^`]+`\s*\|\s*$/.test(line)) n += 1;
  }
  return n;
}

/**
 * Перезапис індексу: temp поруч + renameSync, щоб читач не спіймав недописаний файл.
 *
 * Індекс не має права схуднути. `readFixes` ловить нечитабельний `fix.json`,
 * пише рядок у stderr і йде далі — а `buildIndex` перезаписує файл ЦІЛКОМ, тож
 * така правка тихо зникає з єдиного файлу, який людина грепає, і виклик рапортує
 * успіх. Тому: зібрали менше тек, ніж уже є рядків в індексі — це аварія, а не
 * робочий стан. Кидаємо, старий індекс лишається на диску недоторканим.
 *
 * `allowShrink` — єдиний законний виняток: людина СВІДОМО видалила теку правки
 * (тестовий запис, дубль) і хоче, щоб індекс це відобразив. Прапорець існує
 * саме тому, що інакше запобіжник перетворюється на глухий кут: після ручного
 * видалення індекс не перезбирається ніколи, і кожен наступний виклик падає.
 * За замовчуванням він вимкнений, тож автоматичний шлях (сторож) захищений.
 */
export function buildIndex({ fixesDir = FIXES_DIR, indexFile = INDEX_FILE, allowShrink = false } = {}) {
  const fixes = readFixes(fixesDir);
  const had = countIndexRows(indexFile);
  if (!allowShrink && fixes.length < had) {
    throw new Error(
      `build-index: зібрано ${fixes.length} тек, а в ${indexFile} уже ${had} рядків — ` +
        'відмовляюся перезаписувати. Ймовірно, нечитабельний fix.json (див. stderr вище) ' +
        'або зникла тека. Індекс лишено як був. Якщо теку видалено свідомо — buildIndex({ allowShrink: true }).',
    );
  }
  const md = renderIndex(fixes);
  const tmp = `${indexFile}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, md, 'utf8');
    fs.renameSync(tmp, indexFile);
  } catch (err) {
    // Не лишаємо сміття, якщо впав саме rename — так само, як обидва сервери.
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* писати вже нічим не допоможе — запис і так провалився */
    }
    throw err;
  }
  return { count: fixes.length, bytes: Buffer.byteLength(md) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const res = buildIndex();
    process.stdout.write(`build-index: ${res.count} правок → ${INDEX_FILE} (${res.bytes} Б)\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
