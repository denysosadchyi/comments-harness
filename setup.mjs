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
     6. друкує рівно те, що лишилось зробити руками.

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
}

/* ── 6. Що лишилось руками ─────────────────────────────────────────────── */
console.log('\n[6/6] Готово\n')
console.log(`Зроблено: ${done.length} · пропущено: ${skipped.length}\n`)

console.log('───────────────────────────────────────────────────────────────')
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

const devPort = 5173
console.log("2. ВІДКРИТИ РЕВ'Ю-СТОРІНКУ. Вона віддається зі статики твого")
console.log('   дев-сервера, тобто з того ж origin, що й застосунок:')
console.log('')
if (staticDir && !flag('no-symlinks')) {
  console.log(`       http://<хост>:<порт дев-сервера>/fixlog.html`)
  console.log(`       наприклад http://localhost:${devPort}/fixlog.html`)
} else {
  console.log(`       спершу зроби симлінки (див. нижче), потім`)
  console.log(`       http://<хост>:<порт дев-сервера>/fixlog.html`)
}
console.log('')
console.log('3. ПОРТИ В ОВЕРЛЕЇ. Оверлей і рев\'ю-сторінка виконуються в браузері')
console.log(`   й конфіг прочитати не можуть — порти ${cfg.notesPort}/${cfg.ratingsPort} зашиті в`)
console.log('   `overlay/annotator.tsx` і `review/fixlog.html`. Якщо ти міняв')
console.log('   порти в harness.config.json — поміняй і там.')
if (cfg.notesPort !== DEFAULTS.notesPort || cfg.ratingsPort !== DEFAULTS.ratingsPort) {
  console.log('   ↑ ТИ ЇХ ЗМІНИВ. Це зараз твій наступний крок.')
}
console.log('')
console.log('4. ФАЄРВОЛ, якщо дев-сервер слухає 0.0.0.0 і рев\'ю відкривають з')
console.log(`   іншої машини: відкрий ${cfg.notesPort} і ${cfg.ratingsPort} рівно на свою LAN-підмережу.`)

if (manual.length) {
  console.log('\n───────────────────────────────────────────────────────────────')
  console.log('ЩЕ, бо скрипт цього не зміг:\n')
  for (const m of manual) console.log(`  ${m}\n`)
}

console.log('───────────────────────────────────────────────────────────────')
console.log('Перевірка:')
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
