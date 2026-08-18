#!/usr/bin/env node
// Звірка «індекс vs оригінал»: чи збирається з тек рівно те, що було в лозі.
//
// Це головна перевірка міграції. Порівнюємо не тексти файлів (преамбула й шапки
// свідомо змінились), а вміст рядків-правок: час, тривалість, роут, запит,
// виконавець, результат. Очікувані розбіжності — уніфікація назви колонки,
// доданий стовпець ID і нормалізація пробілів; усе інше — втрата даних.
//
// Запуск: `node server/verify-migration.mjs`

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFixlog } from './fixlog-parse.mjs';
import { readFixes, renderIndex } from './build-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ORIGINAL = path.join(ROOT, 'data', 'fixlog.md.pre-fixes-migration');

const original = parseFixlog(fs.readFileSync(ORIGINAL, 'utf8'));
const regenerated = parseFixlog(renderIndex(readFixes()));

const key = (e) => [
  e.source.date,
  e.source.timeRaw,
  e.source.durationRaw ?? '',
  e.source.routeCell,
  e.note,
  e.source.noteIdSuffix ?? '',
  e.source.agentRaw,
  e.did,
];

const diffs = [];
const a = original.entries;
const b = regenerated.entries;

if (a.length !== b.length) diffs.push({ kind: 'кількість рядків', a: a.length, b: b.length });

for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
  const ka = key(a[i]);
  const kb = key(b[i]);
  const fields = ['date', 'time', 'duration', 'route', 'note', 'noteId', 'agent', 'did'];
  ka.forEach((v, j) => {
    if (v !== kb[j]) {
      diffs.push({
        kind: `поле «${fields[j]}»`,
        row: i + 1,
        line: a[i].source.line,
        was: v,
        now: kb[j],
      });
    }
  });
}

const dates = (x) => [...new Set(x.entries.map((e) => e.source.date))];
const datesA = dates(original);
const datesB = dates(regenerated);
if (datesA.join(',') !== datesB.join(',')) {
  diffs.push({ kind: 'секції дат', was: datesA, now: datesB });
}

const sectionsLost = [...new Set(original.entries.map((e) => e.source.section).filter(Boolean))];

process.stdout.write(
  `${JSON.stringify(
    {
      rowsOriginal: a.length,
      rowsRegenerated: b.length,
      unparsedOriginal: original.unparsed.length,
      unparsedRegenerated: regenerated.unparsed.length,
      dates: datesB,
      subsectionHeadingsDropped: sectionsLost,
      diffs,
    },
    null,
    2,
  )}\n`,
);
process.exit(diffs.length ? 1 : 0);
