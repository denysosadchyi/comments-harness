#!/usr/bin/env node
// Одноразова міграція: рукописний `data/fixlog.md` → теки `data/fixes/<id>/`.
//
// Після неї fixlog.md стає похідним (див. `server/build-index.mjs`), а історія
// живе в теках. Скрипт нічого не видаляє: оригінал лога кладеться поруч як
// `fixlog.md.pre-fixes-migration` і лишається на диску, доки міграція не влаштує.
//
// Запуск: `node server/migrate-fixlog.mjs [--dry]`

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFixlog } from './fixlog-parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOG = path.join(ROOT, 'data', 'fixlog.md');
const BACKUP = `${LOG}.pre-fixes-migration`;
const FIXES_DIR = path.join(ROOT, 'data', 'fixes');

const dry = process.argv.includes('--dry');

/** Людиночитаний бік теки: запит користувача і, якщо є, що зроблено. */
function renderNote(fix) {
  const lines = [`# ${fix.id}`, ''];
  const meta = [
    fix.source?.date && fix.source?.timeRaw ? `**Коли:** ${fix.source.date} ${fix.source.timeRaw}` : null,
    fix.source?.routeCell ? `**Роут:** ${fix.source.routeCell}` : null,
    `**Виконавець:** ${fix.agent || '—'} (${fix.lane})`,
    fix.source?.durationRaw ? `**Тривалість:** ${fix.source.durationRaw}` : null,
  ].filter(Boolean);
  lines.push(...meta, '', '## Запит', '', fix.note || '—');
  if (fix.did) lines.push('', '## Що зроблено', '', fix.did);
  lines.push(
    '',
    '---',
    '',
    `Мігровано з \`fixlog.md\` (рядок ${fix.source?.line ?? '?'}). Селектор, компоненти,`,
    'кадр і перелік файлів у рукописному лозі не зберігались — тому їх тут немає.',
    '',
  );
  return lines.join('\n');
}

// Джерело — рукописний лог. Якщо міграція вже бігала, `fixlog.md` на диску вже
// ПОХІДНИЙ (з колонкою ID і зведеними шапками), і другий прогін по ньому дав би
// зсунуті номери рядків і втрачені підзаголовки. Тому за наявності бекапу
// читаємо саме його — оригінал.
const source = fs.existsSync(BACKUP) ? BACKUP : LOG;
const md = fs.readFileSync(source, 'utf8');
const { entries, unparsed } = parseFixlog(md);

// Ідентифікатор ноти в лозі трапляється двічі: повторна подача тієї самої
// скарги писалась окремим рядком із тим самим id. Теки мусять бути унікальні,
// тож повтори отримують суфікс `-2`, `-3` — і про це сказано у звіті.
const seen = new Map();
const collisions = [];
for (const fix of entries) {
  const n = (seen.get(fix.id) || 0) + 1;
  seen.set(fix.id, n);
  if (n > 1) {
    collisions.push({ id: fix.id, line: fix.source.line, folder: `${fix.id}-${n}` });
    fix.source.duplicateOf = fix.id;
    fix.id = `${fix.id}-${n}`;
  }
}

if (!dry) {
  if (!fs.existsSync(BACKUP)) fs.copyFileSync(LOG, BACKUP);
  fs.mkdirSync(FIXES_DIR, { recursive: true });
  for (const fix of entries) {
    const dir = path.join(FIXES_DIR, fix.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fix.json'), `${JSON.stringify(fix, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'note.md'), renderNote(fix), 'utf8');
  }
}

const report = {
  parsed: entries.length,
  folders: dry ? 0 : entries.length,
  duplicateIds: collisions,
  unparsed,
  lanes: entries.reduce((acc, f) => ({ ...acc, [f.lane]: (acc[f.lane] || 0) + 1 }), {}),
  generatedIds: entries.filter((f) => f.id.startsWith('f-')).length,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
