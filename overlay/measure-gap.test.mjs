/* Перевірка `measureGap` без браузера.

   Браузерна автоматизація тут заборонена, а поведінку вимірювання проміжку
   треба чимось підтверджувати, крім читання коду. Вихід: підсунути функції
   синтетичний DOM — рівно те, чим вона користується (`getBoundingClientRect`,
   `childNodes`, `getComputedStyle`, `document.createRange`). Це два десятки
   рядків заглушок; jsdom сюди не тягнемо, бо це залежність заради того, що
   вміщається в один файл.

   TS у JS перетворює компілятор `typescript` — він у проєкті вже є (esbuild
   у node_modules немає: Vite 8 їде на rolldown/oxc). Копії функції в тесті
   немає навмисно: копія перевіряла б саму себе.

   Запуск:  node comments-harness/overlay/measure-gap.test.mjs
*/

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))

/* ── Фейковий DOM ────────────────────────────────────────────────────────── */

const DEFAULTS = {
  display: 'block',
  position: 'static',
  rowGap: '0px',
  columnGap: '0px',
  marginTop: '0px',
  marginBottom: '0px',
  marginLeft: '0px',
  marginRight: '0px',
  paddingTop: '0px',
  paddingBottom: '0px',
  paddingLeft: '0px',
  paddingRight: '0px',
  borderTopWidth: '0px',
  borderBottomWidth: '0px',
  borderLeftWidth: '0px',
  borderRightWidth: '0px',
}

/* Прямокутник задається як [left, top, right, bottom] — так його зручніше
   читати в сценаріях, ніж у форматі x/y/w/h. */
function el(name, [left, top, right, bottom], style = {}, children = []) {
  const node = {
    nodeType: 1,
    __sel: name,
    __style: { ...DEFAULTS, ...style },
    childNodes: children,
    getBoundingClientRect: () => ({ left, top, right, bottom, width: right - left, height: bottom - top }),
  }
  return node
}

/* Текстовий вузол: власного бокса не має, місце описують рядки (client rects). */
function text(content, rects) {
  return {
    nodeType: 3,
    textContent: content,
    __rects: rects.map(([left, top, right, bottom]) => ({
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    })),
  }
}

globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 }
globalThis.getComputedStyle = (node) => node.__style
globalThis.document = {
  createRange: () => {
    let target = null
    return {
      selectNodeContents(node) {
        target = node
      },
      getClientRects: () => target.__rects,
    }
  },
}

const selector = (node) => node.__sel ?? null

/* ── Завантаження модуля, що перевіряється ───────────────────────────────── */

const src = await readFile(join(here, 'measure-gap.ts'), 'utf8')
const { outputText: code } = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
})
const { measureGap } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

/* ── Сценарії ────────────────────────────────────────────────────────────── */

/* Звести результат до того, що справді перевіряється: px, вісь, сусіди й
   джерела. Прямокутники підсвітки — окрема справа, тут вони лише шум. */
const shape = (g) =>
  g === null
    ? null
    : {
        px: g.spacing.px,
        axis: g.spacing.axis,
        between: g.spacing.between,
        sources: g.spacing.sources.map((s) => `${s.kind}:${s.property}=${s.value}@${s.selector}`),
      }

const scenarios = []
const scenario = (name, build, point, expected, sel = selector) =>
  scenarios.push({ name, build, point, expected, sel })

/* 1. Flex із gap: курсор посередині щілини. */
scenario(
  'flex gap 24px, курсор у щілині',
  () => {
    const a = el('.a', [0, 0, 100, 100])
    const b = el('.b', [124, 0, 224, 100])
    return el('.row', [0, 0, 400, 100], { display: 'flex', columnGap: '24px', rowGap: '24px' }, [a, b])
  },
  [112, 50],
  { px: 24, axis: 'inline', between: ['.a', '.b'], sources: ['gap:column-gap=24px@.row'] },
)

/* 2. Стос блоків: margin-bottom 16 + margin-top 24 схлопуються в 24, не 40. */
scenario(
  'блоки зі схлопуванням margin (16 + 24 → 24)',
  () => {
    const a = el('.top', [0, 0, 400, 50], { marginBottom: '16px' })
    const b = el('.bottom', [0, 74, 400, 124], { marginTop: '24px' })
    return el('.stack', [0, 0, 400, 200], {}, [a, b])
  },
  [200, 60],
  {
    px: 24,
    axis: 'block',
    between: ['.top', '.bottom'],
    sources: ['margin:margin-top=24px@.bottom', 'margin:margin-bottom=16px@.top'],
  },
)

/* 3. Кромка: padding контейнера, сусіда з одного боку немає — і жодного gap,
   хоча контейнер flex і числа збігаються. */
scenario(
  'кромка з padding-top, gap не має зʼявитись',
  () => {
    const child = el('.card', [0, 32, 400, 100])
    return el(
      '.pad',
      [0, 0, 400, 200],
      { display: 'flex', paddingTop: '32px', rowGap: '32px', columnGap: '32px' },
      [child],
    )
  },
  [200, 16],
  { px: 32, axis: 'block', between: [null, '.card'], sources: ['padding:padding-top=32px@.pad'] },
)

/* 4. Не проміжок. */
scenario(
  'курсор над дитям',
  () => {
    const a = el('.a', [0, 0, 400, 50])
    const b = el('.b', [0, 74, 400, 124])
    return el('.stack', [0, 0, 400, 200], {}, [a, b])
  },
  [200, 25],
  null,
)

scenario(
  'курсор над рядком тексту',
  () => el('.para', [0, 0, 400, 200], {}, [text('раз два три', [[0, 0, 300, 20], [0, 20, 180, 40]])]),
  [90, 10],
  null,
)

/* Той самий абзац, але праворуч від короткого другого рядка. Порожнеча тут
   справді є (порядкові прямокутники її й знаходять), проте жодна вісь не має
   двох сусідів: горизонталь бачить лише рядок ліворуч (220px до кромки),
   вертикаль — лише перший рядок згори (180px до низу контейнера). Рівність
   ваг вмикає документований тай-брейк «виграє менший вимір» → block/180.
   Це визнана неточність осі, а не помилка: сценарій зафіксовано таким, яким
   він є, щоб зміна правила не проїхала непоміченою. */
scenario(
  'порожнеча біля короткого рядка — рівність ваг, виграє менший вимір',
  () => el('.para', [0, 0, 400, 200], {}, [text('раз два три', [[0, 0, 300, 20], [0, 20, 180, 40]])]),
  [300, 30],
  { px: 180, axis: 'block', between: [null, null], sources: [] },
)

/* Режим наведення: селекторів не будуємо, все інше має лишитись тим самим. */
scenario(
  'без селектора (наведення): сусіди безіменні, джерело без носія',
  () => {
    const a = el('.a', [0, 0, 100, 100])
    const b = el('.b', [124, 0, 224, 100])
    return el('.row', [0, 0, 400, 100], { display: 'flex', columnGap: '24px' }, [a, b])
  },
  [112, 50],
  { px: 24, axis: 'inline', between: [null, null], sources: ['gap:column-gap=24px@null'] },
  null,
)

/* 5. Absolute не займає місця: накриває всю щілину, але вимір має пройти. */
scenario(
  'абсолютне дитя не рахується зайнятим місцем',
  () => {
    const a = el('.a', [0, 0, 400, 50])
    const over = el('.overlay', [0, 0, 400, 200], { position: 'absolute' })
    const b = el('.b', [0, 74, 400, 124])
    return el('.stack', [0, 0, 400, 200], {}, [a, over, b])
  },
  [200, 60],
  { px: 24, axis: 'block', between: ['.a', '.b'], sources: [] },
)

/* 6. Виродження. */
scenario('контейнер без дітей', () => el('.empty', [0, 0, 400, 200], { paddingTop: '20px' }, []), [200, 100], null)

scenario(
  'курсор у смузі border',
  () => {
    const child = el('.card', [0, 40, 400, 100])
    return el('.boxed', [0, 0, 400, 200], { borderTopWidth: '8px', paddingTop: '32px' }, [child])
  },
  [200, 4],
  null,
)

scenario(
  'субпіксельна щілина 0.4px',
  () => {
    const a = el('.a', [0, 0, 400, 50])
    const b = el('.b', [0, 50.4, 400, 120])
    return el('.stack', [0, 0, 400, 200], {}, [a, b])
  },
  [200, 50.2],
  null,
)

/* ── Прогін ──────────────────────────────────────────────────────────────── */

const j = (v) => JSON.stringify(v)
let failed = 0
const rows = []

for (const { name, build, point, expected, sel } of scenarios) {
  const got = shape(measureGap(build(), point[0], point[1], sel))
  const ok = j(got) === j(expected)
  if (!ok) failed++
  rows.push({ name, expected, got, ok })
}

for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  if (!r.ok) {
    console.log(`      очікувалось: ${j(r.expected)}`)
    console.log(`      віддала:     ${j(r.got)}`)
  }
}
console.log(`\n${rows.length - failed}/${rows.length} сценаріїв зійшлися`)
process.exit(failed ? 1 : 0)
