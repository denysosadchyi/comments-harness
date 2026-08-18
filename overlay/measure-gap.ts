/* Вимірювання проміжку — окремим модулем, а не всередині оверлея.

   Причина суто практична: це єдина частина оверлея, яку можна перевірити без
   браузера. Їй потрібні рівно `getBoundingClientRect`, `getComputedStyle` і
   список дітей — усе це підробляється двома десятками рядків заглушок, тож
   поруч лежить `measure-gap.test.mjs`, який ганяє її на синтетичному DOM.
   Поки функція сиділа у файлі з React, порталами й мережею, ніякого способу
   торкнутись її з ноди не було, і її поведінку підтверджували читанням коду.

   Селектори сюди не вбудовані: `buildSelector` — частина оверлея й ходить у
   `document.querySelectorAll`. Замість прапорця `deep` функція бере готову
   функцію-селектор (або `null`, коли селектори не потрібні — під час наведення
   вона працює на кожному русі миші). Так модуль лишається залежним лише від
   геометрії, а тест не мусить підробляти ще й пошук по документу. */

/* ══════════════════════════════════════════════════════════════════════════
   Проміжок як предмет ноти.

   Половина зауважень про верстку — не про елемент, а про порожнечу біля
   нього: «зменшити відступ тут». Досі нота показувала виконавцю елемент, і
   той мусив гадати, що саме створює порожнечу: `margin` сусіда, `padding`
   батька чи `gap` контейнера. Гадання дороге — трьома різними правками можна
   дістати однаковий вигляд на цьому екрані й три різні наслідки на сусідніх.

   Окремого режиму-перемикача немає навмисно. Проміжок — це коли курсор над
   предком, але не над жодним його дитям, а `elementFromPoint` у такому разі
   й так повертає предка. Тобто ситуація впізнається сама, і користувачу не
   треба памʼятати, у якому він режимі; він просто наводить на порожнечу і
   бачить, що під прицілом порожнеча.

   Оверлей НЕ вибирає одне «правильне» джерело. Він перелічує всі знайдені,
   від найімовірнішого, і рішення лишає виконавцю, який дивиться на код:
   `gap: 24px` на контейнері й `margin-bottom: 24px` на картці дають однакову
   картинку тут і різну на сусідньому екрані.
   ══════════════════════════════════════════════════════════════════════════ */

export type Rect = { x: number; y: number; w: number; h: number }

/* Побудова селектора живе в оверлеї (`buildSelector`), бо ходить по всьому
   документу. Сюди вона приходить готовою функцією; `null` = селектори не
   потрібні. */
export type SelectorFn = (el: Element) => string | null

export type SpacingAxis = 'block' | 'inline'
export type SpacingSource = {
  kind: 'gap' | 'margin' | 'padding'
  /* Селектор носія декларації — контейнера для gap/padding, сусіда для margin.
     `null`, коли унікального селектора не вийшло, як і всюди в цій ноті. */
  selector: string | null
  property: string
  value: string
}
export type Spacing = {
  px: number
  axis: SpacingAxis
  /* Сусіди, між якими лежить порожнеча. На кромці контейнера один із них
     `null` — там сусіда просто немає, і це саме та ознака, за якою до джерел
     додається `padding`. */
  between: [string | null, string | null]
  sources: SpacingSource[]
}

/* Прямокутник, зайнятий чимось непорожнім. `el` = null для рядка тексту:
   текстовий вузол теж заповнює місце, і порожнечею його вважати не можна,
   але власного селектора в нього немає й margin він не має. */
type Box = { el: Element | null; left: number; top: number; right: number; bottom: number }

/* Абсолют і fixed виймаються з потоку: вони не розсувають сусідів і не
   створюють того проміжку, про який питає користувач. Якщо курсор стоїть
   над таким елементом — це вже не порожнеча, і перевірка перекриття нижче
   його ловить окремо. */
const OUT_OF_FLOW = new Set(['absolute', 'fixed'])

const pxOf = (v: string) => parseFloat(v) || 0

function occupied(container: Element): Box[] {
  const out: Box[] = []
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || OUT_OF_FLOW.has(cs.position)) continue
      const r = el.getBoundingClientRect()
      if (r.width <= 0 && r.height <= 0) continue
      out.push({ el, left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    } else if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim()) {
      /* Рядок за рядком, а не одним прямокутником: у тексті з переносом
         прямокутник на весь абзац накрив би й порожнечу праворуч від
         короткого останнього рядка. */
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const r of Array.from(range.getClientRects())) {
        if (r.width <= 0 && r.height <= 0) continue
        out.push({ el: null, left: r.left, top: r.top, right: r.right, bottom: r.bottom })
      }
    }
  }
  return out
}

/* Внутрішня кромка контейнера — по padding-box, не по border-box: бордюр це
   не відступ, і мірятись від нього означало б додати до порожнечі товщину
   рамки. */
function paddingBox(el: Element) {
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    left: r.left + pxOf(cs.borderLeftWidth),
    top: r.top + pxOf(cs.borderTopWidth),
    right: r.right - pxOf(cs.borderRightWidth),
    bottom: r.bottom - pxOf(cs.borderBottomWidth),
  }
}

type Scan = {
  before: Box | null
  after: Box | null
  /* Уздовж виміряної осі: де порожнеча починається і де закінчується. */
  start: number
  end: number
  /* Упоперек: наскільки широка смуга, яку варто підсвітити. */
  from: number
  to: number
}

/* Одновимірний прохід: беремо лише ті зайняті прямокутники, що стоять у тій
   самій смузі, що й курсор (перекриваються з ним по перпендикулярній осі), і
   шукаємо найближчий перед точкою й найближчий після. Немає сусіда з якогось
   боку — межею стає кромка контейнера, і саме це потім робить `padding`
   джерелом.

   Чому смуга, а не всі діти підряд: у флексовому рядку між двома колонками
   немає нічого, що стоїть на тій же горизонталі, тож вертикальний прохід
   там не знайде сусідів і чесно скаже «тут нічого не міряється» — на цьому
   й будується вибір осі нижче. */
function scanAxis(axis: SpacingAxis, boxes: Box[], pad: ReturnType<typeof paddingBox>, x: number, y: number): Scan | null {
  const vertical = axis === 'block'
  const a0 = (b: Box) => (vertical ? b.top : b.left)
  const a1 = (b: Box) => (vertical ? b.bottom : b.right)
  const c0 = (b: Box) => (vertical ? b.left : b.top)
  const c1 = (b: Box) => (vertical ? b.right : b.bottom)
  const p = vertical ? y : x
  const q = vertical ? x : y
  const padA0 = vertical ? pad.top : pad.left
  const padA1 = vertical ? pad.bottom : pad.right
  const padC0 = vertical ? pad.left : pad.top
  const padC1 = vertical ? pad.right : pad.bottom

  let before: Box | null = null
  let after: Box | null = null
  for (const b of boxes) {
    if (c1(b) < q || c0(b) > q) continue
    if (a1(b) <= p && (!before || a1(b) > a1(before))) before = b
    if (a0(b) >= p && (!after || a0(b) < a0(after))) after = b
  }

  const start = before ? a1(before) : padA0
  const end = after ? a0(after) : padA1
  if (!(end > start) || p < start || p > end) return null

  /* Смуга завширшки рівно з тим, що вона розділяє: підсвічувати всю ширину
     контейнера означало б показати не той проміжок, який людина бачить. */
  let from = padC0
  let to = padC1
  const parts = [before, after].filter((b): b is Box => b !== null)
  if (parts.length) {
    from = Math.max(padC0, Math.min(...parts.map(c0)))
    to = Math.min(padC1, Math.max(...parts.map(c1)))
    if (!(to > from)) {
      from = padC0
      to = padC1
    }
  }
  return { before, after, start, end, from, to }
}

/* Джерела — у порядку зі спеки: gap, потім margin сусідів, потім padding
   контейнера. Усередині цього порядку наперед виноситься те, чиє значення
   збігається з виміряною порожнечею: якщо `row-gap: 24px` і порожнеча 24px,
   це майже напевно він, а `margin-bottom: 16px` під ним — просто ще одна
   декларація, яку виконавцю варто побачити перед правкою.

   `sel === null` вимикає побудову селекторів: під час наведення ця функція
   працює на кожному русі миші, а `buildSelector` ходить у `querySelectorAll`
   по всьому документу. Прицілу селектори не потрібні — він показує лише
   властивість. */
function spacingSources(
  container: Element,
  cs: CSSStyleDeclaration,
  axis: SpacingAxis,
  scan: Scan,
  px: number,
  selector: SelectorFn | null,
): SpacingSource[] {
  const sel = (el: Element | null): string | null => (selector && el ? selector(el) : null)
  const own = sel(container)
  const vertical = axis === 'block'
  const out: SpacingSource[] = []

  /* 1. gap — тільки коли контейнер справді flex/grid І порожнеча лежить МІЖ
     двома дітьми: до кромки контейнера жоден gap не доїжджає. */
  if (/(flex|grid)/.test(cs.display) && scan.before && scan.after) {
    const raw = vertical ? cs.rowGap : cs.columnGap
    if (pxOf(raw) > 0) {
      out.push({ kind: 'gap', selector: own, property: vertical ? 'row-gap' : 'column-gap', value: raw })
    }
  }

  /* 2. margin сусідів. Порядок між ними — за спаданням значення, і це не
     косметика: у звичайному потоці сусідні margin СХЛОПУЮТЬСЯ, тобто працює
     більший, а не сума. Тож зверху стоїть той, що реально тримає порожнечу,
     а другий лишається в списку, бо після правки першого він стане чинним.
     У flex/grid схлопування немає — там вони додаються до gap, і список
     читається просто як перелік доданків. */
  const margins: SpacingSource[] = []
  const marginEdges: [Box | null, 'marginBottom' | 'marginTop' | 'marginRight' | 'marginLeft', string][] = vertical
    ? [
        [scan.before, 'marginBottom', 'margin-bottom'],
        [scan.after, 'marginTop', 'margin-top'],
      ]
    : [
        [scan.before, 'marginRight', 'margin-right'],
        [scan.after, 'marginLeft', 'margin-left'],
      ]
  for (const [box, camel, kebab] of marginEdges) {
    if (!box?.el) continue
    const value = getComputedStyle(box.el)[camel]
    if (pxOf(value) > 0) margins.push({ kind: 'margin', selector: sel(box.el), property: kebab, value })
  }
  margins.sort((a, b) => pxOf(b.value) - pxOf(a.value))
  out.push(...margins)

  /* 3. padding контейнера — рівно на тій кромці, де сусіда немає. */
  const paddingEdges: [boolean, 'paddingTop' | 'paddingBottom' | 'paddingLeft' | 'paddingRight', string][] = vertical
    ? [
        [!scan.before, 'paddingTop', 'padding-top'],
        [!scan.after, 'paddingBottom', 'padding-bottom'],
      ]
    : [
        [!scan.before, 'paddingLeft', 'padding-left'],
        [!scan.after, 'paddingRight', 'padding-right'],
      ]
  for (const [atEdge, camel, kebab] of paddingEdges) {
    if (!atEdge) continue
    const value = cs[camel]
    if (pxOf(value) > 0) out.push({ kind: 'padding', selector: own, property: kebab, value })
  }

  const exact = (s: SpacingSource) => Math.abs(pxOf(s.value) - px) < 0.5
  return [...out.filter(exact), ...out.filter((s) => !exact(s))]
}

export type Gap = {
  /* Сама порожнеча у координатах вʼюпорта — це і підсвітка, і `rect` ноти. */
  rect: Rect
  /* Порожнеча РАЗОМ із сусідами: кадр, у якому видно саму лише дірку, не
     пояснює нічого — дірка виглядає однаково завжди. */
  context: Rect
  spacing: Spacing
}

/* Головна функція режиму. Повертає `null`, коли під точкою не порожнеча, і
   тоді все працює рівно як досі. */
export function measureGap(container: Element, x: number, y: number, selector: SelectorFn | null): Gap | null {
  const cs = getComputedStyle(container)
  const pad = paddingBox(container)
  /* Смуга бордюра — не проміжок: там правиться `border-width`, і плутати ці
     дві речі означало б віддати виконавцю неправдиве джерело. */
  if (x < pad.left || x > pad.right || y < pad.top || y > pad.bottom) return null

  const boxes = occupied(container)
  /* Контейнер без вмісту — це порожній блок, а не проміжок у ньому: міряти
     нема між чим, і нота має бути звичайною. */
  if (!boxes.length) return null
  /* Перевірка суворіша за `elementFromPoint`: дитя з `pointer-events: none`
     хіт-тест пропускає, але місце воно займає, і порожнечею воно не є. */
  for (const b of boxes) {
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return null
  }

  const block = scanAxis('block', boxes, pad, x, y)
  const inline = scanAxis('inline', boxes, pad, x, y)
  /* Вісь обирає не налаштування контейнера, а те, що насправді стоїть навколо
     точки: виграє прохід, який знайшов більше сусідів, а за рівності — той,
     що намиряв менше. Стос блоків дає сусідів лише по вертикалі, флексовий
     рядок — лише по горизонталі, тож у типових випадках вибір однозначний.
     На перехресті рядкового й колонкового gap у гріді сусідів немає в обох
     проходах — тоді виграє коротший вимір, і це визнана неточність, а не
     здогадка про наміри розмітки. */
  const weight = (s: Scan | null) => (s ? (s.before ? 1 : 0) + (s.after ? 1 : 0) : -1)
  let axis: SpacingAxis = 'block'
  let scan = block
  if (
    weight(inline) > weight(block) ||
    (weight(inline) === weight(block) && block && inline && inline.end - inline.start < block.end - block.start)
  ) {
    axis = 'inline'
    scan = inline
  }
  if (!scan) return null

  const px = Math.round(scan.end - scan.start)
  if (px < 1) return null

  const rect: Rect =
    axis === 'block'
      ? { x: scan.from, y: scan.start, w: scan.to - scan.from, h: scan.end - scan.start }
      : { x: scan.start, y: scan.from, w: scan.end - scan.start, h: scan.to - scan.from }

  let left = rect.x
  let top = rect.y
  let right = rect.x + rect.w
  let bottom = rect.y + rect.h
  for (const b of [scan.before, scan.after]) {
    if (!b) continue
    left = Math.min(left, b.left)
    top = Math.min(top, b.top)
    right = Math.max(right, b.right)
    bottom = Math.max(bottom, b.bottom)
  }

  const selOf = (b: Box | null): string | null => (selector && b?.el ? selector(b.el) : null)

  return {
    rect,
    context: { x: left, y: top, w: right - left, h: bottom - top },
    spacing: {
      px,
      axis,
      between: [selOf(scan.before), selOf(scan.after)],
      sources: spacingSources(container, cs, axis, scan, px, selector),
    },
  }
}
