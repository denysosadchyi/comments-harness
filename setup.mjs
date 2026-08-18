#!/usr/bin/env node
/* Встановлення harness у проєкт-господар.
   ────────────────────────────────────────────────────────────────────────
   Запуск: `node setup.mjs` із будь-якого місця (шляхи рахуються від файлу).

   Що робить:
     1. визначає корінь проєкту-господаря й пише `harness.config.json`;
     2. створює порожні стори в `data/` і теку `data/fixes/`;
     3. генерує юніти systemd із шаблонів і вмикає їх;
     4. реєструє MCP-міст у Claude Code;
     5. підв'язує рев'ю-сторінку до статичної теки проєкту симлінками;
     6. друкує рівно те, що лишилось зробити руками — а слідом адресу
        рев'ю-сторінки, таблицю можливостей і те, що конвеєр робить сам.

   Нуль npm-залежностей, як і решта теки: голий Node ≥ 20.11.

   Ідемпотентність — вимога, а не бонус: скрипт запускають повторно після
   `git pull`, і другий запуск не має ані затерти правлений конфіг, ані
   перевстановити юніт, який людина підправила під себе. Тому все, що вже є,
   лишається як є, а скрипт про це каже вголос.

   Прапорці:
     --project-root=<шлях>  корінь проєкту-господаря (дефолт: тека над harness)
     --prefix=<імʼя>        префікс імен юнітів і MCP (дефолт: назва теки проєкту)
     --notes-port=<N>       порт сервера нот (дефолт 4747)
     --ratings-port=<N>     порт сервера вердиктів (дефолт 4748)
     --no-systemd           не чіпати systemd узагалі, надрукувати команди
     --no-mcp               не реєструвати MCP-міст, надрукувати команду
     --no-symlinks          не чіпати статичну теку проєкту
     --force                перезаписати згенеровані раніше юніти й симлінки
*/
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { DEFAULTS, derivePrefix } from './config.mjs'

const HARNESS = resolve(import.meta.dirname)
const HOME = homedir()

/* ── Аргументи ─────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
function opt(name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const unknown = argv.filter(
  (a) =>
    !/^--(project-root|prefix|notes-port|ratings-port)=/.test(a) &&
    !['--no-systemd', '--no-mcp', '--no-symlinks', '--force', '--help', '-h'].includes(a),
)
if (unknown.length) {
  console.error(`Невідомі аргументи: ${unknown.join(' ')}. Список — у шапці setup.mjs.`)
  process.exit(2)
}
if (flag('help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].slice(3))
  process.exit(0)
}

/* ── Дрібний вивід ─────────────────────────────────────────────────────── */
const done = []
const skipped = []
const manual = []
const ok = (m) => {
  done.push(m)
  console.log(`  ✓ ${m}`)
}
const skip = (m) => {
  skipped.push(m)
  console.log(`  · ${m}`)
}

/* ── 1. Корінь проєкту й конфіг ────────────────────────────────────────── */
console.log('\n[1/6] Конфіг')

const projectRoot = resolve(opt('project-root', resolve(HARNESS, '..')))
if (!existsSync(projectRoot)) {
  console.error(`Корінь проєкту не існує: ${projectRoot}`)
  process.exit(1)
}
if (projectRoot === HARNESS) {
  console.error(
    'Корінь проєкту збігається з текою harness. Harness має лежати ВСЕРЕДИНІ ' +
      'проєкту-господаря; якщо це не так, назви шлях явно: --project-root=<шлях>.',
  )
  process.exit(1)
}

const CONFIG_FILE = join(HARNESS, 'harness.config.json')
/* Наявний конфіг — джерело істини для полів, яких немає в аргументах: другий
   запуск не має відкотити руками виправлену стелю виконавців до дефолту. */
let existing = {}
if (existsSync(CONFIG_FILE)) {
  try {
    existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch (err) {
    console.error(`${CONFIG_FILE} існує, але невалідний: ${err.message}`)
    console.error('Полагодь або прибери його й запусти setup ще раз.')
    process.exit(1)
  }
}

const intOpt = (name, current, fallback) => {
  const raw = opt(name, undefined)
  if (raw === undefined) return Number.isInteger(current) ? current : fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`--${name}=${raw} — очікувався порт 1..65535`)
    process.exit(2)
  }
  return n
}

const prefix = opt('prefix', existing.prefix || derivePrefix(projectRoot))
const cfg = {
  projectRoot,
  prefix,
  notesPort: intOpt('notes-port', existing.notesPort, DEFAULTS.notesPort),
  ratingsPort: intOpt('ratings-port', existing.ratingsPort, DEFAULTS.ratingsPort),
  host: existing.host || DEFAULTS.host,
  executor: { ...DEFAULTS.executor, ...(existing.executor || {}) },
  watchdog: { ...DEFAULTS.watchdog, ...(existing.watchdog || {}) },
}

const before = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null
const serialized = `${JSON.stringify(cfg, null, 2)}\n`
if (before === serialized) skip(`harness.config.json без змін`)
else {
  writeFileSync(CONFIG_FILE, serialized)
  ok(`${before === null ? 'створено' : 'оновлено'} harness.config.json`)
}
console.log(`    проєкт: ${projectRoot}`)
console.log(`    префікс: ${prefix} · порти ${cfg.notesPort} / ${cfg.ratingsPort}`)

/* ── 2. Дані ───────────────────────────────────────────────────────────── */
console.log('\n[2/6] Дані')

const DATA = join(HARNESS, 'data')
for (const dir of [DATA, join(DATA, 'fixes'), join(DATA, 'shots')]) {
  if (existsSync(dir)) skip(`${relative(HARNESS, dir)}/ уже є`)
  else {
    mkdirSync(dir, { recursive: true })
    ok(`створено ${relative(HARNESS, dir)}/`)
  }
}
/* Порожні стори створюємо заздалегідь, а не лишаємо серверам: сервер, що
   бачить відсутній файл, стартує з порожнім списком — і це правильно, але
   людині зручніше побачити файл одразу, ніж гадати, чи він десь є. Наявний
   стор не чіпаємо НІКОЛИ: там жива черга. */
for (const [file, seed] of [
  ['fixlog-notes.json', '[]\n'],
  ['fixlog-ratings.json', '{}\n'],
]) {
  const p = join(DATA, file)
  if (existsSync(p)) skip(`data/${file} уже є — не чіпаю`)
  else {
    writeFileSync(p, seed)
    ok(`створено data/${file}`)
  }
}

/* ── 3. Юніти systemd ──────────────────────────────────────────────────── */
console.log('\n[3/6] systemd --user')

const MARKER = '# ЗГЕНЕРОВАНО'
const UNIT_DIR = join(HOME, '.config', 'systemd', 'user')
const NODE = process.execPath
const unitPath = () =>
  [`${dirname(NODE)}`, `${HOME}/.local/bin`, `${HOME}/bin`, '/usr/local/bin', '/usr/bin', '/bin']
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(':')

const units = [
  { file: join(HARNESS, 'server', 'notes.service.template'), name: `${prefix}-notes` },
  { file: join(HARNESS, 'server', 'ratings.service.template'), name: `${prefix}-ratings` },
  { file: join(HARNESS, 'watchdog', 'watchdog.service.template'), name: `${prefix}-watchdog` },
]

function render(templateFile) {
  return readFileSync(templateFile, 'utf8')
    .replaceAll('{{PREFIX}}', prefix)
    .replaceAll('{{PROJECT_ROOT}}', projectRoot)
    .replaceAll('{{HARNESS_DIR}}', HARNESS)
    .replaceAll('{{NODE}}', NODE)
    .replaceAll('{{PATH}}', unitPath())
    .replaceAll('{{HOME}}', HOME)
    .replaceAll('{{NOTES_PORT}}', String(cfg.notesPort))
    .replaceAll('{{RATINGS_PORT}}', String(cfg.ratingsPort))
}

const hasSystemctl = spawnSync('systemctl', ['--user', '--version'], { stdio: 'ignore' }).status === 0

if (flag('no-systemd') || !hasSystemctl) {
  if (!flag('no-systemd')) skip('systemctl --user недоступний — юніти не ставлю')
  else skip('--no-systemd: юніти не ставлю')
  const out = join(HARNESS, 'generated-units')
  mkdirSync(out, { recursive: true })
  for (const u of units) writeFileSync(join(out, `${u.name}.service`), render(u.file))
  ok(`юніти згенеровано в ${relative(HARNESS, out)}/ — постав їх сам`)
  manual.push(
    `Юніти лежать у ${out}/. Постав їх так:\n` +
      `    cp ${out}/*.service ~/.config/systemd/user/\n` +
      `    systemctl --user daemon-reload\n` +
      `    systemctl --user enable --now ${units.map((u) => u.name).join(' ')}\n` +
      `    loginctl enable-linger $USER   # інакше помруть разом із логін-сесією\n` +
      `  Або без systemd, руками:\n` +
      `    node ${HARNESS}/server/notes-server.mjs &\n` +
      `    node ${HARNESS}/server/fixlog-server.mjs &\n` +
      `    node ${HARNESS}/watchdog/dispatcher.mjs &`,
  )
} else {
  mkdirSync(UNIT_DIR, { recursive: true })
  let changed = false
  const toEnable = []
  for (const u of units) {
    const target = join(UNIT_DIR, `${u.name}.service`)
    const body = render(u.file)
    if (existsSync(target) || isLink(target)) {
      const current = isLink(target) ? null : readFileSync(target, 'utf8')
      /* Чужий файл під тим самим іменем не чіпаємо ні за яких умов: це може
         бути юніт, який людина написала сама або поставила симлінком, і тихо
         затерти його гірше, ніж не поставити свій. */
      if (current === null || !current.includes(MARKER)) {
        if (!flag('force')) {
          skip(`${u.name}.service існує й не наш — лишаю (перезаписати: --force)`)
          continue
        }
      }
      if (current === body) {
        skip(`${u.name}.service без змін`)
        toEnable.push(u.name)
        continue
      }
      if (isLink(target)) unlinkSync(target)
    }
    writeFileSync(target, body)
    ok(`записано ${u.name}.service`)
    changed = true
    toEnable.push(u.name)
  }
  if (changed) run('systemctl', ['--user', 'daemon-reload'])
  if (toEnable.length) {
    const r = run('systemctl', ['--user', 'enable', '--now', ...toEnable])
    if (r.status === 0) ok(`enable --now: ${toEnable.join(', ')}`)
    else skip(`enable не вдався (код ${r.status}) — подивись systemctl --user status`)
  }
  const linger = spawnSync('loginctl', ['show-user', process.env.USER || '', '-p', 'Linger'], {
    encoding: 'utf8',
  })
  if (!/Linger=yes/.test(linger.stdout || '')) {
    manual.push(
      `Увімкни linger, інакше юніти помруть разом із логін-сесією:\n` +
        `    loginctl enable-linger $USER`,
    )
  }
}

/* ── 4. MCP-міст ───────────────────────────────────────────────────────── */
console.log('\n[4/6] MCP-міст')

const mcpName = `${prefix}-notes`
const mcpEntry = join(HARNESS, 'mcp', 'notes-mcp.mjs')
const addCmd = `claude mcp add ${mcpName} -- node ${mcpEntry}`

if (flag('no-mcp')) {
  skip('--no-mcp: міст не реєструю')
  manual.push(`Зареєструй MCP-міст:\n    ${addCmd}`)
} else {
  const has = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8' })
  if (has.error) {
    skip('`claude` не знайдено в PATH')
    manual.push(`Зареєструй MCP-міст (шлях мусить бути абсолютним):\n    ${addCmd}`)
  } else if ((has.stdout || '').split('\n').some((l) => l.startsWith(`${mcpName}:`))) {
    skip(`MCP «${mcpName}» уже зареєстрований`)
  } else {
    const r = run('claude', ['mcp', 'add', mcpName, '--', 'node', mcpEntry])
    if (r.status === 0) ok(`зареєстровано MCP «${mcpName}»`)
    else manual.push(`Реєстрація MCP не вдалась, зроби руками:\n    ${addCmd}`)
  }
}

/* ── 5. Рев'ю-сторінка у статиці ───────────────────────────────────────── */
console.log('\n[5/6] Рев\'ю-сторінка')

/* Сторінка мусить віддаватись із того ж origin, що й дев-сервер, інакше
   індекс історії довелось би тягнути крос-доменно. Найдешевший спосіб —
   симлінк зі статичної теки: сам файл лишається в harness, у білд тека
   harness не їде. Статичну теку вгадуємо за звичними іменами; не вгадали —
   кажемо людині, а не робимо нічого мовчки. */
const STATIC_CANDIDATES = ['public', 'static', 'assets', 'www']
const staticDir = STATIC_CANDIDATES.map((d) => join(projectRoot, d)).find((d) => existsSync(d))

const links = [
  ['fixlog.html', join(HARNESS, 'review', 'fixlog.html')],
  /* Той самий модуль, що вбудовується в оверлей, тільки сторінка вантажить
     його вже зібраним браузером — тож він мусить віддаватись зі статики
     поруч із нею. Без цього симлінка сторінка не знає жодного порту й
     чесно про це каже. */
  ['harness-endpoints.js', join(HARNESS, 'client', 'endpoints.js')],
  ['fixlog.md', join(DATA, 'fixlog.md')],
  ['fixlog-ratings.json', join(DATA, 'fixlog-ratings.json')],
]

if (flag('no-symlinks')) {
  skip('--no-symlinks: статичну теку не чіпаю')
} else if (!staticDir) {
  skip(`статичної теки не видно (шукав ${STATIC_CANDIDATES.join(', ')})`)
  manual.push(
    `Віддай рев'ю-сторінку зі статики свого дев-сервера. Найпростіше — симлінки:\n` +
      links.map(([name, src]) => `    ln -s ${src} <статика>/${name}`).join('\n'),
  )
} else {
  for (const [name, src] of links) {
    const dst = join(staticDir, name)
    if (isLink(dst)) {
      if (readlinkSync(dst) === src || resolve(staticDir, readlinkSync(dst)) === src) {
        skip(`${relative(projectRoot, dst)} уже вказує куди треба`)
        continue
      }
      if (!flag('force')) {
        skip(`${relative(projectRoot, dst)} — чужий симлінк, лишаю (--force перепише)`)
        continue
      }
      unlinkSync(dst)
    } else if (existsSync(dst)) {
      skip(`${relative(projectRoot, dst)} — існує файл, не чіпаю`)
      continue
    }
    symlinkSync(src, dst)
    ok(`симлінк ${relative(projectRoot, dst)}`)
  }

  /* Підказка про НЕстандартні порти. Браузерні клієнти знають рівно один
     порт наперед — дефолтний (`client/endpoints.js`), бо сторінку віддає
     дев-сервер проєкту, який про harness не знає нічого. Якщо порти в конфізі
     інші, єдиний спосіб сказати це браузеру без правки файлів руками — файл
     із того ж origin, що й сама сторінка.

     Пишеться РІВНО за потреби: інсталяція на дефолтах не має лишати в проєкті
     файлів, які потім комусь треба гітігнорити. Порти назад на дефолтні —
     файл прибирається, інакше він пережив би зміну й брехав би клієнтам. */
  const portsFile = join(staticDir, 'harness-ports.json')
  const custom =
    cfg.notesPort !== DEFAULTS.notesPort || cfg.ratingsPort !== DEFAULTS.ratingsPort
  if (custom) {
    const body = `${JSON.stringify(
      { notesPort: cfg.notesPort, ratingsPort: cfg.ratingsPort },
      null,
      2,
    )}\n`
    const prev = existsSync(portsFile) ? readFileSync(portsFile, 'utf8') : null
    if (prev === body) skip(`${relative(projectRoot, portsFile)} без змін`)
    else {
      writeFileSync(portsFile, body)
      ok(`${relative(projectRoot, portsFile)} — порти для браузерних клієнтів`)
    }
  } else if (existsSync(portsFile) && !isLink(portsFile)) {
    unlinkSync(portsFile)
    ok(`прибрано ${relative(projectRoot, portsFile)} — порти дефолтні`)
  }
}

/* ── 6. Що лишилось руками ─────────────────────────────────────────────── */
/* Ширина всього фінального блока — одна на рамку й на лінійки: у вузькому
   терміналі 63 дефіси лінійки переносились би, а рамка ні, і блок розповзався
   б двома різними сітками. */
const WIDTH = Math.max(58, Math.min(78, (Number(process.env.COLUMNS) || process.stdout.columns || 80) - 1))
const RULE = '─'.repeat(WIDTH)

console.log('\n[6/6] Готово\n')
console.log(`Зроблено: ${done.length} · пропущено: ${skipped.length}\n`)

console.log(RULE)
console.log('ЩО ТРЕБА ЗРОБИТИ РУКАМИ — без цього тулза не працює\n')

console.log('1. ПРИМОНТУВАТИ ОВЕРЛЕЙ у дев-збірці. Це єдине, чого скрипт')
console.log('   зробити не може: точка входу мусить лежати всередині твого')
console.log('   `src/`, а як саме вона туди потрапляє — залежить від збирача.')
console.log('')
console.log('   Vite + React. Створи `src/dev/annotator.local.tsx` з одним рядком:')
console.log('')
console.log(`       export { default } from '${relative(join(projectRoot, 'src', 'dev'), join(HARNESS, 'overlay', 'annotator'))}'`)
console.log('')
console.log('   і підбери його лінивим глобом у корені застосунку (App.tsx):')
console.log('')
console.log("       const DEV_OVERLAYS = import.meta.env.DEV")
console.log("         ? Object.values(")
console.log("             import.meta.glob<{ default: ComponentType }>('./dev/*.local.tsx'),")
console.log('           ).map((load) => lazy(load))')
console.log('         : []')
console.log('')
console.log('       // ...нижче за роути:')
console.log('       {DEV_OVERLAYS.map((Overlay, i) => (')
console.log('         <Suspense key={i} fallback={null}>')
console.log('           <Overlay />')
console.log('         </Suspense>')
console.log('       ))}')
console.log('')
console.log('   Глоб МУСИТЬ бути лінивий: жадібний емітить безумовний імпорт,')
console.log('   і оверлей (він інжектить <style>) не витрушується тришейкером')
console.log('   — тобто їде в прод. Деталі й пастки: docs/porting.md.')
console.log('')

console.log("2. ФАЄРВОЛ, якщо дев-сервер слухає 0.0.0.0 і рев'ю відкривають з")
console.log(`   іншої машини: відкрий ${cfg.notesPort} і ${cfg.ratingsPort} рівно на свою LAN-підмережу.`)

/* Раніше тут стояв четвертий пункт — «порти зашиті в двох браузерних файлах,
   поміняв у конфізі, поміняй і там». Його більше немає: оверлей і сторінка
   беруть порти з `GET /config` сервера нот, а нестандартний порт нот — із
   `harness-ports.json`, який цей скрипт щойно поклав у статику. Лишається
   рівно одне, про що варто сказати: файл оновлює setup, а не сервер. */
if (cfg.notesPort !== DEFAULTS.notesPort || cfg.ratingsPort !== DEFAULTS.ratingsPort) {
  console.log('')
  console.log(`Порти нестандартні (${cfg.notesPort} / ${cfg.ratingsPort}), і в браузерних`)
  console.log("клієнтах правити нічого не треба: оверлей і рев'ю-сторінка беруть їх")
  console.log('самі. Але міняти порти пізніше — тільки через цей скрипт (або запусти')
  console.log('його ще раз після правки harness.config.json), бо статичний')
  console.log('harness-ports.json оновлює саме він.')
}

if (manual.length) {
  console.log(`\n${RULE}`)
  console.log('ЩЕ, бо скрипт цього не зміг:\n')
  for (const m of manual) console.log(`  ${m}\n`)
}

/* ── Куди йти ──────────────────────────────────────────────────────────────
   Найголовніший рядок усього виводу: сторінка, на якій видно чергу, роботу
   й архів. Досі її адреса була пунктом у списку «зроби руками», тобто
   читалась як ще одна повинність, а не як «ось твоя тулза». */
const dev = detectDevServer()

console.log(`\n${RULE}`)
console.log("РЕВ'Ю-СТОРІНКА — черга, робота і весь архів правок\n")
if (flag('no-symlinks')) {
  console.log('  Запущено з --no-symlinks: сторінку в статику клади сам,')
  console.log('  інакше за цією адресою буде 404.')
  console.log('')
} else if (!staticDir) {
  console.log('  Спершу симлінки в статику (команди вище) — без них 404.')
  console.log('')
}
if (dev) {
  console.log(`      http://localhost:${dev.port}/fixlog.html`)
  console.log('')
  console.log(`  Порт узято з ${dev.source}.`)
  console.log('  Дев-сервер на іншому хості — міняй хост, шлях той самий.')
} else {
  console.log('      http://<your-dev-server>/fixlog.html')
  console.log('')
  console.log('  Порт дев-сервера визначити не вдалось: його не називають')
  console.log('  ані конфіг збирача, ані скрипти package.json. Візьми порт')
  console.log('  з рядка, який дев-сервер друкує на старті (`npm run dev`),')
  console.log('  і підстав замість <your-dev-server> — напр. localhost:5173.')
}

/* ── Що ти тепер умієш ─────────────────────────────────────────────────────
   Рамка з псевдографіки, а не колір: цей вивід читають і в світлому терміналі,
   і в лозі systemd, де ANSI-кодів немає взагалі. Ширина рахується по кодових
   точках (`[...s].length`), бо кирилиця в UTF-8 займає по два байти, і
   `s.length` у байтах поїхав би колонками. */
const CAPS = [
  ['section', 'Оверлей — у самому застосунку, тільки dev-збірка'],
  ['row', 'Приціл на елемент: клік → нота', 'Alt+A або кнопка'],
  ['row', 'Нота на проміжок між блоками — оверлей сам каже, чим зроблена порожнеча: gap, margin чи padding', 'приціл на порожнє місце'],
  ['row', 'Кадр блока знімається в мить кліку і їде агенту разом із нотою; не вдався — нота піде без нього', 'само, при кліку'],
  ['row', 'Відправити ноту', 'Ctrl/⌘ + Enter'],
  ['row', 'Ноти цього екрана списком, з лічильниками «зроблено» і «агент питає»', 'Alt+N'],
  ['row', 'Тред: агент перепитує, ти відповідаєш прямо в поповері', 'клік по маркеру'],
  ['row', 'Видалити ноту (другий клік підтверджує)', 'Delete у поповері'],
  ['row', 'Згорнути приціл, чернетку, поповер', 'Esc'],
  ['row', 'Світла / темна тема', 'кнопка ☀ / ☾'],
  ['section', "Рев'ю-сторінка — /fixlog.html"],
  ['row', 'Уся робота одним списком, зі станами: New · Needs you · In progress · Sent back · Done', 'сама, кожні 10 с'],
  ['row', 'Групування: усе підряд або панель на кожен роут', 'All / By page'],
  ['row', 'Сортування за будь-якою колонкою', 'клік по заголовку'],
  ['row', 'Анотований екран у шухляді поверх лога', 'клік по рядку, далі ← / →'],
  ['row', 'Деталі правки: що агент зробив, тред, доробки', 'кнопка i у рядку'],
  ['row', 'Send back: повернути правку з поясненням; ітерації висять під рядком гілкою', 'кнопка ↺ у рядку'],
  ['row', 'Ноту, якої ще ніхто не взяв, можна закрити руками', 'Resolve / Delete у рядку'],
]

console.log('')
printBox('ЩО ТИ ТЕПЕР УМІЄШ', CAPS)

/* ── Що робиться саме ─────────────────────────────────────────────────────
   Другий блок навмисне без рамки: це не довідник, до якого повертаються, а
   один раз прочитане пояснення — і рядок про дозволи в ньому головний. */
const skipsPerms = (cfg.executor.args || []).includes('--dangerously-skip-permissions')
console.log('')
console.log('А це відбувається саме́, без тебе:')
console.log('')
console.log(`  ·  Сторож висить на довгому опитуванні сервера нот (${cfg.watchdog.watchTimeoutS} с) —`)
console.log('     нова нота підхоплюється за секунди, а не за наступний тік.')
console.log(`  ·  Він бере її в роботу й запускає виконавця (${cfg.executor.label}); одночасних`)
console.log(`     прогонів — до ${cfg.watchdog.maxWorkers}, стеля одного ${cfg.watchdog.runTimeoutMin} хв.`)
console.log('  ·  Після правки ноту закриває сам: тека data/fixes/<id>/ (запит із')
console.log('     тредом, кадр, лог прогону), індекс data/fixlog.md перезбирається,')
console.log('     нота зникає з екрана. Людського «підтвердити» в цьому ланцюгу немає.')
console.log("  ·  Не влаштувало — Send back на рев'ю-сторінці відкриває ітерацію")
console.log(`     доробки, і сторож пробує ще раз (до ${cfg.watchdog.reworkAttempts} спроб на ітерацію).`)
if (skipsPerms) {
  console.log('  ·  Виконавець працює БЕЗ запиту дозволів (--dangerously-skip-permissions):')
  console.log('     зміни зʼявляються у робочому дереві без твого підтвердження. Він')
  console.log('     нічого не комітить — але пише. Тримай це на чекауті, який не шкода')
  console.log('     переглянути через `git diff`.')
}

console.log(`\n${RULE}`)
console.log('Перевірка, що все живе:')
console.log(`    curl -s localhost:${cfg.notesPort}/health`)
console.log(`    curl -s localhost:${cfg.ratingsPort}/health`)
console.log('')

/* ── Хелпери ───────────────────────────────────────────────────────────── */
function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.status !== 0 && r.stderr) console.log(`    ${r.stderr.trim().split('\n')[0]}`)
  return r
}

/* ── Порт дев-сервера ──────────────────────────────────────────────────────
   Harness його не знає й знати не може: він живе збоку від збирача. Але
   адреса рев'ю-сторінки без порту — не адреса, а ребус, тож дивимось у
   проєкт. Порядок джерел — від найточнішого до найслабшого, і кожне себе
   називає: здогадка, видана за факт, гірша за чесне «не знаю», бо людина
   піде відкривати неіснуючий URL і вирішить, що зламана тулза.

   Повертає `{ port, source }` або null. */
function detectDevServer() {
  const readIf = (p) => {
    try {
      return existsSync(p) ? readFileSync(p, 'utf8') : null
    } catch {
      return null
    }
  }
  const port = (n) => (Number.isInteger(n) && n > 0 && n < 65536 ? n : null)

  /* 1. Явний порт у скриптах — найсильніше джерело: він переважує і конфіг. */
  const pkgRaw = readIf(join(projectRoot, 'package.json'))
  let pkg = null
  if (pkgRaw) {
    try {
      pkg = JSON.parse(pkgRaw)
    } catch {
      /* чужий package.json — не наша біда, просто джерела нема */
    }
  }
  const scripts = (pkg && pkg.scripts) || {}
  for (const name of ['dev', 'start', 'serve', 'dev:host', 'develop']) {
    const cmd = typeof scripts[name] === 'string' ? scripts[name] : ''
    const hit = cmd.match(/(?:--port[= ]|-p\s+)(\d{2,5})/)
    const p = hit && port(Number(hit[1]))
    if (p) return { port: p, source: `package.json → scripts.${name}` }
  }
  const allScripts = Object.values(scripts)
    .filter((v) => typeof v === 'string')
    .join(' ')

  /* 2. Конфіг збирача. Регекс, а не імпорт: конфіг буває на TS, з плагінами й
        побічними ефектами, і виконувати його заради одного числа — надто. */
  const viteCfg = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs']
    .map((f) => ({ f, body: readIf(join(projectRoot, f)) }))
    .find((c) => c.body !== null)
  if (viteCfg) {
    const hit = viteCfg.body.match(/server\s*:\s*\{[\s\S]{0,600}?\bport\s*:\s*(\d{2,5})/)
    const p = hit && port(Number(hit[1]))
    if (p) return { port: p, source: `${viteCfg.f} → server.port` }
  }
  const nextCfg = ['next.config.js', 'next.config.mjs', 'next.config.ts']
    .map((f) => ({ f, body: readIf(join(projectRoot, f)) }))
    .find((c) => c.body !== null)

  /* 3. Звичні дефолти — але тільки коли видно, ЧИЙ це дефолт. */
  if (nextCfg || /\bnext\s+dev\b/.test(allScripts)) {
    return { port: 3000, source: 'дефолту Next (порт у скриптах не названий)' }
  }
  if (viteCfg || /\bvite\b/.test(allScripts)) {
    return { port: 5173, source: 'дефолту Vite (порт у скриптах не названий)' }
  }
  return null
}

/* ── Рамка ─────────────────────────────────────────────────────────────────
   Псевдографіка й вирівнювання, нуль кольору: вивід читають у світлому
   терміналі, через ssh і в лозі systemd, де ANSI немає взагалі. Ширина
   підлаштовується під термінал, але не нижче мінімуму — вужче за 58 колонок
   таблиця перестає бути таблицею, і краще хай рядок перенесеться сам. */
function printBox(title, rows) {
  const len = (s) => [...s].length
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - len(s)))
  const total = WIDTH

  /* Права колонка — рівно під найдовший хоткей, але не більш як 40% ширини:
     сенс у лівій, а хоткей це підпис до неї. */
  const rightMax = rows.filter((r) => r[0] === 'row').reduce((m, r) => Math.max(m, len(r[2])), 0)
  const R = Math.max(10, Math.min(rightMax, Math.floor((total - 7) * 0.4)))
  const L = total - 7 - R

  const wrap = (text, w) => {
    const out = []
    let line = ''
    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (!line) line = word
      else if (len(line) + 1 + len(word) <= w) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
      /* Слово, довше за колонку (шлях, селектор), ріжеться — інакше воно саме
         зламало б рамку, яку ми тут тримаємо. */
      while (len(line) > w) {
        out.push([...line].slice(0, w).join(''))
        line = [...line].slice(w).join('')
      }
    }
    if (line) out.push(line)
    return out.length ? out : ['']
  }

  const bar = (l, m, r) => `${l}${'─'.repeat(L + 2)}${m}${'─'.repeat(R + 2)}${r}`
  const full = (l, r) => `${l}${'─'.repeat(total - 2)}${r}`
  const wide = (s) => `│ ${pad(s, total - 4)} │`

  const out = [full('┌', '┐'), wide(title)]
  let split = false
  for (const row of rows) {
    if (row[0] === 'section') {
      out.push(split ? bar('├', '┴', '┤') : full('├', '┤'))
      for (const line of wrap(row[1], total - 4)) out.push(wide(line))
      split = false
      continue
    }
    if (!split) {
      out.push(bar('├', '┬', '┤'))
      split = true
    }
    const left = wrap(row[1], L)
    const right = wrap(row[2], R)
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      out.push(`│ ${pad(left[i] || '', L)} │ ${pad(right[i] || '', R)} │`)
    }
  }
  out.push(split ? bar('└', '┴', '┘') : full('└', '┘'))
  for (const line of out) console.log(line)
}
