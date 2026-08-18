/* LOCAL ONLY — `comments-harness/` is kept out of git by .git/info/exclude, so this
   file exists on this machine and nowhere else.

   It is picked up by the lazy `import.meta.glob('./dev/*.local.tsx')` hook in
   src/App.tsx, which matches zero files on a clean checkout, sits behind
   `import.meta.env.DEV`, and is LAZY on purpose — an eager glob emits
   unconditional top-level imports, and a module with an import-time side
   effect can no longer be tree-shaken, which is how dev tooling once shipped
   to production. Hence: nothing in this module runs at import time — the one
   element it puts in the page is built on first render and removed on unmount.

   What it is: the in-page half of the note system that replaced Agentation
   (the package is gone; a wrapper around <Agentation/> no longer exists).
   Three processes share one contract — `comments-harness/docs/contract.md` — and only
   `comments-harness/server/notes-server.mjs` owns the data. This overlay writes notes and
   reads the thread; it stores nothing of its own beyond the panel's open/shut
   state and the theme choice.

   The loop it serves: point at a thing on the screen, say what is wrong, and
   an agent picks it up over MCP. The agent can ask back (`role:"agent"`), and
   the answer is typed right here (`role:"human"`), because walking to the
   terminal to answer "лише підпис" is what kills the loop.

   ── Four things that are easy to get wrong, all already paid for ──────────

   1. It skips "/". That route is ProtoNav — a left-hand index beside an
      IFRAME that stages the real screens, and the app renders inside that
      iframe too. Mounting at the root produced TWO live instances, one per
      document, and the outer one is the useless half: cross-document event
      listeners, DOM traversal and element geometry all stop at the iframe
      boundary, so it could annotate the navigator's own chrome and nothing of
      the design under review, while still fighting the inner instance for the
      same screen corner. Skipping "/" leaves exactly one instance wherever it
      can actually do its job.

   2. The endpoint is derived from location.hostname, not hardcoded to
      localhost. The dev server binds 0.0.0.0 (vite.config.ts sets
      `host: true`) and the review is normally opened from another machine on
      the LAN, where "localhost" means THAT machine's loopback and the POST
      fails with "Failed to fetch". The notes port is open to 192.168.1.0/24
      in ufw for the same reason. The port itself is not hardcoded here
      either — it comes from `client/endpoints.js`, the one place the two
      browser clients share (they cannot read `config.mjs`; see that file).

   3. Everything renders into a SHADOW ROOT. This repo runs three CSS systems
      at once, two of them global and unlayered, and this file needs tokens
      called --bg and --ink; in the light DOM those would either be overwritten
      by the project's own or overwrite them. The shadow boundary is the only
      isolation that works in both directions, so the styles live in a <style>
      inside the shadow (see CSS below for why they are not an imported file).
      Tokens are additionally scoped to `.smn` rather than `:host`/`:root`, so
      if the shadow ever has to be dropped the fallback is already in place.

   4. Nothing is stamped onto the annotated element — no `data-annot-id`, no
      class. Such a stamp dies on the next reload and does not exist in the
      source the agent greps, so the note would point at something the agent
      cannot find. The note carries a selector it derived instead. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { DEFAULT_NOTES_PORT, resolveEndpoints } from '../client/endpoints.js'

/* ── Contract types ───────────────────────────────────────────────────────
   Transcribed from notes-contract.md. Fields that are not in the contract are
   not invented here: the server whitelists on write, so anything extra would
   be silently dropped and the reader would be lied to. */
type Role = 'agent' | 'human'
type ThreadEntry = { role: Role; content: string; at: string }
type Rect = { x: number; y: number; w: number; h: number }

type Note = {
  id: string
  createdAt: string
  updatedAt: string
  /* Three, never two: `working` is the agent's "I have this", set the moment it
     picks the note up, and `resolved` means the fix is in and the note is now
     the reviewer's turn. Disappearing is DELETE, not a fourth status. */
  status: 'pending' | 'working' | 'resolved'
  note: string
  url: string
  viewport: { w: number; h: number } | null
  selector: string | null
  fullPath: string
  tagName: string | null
  classes: string | null
  text: string
  outerHTML: string
  rect: Rect | null
  components: string[]
  thread: ThreadEntry[]
  /* Шлях до кадру відносно `data/` (`shots/<id>.png`) або `null`. Сам кадр
     ніколи не лежить у JSON: стор читається цілком на кожен запит, а картинка
     блока — це сотні кілобайтів. Поле необовʼязкове, бо нота, створена до
     появи знімків, його просто не має. */
  shot?: string | null
  /* Є ЛИШЕ в ноті про проміжок — див. contract.md, «Відступ як предмет ноти».
     У звичайній ноті поля немає взагалі, а не `null`: наявність поля і є
     ознакою того, що предмет ноти — порожнеча, а не блок. */
  spacing?: Spacing | null
}

/* What one click on the page yields, before the note text is typed. */
type Capture = {
  selector: string | null
  fullPath: string
  tagName: string
  classes: string
  text: string
  outerHTML: string
  rect: Rect
  components: string[]
  /* Те саме правило, що й у `Note`: поле або є (клікнули в порожнечу), або
     його немає взагалі (клікнули в блок). */
  spacing?: Spacing
}

/* Limits from the contract's table. Truncation is the OVERLAY's job — the
   server answers 400 to anything over the line rather than trimming quietly,
   so a value that reaches it oversized is a bug in this file. */
const MAX_NOTE = 4000
const MAX_CONTENT = 4000
const MAX_OUTER_HTML = 2048
const MAX_TEXT = 300
const MAX_COMPONENTS = 8
/* Стеля сервера на «інші» рядки — селектор, шлях, список класів. Глибоко
   вкладений вузол або тейлвіндний `class` перебирають її легко, і без
   обрізання нота ставала невідправною з 400 замість того, щоб поїхати з
   трохи вкороченим доказом. */
const MAX_MISC = 4000

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/* ── Selector derivation ──────────────────────────────────────────────────
   The agent has to find this element again in the SOURCE, not in this DOM, so
   the selector must be made of things a human wrote: an id, a data attribute,
   a BEM-ish class. Framework noise (React's useId colons, Tailwind utilities,
   AntD internals) either does not appear in the source at all or appears in
   fifty places, and a selector built from it sends the agent to the wrong file.

   Walk up at most six levels, prefixing one segment at a time, and accept the
   first chain that matches exactly one node. Six levels without uniqueness is
   a give-up: `selector: null` is honest and `fullPath` still carries the
   position, whereas a selector that matches three nodes is worse than none. */

const MAX_DEPTH = 6

/* React 19's useId produces ids containing ':'; several libraries append a
   plain counter. Both are regenerated on every mount, so neither survives the
   reload the agent will do. */
function usableId(id: string): boolean {
  if (!id || id.includes(':')) return false
  if (/(^|[-_])\d+$/.test(id)) return false
  return /^[A-Za-z_][\w-]*$/.test(id)
}

/* Utility classes: enormous in number, meaningless in isolation, and never
   the thing a human would grep for. The variant/arbitrary syntaxes (`md:`,
   `[…]`, `w-1/2`) are unambiguous; the rest is the utility ROOT list. */
const UTILITY_ROOT =
  /^(m|p)[trblxyse]?-|^(w|h|min|max|size|gap|space|grid|col|row|text|font|bg|border|rounded|shadow|flex|basis|grow|shrink|items|content|place|justify|self|order|z|opacity|leading|tracking|indent|inset|top|left|right|bottom|overflow|object|cursor|select|pointer|ring|outline|divide|list|whitespace|break|truncate|hidden|block|inline|table|absolute|relative|fixed|sticky|static|container|antialiased|uppercase|lowercase|capitalize|italic|underline|transition|duration|ease|delay|animate|scale|rotate|translate|transform|backdrop|filter|blur|sr)(-|$)/

/* Machine-generated class names. They read as long and word-ish, so the utility
   list above never catches them, yet they are the worst possible selector: a
   fresh hash on every build, present in no source file, greppable by nobody.
   Three shapes cover what actually reaches us:
     `css-…`             — emotion / AntD cssinjs (`css-dev-only-do-not-override-ypkju9`)
     `ant-…-css-…`       — the same hash carried inside an ant- name
     `…-_r_2_`           — a segment that starts with `_` (React/cssinjs counters)
   plus the generic tail test below for hashes that mix letters and digits. */
const GENERATED_MARK = /(^|-)css(-|$)|(^|-)_/

function isGenerated(cls: string): boolean {
  if (GENERATED_MARK.test(cls)) return true
  /* A random tail: five or more characters mixing letters and digits at the end
     of the name. Deliberately narrow — real classes here end in short counters
     (`lw-grid-2`, `sm-ic-11`, `cmp-grid-2`), never in `ypkju9`. */
  const tail = cls.slice(cls.lastIndexOf('-') + 1)
  return tail.length >= 5 && /\d/.test(tail) && /[a-z]/i.test(tail)
}

function classKind(cls: string): 'semantic' | 'antd' | 'reject' {
  if (!cls || /[:[\]/.%#()]/.test(cls)) return 'reject'
  /* Before anything else: a generated name is worthless even when it is shaped
     like a BEM one, so this outranks the `__`/`--` shortcut. */
  if (isGenerated(cls)) return 'reject'
  /* Explicitly structured names are always human-authored. */
  if (cls.includes('__') || cls.includes('--')) return 'semantic'
  if (cls.startsWith('ant-')) return 'antd'
  if (cls.length <= 3) return 'reject'
  if (UTILITY_ROOT.test(cls)) return 'reject'
  /* What is left is a prefixed project class (`bk-row`, `sd-trainer`,
     `tx-table`, `section-head`, `sm-…`) or a plain descriptive one. Both are
     written by hand and both are greppable. */
  return 'semantic'
}

/* Attributes a person put there on purpose. `data-testid` first because it is
   the one that exists to be selected by; the generic `data-*` sweep skips
   anything a framework owns or a value too long to be an identifier. */
function dataAttrSegment(el: Element): string | null {
  for (const name of ['data-testid', 'data-test', 'data-qa', 'data-id']) {
    const v = el.getAttribute(name)
    if (v && v.length <= 64) return `[${name}="${CSS.escape(v)}"]`
  }
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith('data-')) continue
    if (/^data-(reactroot|react|radix|ant|state|slot|headlessui|floating)/.test(attr.name)) continue
    if (!attr.value || attr.value.length > 64) continue
    if (/\s/.test(attr.value)) continue
    return `[${attr.name}="${CSS.escape(attr.value)}"]`
  }
  return null
}

function classList(el: Element): string[] {
  /* SVG elements carry an SVGAnimatedString in `className`, which is why this
     reads the attribute instead. */
  const raw = el.getAttribute('class') || ''
  return raw.split(/\s+/).filter(Boolean)
}

/* One element → the best segment for it, in the contract's order of
   preference: id, stable data-*, semantic class, ant-* only as a last resort,
   bare tag when nothing at all is nameable. */
function segment(el: Element): string {
  const tag = el.tagName.toLowerCase()
  if (usableId(el.id)) return `#${CSS.escape(el.id)}`
  const data = dataAttrSegment(el)
  if (data) return tag + data

  const classes = classList(el)
  const semantic = classes.filter((c) => classKind(c) === 'semantic')
  if (semantic.length) return tag + semantic.slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('')
  const antd = classes.filter((c) => classKind(c) === 'antd')
  if (antd.length) return tag + `.${CSS.escape(antd[0])}`
  return tag
}

function nthOfType(el: Element): number {
  let i = 1
  let sib = el.previousElementSibling
  while (sib) {
    if (sib.tagName === el.tagName) i += 1
    sib = sib.previousElementSibling
  }
  return i
}

const unique = (sel: string): boolean => {
  try {
    return document.querySelectorAll(sel).length === 1
  } catch {
    return false
  }
}

function buildSelector(el: Element): string | null {
  /* Two passes: the plain leaf first, then the leaf pinned by position. The
     second is only reached when the first ran out of ancestors, so a note on a
     one-of-a-kind element never carries a brittle :nth-of-type it did not
     need. */
  for (const pinned of [false, true]) {
    let leaf = segment(el)
    if (pinned) leaf += `:nth-of-type(${nthOfType(el)})`
    if (unique(leaf)) return leaf

    let chain = leaf
    let node: Element | null = el.parentElement
    for (let depth = 0; depth < MAX_DEPTH && node && node !== document.documentElement; depth += 1) {
      chain = `${segment(node)} > ${chain}`
      if (unique(chain)) return chain
      node = node.parentElement
    }
  }
  return null
}

/* The fallback the contract says is never null. Absolute, positional, and
   valid even when nothing on the page has a name worth using. */
function buildFullPath(el: Element): string {
  const parts: string[] = []
  let node: Element | null = el
  while (node && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase()
    parts.unshift(node === document.body ? 'body' : `${tag}:nth-of-type(${nthOfType(node)})`)
    if (node === document.body) break
    node = node.parentElement
  }
  return parts.join(' > ')
}

/* ── React component chain ────────────────────────────────────────────────
   The fiber hanging off the DOM node, then `_debugOwner` upward: who rendered
   this, who rendered them. It is the fastest route from a pixel to a file
   name — "RewardsClient > Card > SectionHead" is enough for one grep.

   `_debugSource` is GONE in React 19, so there is no file path to hand over
   and none is faked here; the agent greps the component name instead. */
type Fiber = {
  type?: unknown
  elementType?: unknown
  _debugOwner?: Fiber | null
  return?: Fiber | null
}

function fiberOf(el: Element): Fiber | null {
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      return (el as unknown as Record<string, Fiber>)[key] || null
    }
  }
  return null
}

function componentName(fiber: Fiber): string | null {
  const t = (fiber.elementType ?? fiber.type) as
    | { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string } }
    | string
    | null
    | undefined
  if (!t || typeof t === 'string') return null
  const name = t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name
  if (!name || name.length > 60) return null
  /* Anonymous arrow components and internal wrappers say nothing useful. */
  if (/^(Anonymous|_|Symbol)/.test(name)) return null
  return name
}

/* Wrappers that libraries render on their own account. `SingleObserver` and
   `ResizeObserver` from rc-resize-observer are the ones that actually showed up,
   sitting in front of the screen component and pushing the useful name down the
   list. None of these exist in our source, so none of them survive. */
const LIB_COMPONENT = new Set([
  'Provider',
  'Consumer',
  'Context',
  'Portal',
  'Fragment',
  'Suspense',
  'StrictMode',
  'CSSMotion',
  'CSSMotionList',
])

function isLibraryComponent(name: string): boolean {
  /* Host elements and internal helpers are lower-case; qualified names
     (`Context.Provider`, `Foo.Bar`) belong to a library's namespace. */
  if (!/^[A-Z]/.test(name)) return true
  if (name.includes('.')) return true
  if (/^(ForwardRef|Memo|Anonymous)/.test(name)) return true
  if (/Observer$/.test(name)) return true
  return LIB_COMPONENT.has(name)
}

function componentChain(el: Element): string[] {
  let fiber = fiberOf(el)
  /* Text nodes and host elements produced by a portal sometimes hold no fiber
     key of their own; the nearest ancestor that does describes the same tree. */
  let probe: Element | null = el
  while (!fiber && probe?.parentElement) {
    probe = probe.parentElement
    fiber = fiberOf(probe)
  }
  const raw: string[] = []
  let owner = fiber?._debugOwner ?? null
  let guard = 0
  while (owner && raw.length < MAX_COMPONENTS * 2 && guard < 60) {
    const name = componentName(owner)
    if (name && name !== raw[raw.length - 1]) raw.push(name)
    owner = owner._debugOwner ?? null
    guard += 1
  }
  const out = raw.filter((name) => !isLibraryComponent(name))
  /* Everything filtered out means the heuristic did not recognise this tree.
     A noisy chain still points somewhere; an empty one points nowhere, so the
     raw chain goes out with a marker saying it was not cleaned. */
  if (!out.length) return raw.length ? [...raw.slice(0, MAX_COMPONENTS - 1), '(unfiltered)'] : raw
  return out.slice(0, MAX_COMPONENTS)
}

function capture(el: Element): Capture {
  const r = el.getBoundingClientRect()
  /* `null` тут — окремий стан («унікального селектора немає»), а не порожній
     рядок, тож обрізається лише коли рядок таки є. */
  const selector = buildSelector(el)
  return {
    selector: selector === null ? null : cut(selector, MAX_MISC),
    fullPath: cut(buildFullPath(el), MAX_MISC),
    tagName: el.tagName.toLowerCase(),
    classes: cut(el.getAttribute('class') || '', MAX_MISC),
    text: cut((el.textContent || '').replace(/\s+/g, ' ').trim(), MAX_TEXT),
    outerHTML: cut(el.outerHTML, MAX_OUTER_HTML),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    components: componentChain(el),
  }
}

/* Короткий підпис елемента для прицілу: тег плюс до двох осмислених класів.
   Рівно те, що видно на бейджі під час наведення, і нічого більше — довший
   рядок там не читають, його читають у композері. */
function describe(el: Element): string {
  const cls = classList(el)
    .filter((c) => classKind(c) !== 'reject')
    .slice(0, 2)
  return el.tagName.toLowerCase() + cls.map((c) => `.${c}`).join('')
}

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

type SpacingAxis = 'block' | 'inline'
type SpacingSource = {
  kind: 'gap' | 'margin' | 'padding'
  /* Селектор носія декларації — контейнера для gap/padding, сусіда для margin.
     `null`, коли унікального селектора не вийшло, як і всюди в цій ноті. */
  selector: string | null
  property: string
  value: string
}
type Spacing = {
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

   `deep` вимикає побудову селекторів: під час наведення ця функція працює на
   кожному русі миші, а `buildSelector` ходить у `querySelectorAll` по всьому
   документу. Прицілу селектори не потрібні — він показує лише властивість. */
function spacingSources(
  container: Element,
  cs: CSSStyleDeclaration,
  axis: SpacingAxis,
  scan: Scan,
  px: number,
  deep: boolean,
): SpacingSource[] {
  const sel = (el: Element | null): string | null => {
    if (!deep || !el) return null
    const s = buildSelector(el)
    return s === null ? null : cut(s, MAX_MISC)
  }
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

type Gap = {
  /* Сама порожнеча у координатах вʼюпорта — це і підсвітка, і `rect` ноти. */
  rect: Rect
  /* Порожнеча РАЗОМ із сусідами: кадр, у якому видно саму лише дірку, не
     пояснює нічого — дірка виглядає однаково завжди. */
  context: Rect
  spacing: Spacing
}

/* Головна функція режиму. Повертає `null`, коли під точкою не порожнеча, і
   тоді все працює рівно як досі. */
function measureGap(container: Element, x: number, y: number, deep: boolean): Gap | null {
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

  const selOf = (b: Box | null): string | null => {
    if (!deep || !b?.el) return null
    const s = buildSelector(b.el)
    return s === null ? null : cut(s, MAX_MISC)
  }

  return {
    rect,
    context: { x: left, y: top, w: right - left, h: bottom - top },
    spacing: {
      px,
      axis,
      between: [selOf(scan.before), selOf(scan.after)],
      sources: spacingSources(container, cs, axis, scan, px, deep),
    },
  }
}

/* Нота про проміжок — це нота про КОНТЕЙНЕР, у якого `rect` описує порожнечу,
   а не сам контейнер. Так вимагає контракт, і так воно й правильно: селектор
   мусить вести в код, а в коді порожнечі немає — є декларація на елементі. */
function captureGap(container: Element, gap: Gap): Capture {
  return {
    ...capture(container),
    rect: {
      x: Math.round(gap.rect.x),
      y: Math.round(gap.rect.y),
      w: Math.round(gap.rect.w),
      h: Math.round(gap.rect.h),
    },
    spacing: gap.spacing,
  }
}

/* Одна фраза, яка каже, ЩО саме анотовано — і в композері, і в треді. Осьова
   лексика тут не прикраса: «24px above .card» і «24px left of .card» це два
   різні дефекти, і плутати їх у брифі агента дорого. */
function spacingPhrase(s: Spacing): string {
  const [a, b] = s.between
  if (a && b) return `${s.px}px between ${a} and ${b}`
  if (b) return s.axis === 'block' ? `${s.px}px above ${b}` : `${s.px}px left of ${b}`
  if (a) return s.axis === 'block' ? `${s.px}px below ${a}` : `${s.px}px right of ${a}`
  return s.axis === 'block' ? `${s.px}px of vertical space` : `${s.px}px of horizontal space`
}

/* ── Кадр анотованого блока ───────────────────────────────────────────────
   `outerHTML` показує розмітку й не показує СПІВВІДНОШЕНЬ: відступу, збитої
   кромки, переносу, іконки, що сидить не на тій лінії. Саме через це
   «виправ вирівнювання» коштувало двох діб очікування уточнень. Кадр закриває
   рівно цю дірку — і лишається довідкою, а не критерієм приймання.

   Растеризує вендорена `html2canvas-pro` (див. `vendor/README.md`): нативного
   способу зняти довільний DOM у растр немає, а шлях через `foreignObject` на
   цій сторінці розсиплеться — три системи CSS, зовнішні шрифти, AntD і
   SVG-іконки, які підмінює рантайм. Імпорт динамічний: 440 КБ бібліотеки не
   мають вантажитись у кожен роут дев-збірки заради оверлея, яким користуються
   не щохвилини. */

const SHOT_PAD = 24
/* Для проміжку поле навколо ширше. Субʼєкт тут — порожнеча, і сама по собі
   вона в кадрі не читається взагалі: порожнє місце виглядає однаково завжди.
   Пояснює його рівно оточення, тож рамка бере сусідів (див. `Gap.context`) і
   ще вдвічі більше повітря, щоб було видно, з чим цей проміжок порівнювати. */
const SHOT_PAD_GAP = 48
const SHOT_MAX_WIDTH = 1400
const SHOT_MAX_SCALE = 2
/* `MAX_SHOT` сервера — 4 МБ. Перевірка тут, щоб не гнати по мережі те, що
   гарантовано отримає 413. */
const SHOT_MAX_BYTES = 4 * 1024 * 1024
/* Скільки відправка ноти згодна почекати на кадр. Стеля, а не очікування:
   вийшов час — нота йде, кадр доїжджає окремо. */
const SHOT_WAIT_MS = 5000

type Shot =
  | { status: 'taking' }
  | { status: 'ready'; blob: Blob; url: string }
  | { status: 'failed'; reason: string }

/* Дефект майже завжди живе МІЖ елементом і сусідами, тож вузький елемент сам
   собою не пояснює нічого: кнопка, вирвана зі свого рядка, виглядає в кадрі
   бездоганно. Тому все, вужче за третину вʼюпорта, знімається разом із
   батьківським блоком. Далі одного рівня не піднімаємось: другий крок майже
   завжди дає всю сторінку, а вона вже не кадр. */
function shotSubject(el: Element): Element {
  if (el.getBoundingClientRect().width >= window.innerWidth / 3) return el
  const parent = el.parentElement
  if (!parent || parent === document.body || parent === document.documentElement) return el
  return parent
}

/* Поле навколо — і обрізка вʼюпортом: те, що за краєм екрана, браузер не
   малював, і в кадрі воно вийшло б смугою тла.

   Субʼєктом може бути не лише елемент: у ноті про проміжок це прямокутник
   порожнечі разом із сусідами, у якого власного вузла в DOM немає. Тому на
   вході або елемент (тоді працює правило «вузьке знімаємо з батьком»), або
   вже готовий прямокутник. */
function shotFrame(subject: Element | Rect): { left: number; top: number; w: number; h: number } {
  const isEl = subject instanceof Element
  const pad = isEl ? SHOT_PAD : SHOT_PAD_GAP
  const r = isEl
    ? shotSubject(subject).getBoundingClientRect()
    : { left: subject.x, top: subject.y, right: subject.x + subject.w, bottom: subject.y + subject.h }
  const left = Math.max(0, Math.floor(r.left - pad))
  const top = Math.max(0, Math.floor(r.top - pad))
  const right = Math.min(window.innerWidth, Math.ceil(r.right + pad))
  const bottom = Math.min(window.innerHeight, Math.ceil(r.bottom + pad))
  return { left, top, w: right - left, h: bottom - top }
}

/* Прозорий PNG на місці сторінки читався б як дефект, тому тло беремо явно:
   спершу з <body>, потім з <html>, і лише як остача — біле. */
function pageBackground(): string {
  for (const el of [document.body, document.documentElement]) {
    const bg = getComputedStyle(el).backgroundColor
    if (bg && bg !== 'transparent' && !bg.startsWith('rgba(0, 0, 0, 0)')) return bg
  }
  return '#ffffff'
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png')
  })
}

function halve(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(canvas.width / 2))
  out.height = Math.max(1, Math.round(canvas.height / 2))
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(canvas, 0, 0, out.width, out.height)
  return out
}

/* Кадр анімації у прихованій вкладці не настає взагалі: `requestAnimationFrame`
   там не викликається, і зйомка, почата перед перемиканням вкладки, зависла б
   разом зі схованим оверлеєм — виглядає це як «тулза зникла». Тож точок
   синхронізації дві, і друга — таймер, який тікає й у фоні. */
const nextFrame = (fallbackMs = 120) =>
  new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, fallbackMs)
    requestAnimationFrame(finish)
  })

/* Оверлей ховається лічильником, а не запамʼятованим попереднім значенням:
   друга зйомка, почата поки перша в польоті, прочитала б уже виставлений
   `display:none` і саме його б і «відновила» — оверлей зник би до
   перезавантаження сторінки. Клацнути двічі легко: під час зйомки тулзи не
   видно, і це саме та мить, коли користувач думає, що вона зламалась. */
let shotHides = 0
function hideHost(host: HTMLElement) {
  shotHides += 1
  host.style.display = 'none'
}
function showHost(host: HTMLElement) {
  shotHides = Math.max(0, shotHides - 1)
  if (shotHides === 0) host.style.removeProperty('display')
}

async function takeShot(subject: Element | Rect, host: HTMLElement): Promise<{ blob: Blob; url: string }> {
  const frame = shotFrame(subject)
  if (frame.w < 1 || frame.h < 1) throw new Error('element has no visible box')

  const { default: html2canvas } = await import('./vendor/html2canvas-pro.esm.js')

  /* Щільність — з екрана, але зі стелею 2×: третій крок уже не додає
     читабельності, лише вагу. Ширина кадру зверху обмежена так само, тож на
     широкому блоці масштаб опускається нижче одиниці. */
  const scale = Math.min(window.devicePixelRatio || 1, SHOT_MAX_SCALE, SHOT_MAX_WIDTH / frame.w)

  /* Оверлей прибирається з потоку на час зйомки — інакше в кадр потрапить
     власна рамка прицілу, а невдовзі й поповер. Він увесь у Shadow DOM під
     одним хостом, тож вистачає одного `display:none`; `ignoreElements` —
     другий пояс на випадок, коли клон уже знято до перемальовки.
     `finally` тут обовʼязковий: впаде растеризатор — оверлей мусить
     повернутись, бо інакше зникне вся тулза. */
  hideHost(host)
  let canvas: HTMLCanvasElement
  try {
    await nextFrame()
    canvas = await html2canvas(document.body, {
      /* x/y — у координатах документа, тому додається прокрутка. */
      x: frame.left + window.scrollX,
      y: frame.top + window.scrollY,
      width: frame.w,
      height: frame.h,
      scale,
      backgroundColor: pageBackground(),
      logging: false,
      useCORS: true,
      /* Картинка, яка не приїхала за 3 с, у кадрі буде порожньою — це краще,
         ніж нота, що чекає на мережу. */
      imageTimeout: 3000,
      ignoreElements: (node) => node === host,
    })
  } finally {
    showHost(host)
  }

  let blob = await toPng(canvas)
  /* Одна спроба здути: щільний скрін на 2× буває важчий за ліміт сервера, і
     вдвічі менший кадр усе ще пояснює співвідношення. Не влізло і після —
     нота поїде без кадру, це не привід її тримати. */
  if (blob.size > SHOT_MAX_BYTES) blob = await toPng(halve(canvas))
  if (blob.size > SHOT_MAX_BYTES) throw new Error('frame is over the 4 MB limit')

  return { blob, url: URL.createObjectURL(blob) }
}

/* base36 clock + four random characters: sortable, short, collision-free
   enough for one reviewer, and inside the contract's [A-Za-z0-9._-]. */
function newId(): string {
  const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `n-${Date.now().toString(36)}${rnd}`
}

/* ── Geometry ─────────────────────────────────────────────────────────────
   Every layer inside the shadow is position:fixed, so viewport coordinates
   from getBoundingClientRect are used as-is with no scroll arithmetic. */
type Anchor = { x: number; y: number; w: number; h: number }

/* Places a popover beside its anchor without knowing its height: it either
   hangs from `top` or is pinned by `bottom`, so the box can size itself. */
function popoverStyle(anchor: Anchor, width: number): CSSProperties {
  const gap = 10
  const margin = 12
  const left = Math.min(Math.max(anchor.x, margin), Math.max(margin, window.innerWidth - width - margin))
  const below = window.innerHeight - (anchor.y + anchor.h)
  if (below > 260 || below > anchor.y) {
    return { left, top: Math.max(margin, anchor.y + anchor.h + gap), width }
  }
  return { left, bottom: Math.max(margin, window.innerHeight - anchor.y + gap), width }
}

function resolveElement(note: Note): Element | null {
  if (note.selector) {
    try {
      const el = document.querySelector(note.selector)
      if (el) return el
    } catch {
      /* a selector that no longer parses is the same as one that no longer
         matches: fall through to the positional path */
    }
  }
  try {
    return document.querySelector(note.fullPath)
  } catch {
    return null
  }
}

const awaitsHuman = (n: Note) => n.thread.length > 0 && n.thread[n.thread.length - 1].role === 'agent'

/* The three statuses in the reviewer's words, not the contract's. `resolved`
   is phrased as an instruction because it is one: the note is only gone once a
   human has looked and deleted it. */
const STATE_LABEL: Record<Note['status'], string> = {
  pending: 'waiting',
  working: 'agent working',
  resolved: 'done — check it',
}

/* Same chip in the list and in the thread header; two places drawing the same
   state two ways is how a status vocabulary stops being one. */
function StateChip({ status }: { status: Note['status'] }) {
  return (
    <span className={`smn-state smn-state--${status}`}>
      <span className="smn-mark" aria-hidden="true" />
      {STATE_LABEL[status]}
    </span>
  )
}

/* The unanswered question is a second, independent chip — see the CSS note. */
function AskedChip() {
  return (
    <span className="smn-state smn-state--asked">
      <span className="smn-mark" aria-hidden="true" />
      agent asked
    </span>
  )
}

/* Смуга виміру. Одна й та сама і під прицілом, і поки пишеться нота: предмет
   не змінюється від того, що відкрився композер, і малювати його двома
   способами означало б натякнути, що змінюється. */
function GapBand({ box, spacing, tag }: { box: Anchor; spacing: Spacing; tag?: string }) {
  const primary = spacing.sources[0]
  return (
    <div
      className={`smn-gap smn-gap--${spacing.axis}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      {tag && (
        <span className={`smn-aim__tag smn-aim__tag--quiet${box.y < 24 ? ' smn-aim__tag--below' : ''}`}>{tag}</span>
      )}
      <span className="smn-gap__val">
        {spacing.px}px{primary && <em>{primary.property}</em>}
      </span>
    </div>
  )
}

/* Що саме анотовано — фразою й переліком джерел. Той самий блок у композері
   (нота ще пишеться) і в треді (нота вже є): читач в обох випадках має
   зрозуміти, що предмет тут порожнеча, і не сплутати її з контейнером. */
function SpacingTarget({ spacing }: { spacing: Spacing }) {
  return (
    <span className="smn-gap__sum">
      <b>{spacingPhrase(spacing)}</b>
      {spacing.sources.map((s, i) => (
        <span key={`${s.property}-${i}`} className="smn-chain">
          {s.property} {s.value}
          {s.selector ? ` — ${s.selector}` : ''}
        </span>
      ))}
      {spacing.sources.length === 0 && (
        <span className="smn-chain">no gap, margin or padding here — the container's alignment makes it</span>
      )}
    </span>
  )
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
}

/* ══════════════════════════════════════════════════════════════════════════
   Styles.

   Inline, in a <style> inside the shadow root, and NOT an imported .css file:
   Vite turns `import './x.css'` into a stylesheet in the document head, and a
   document stylesheet does not cross the shadow boundary — the import would
   leak every rule into the app and style nothing here. A string is the only
   form that lands on the right side of the boundary. Same reason the tokens
   sit on `.smn` and never on `:root`.

   The visual language is `public/fixlog.html`, deliberately: this and the fix
   log are two windows onto the same work, opened side by side, and a dev tool
   that dresses like the product it observes is confusing at a glance. So:
   dark-first, one cool 265° hue for every surface, chroma spent only on
   meaning (blue = the agent is waiting on you), and Inter for everything —
   words and machine values alike (ids, selectors, component chains, clocks),
   with tabular figures wherever digits have to line up.

   Fonts are stacks, never a webfont link: this page is regularly opened from a
   LAN box with no internet, and an @font-face declared inside a shadow root
   would not load anyway. Offline just means plainer type.
   ══════════════════════════════════════════════════════════════════════════ */
const CSS_TEXT = `
.smn {
  /* Одна гарнітура на весь оверлей. Моноширинний ніс тут дві роботи:
     маркував машинне значення і вирівнював цифри. Перше лишилось за
     приглушеним чорнилом, друге робить font-variant-numeric: tabular-nums
     усередині Inter. Токена другої родини немає навмисно — без споживачів
     він би тільки чекав, поки хтось поверне його в код за звичкою.
     Вебшрифта тут як не було, так і немає: оверлей працює поверх чужої
     сторінки, часто без мережі, тож стек лишається системним. */
  --font-ui: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;

  --r-xs: 4px;
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 12px;

  --dur-fast: 120ms;
  --dur: 180ms;
  --ease-out: cubic-bezier(.22, 1, .36, 1);

  color-scheme: dark;

  --bg:        oklch(0.165 0.008 265);
  --bg-raised: oklch(0.205 0.009 265);
  --bg-hover:  oklch(0.245 0.010 265);
  --bg-inset:  oklch(0.130 0.007 265);

  --line:        oklch(1 0 0 / 0.07);
  --line-strong: oklch(1 0 0 / 0.14);
  --line-hover:  oklch(1 0 0 / 0.22);

  --ink:   oklch(0.93 0.004 265);
  --ink-2: oklch(0.80 0.006 265);
  --muted: oklch(0.66 0.010 265);
  --faint: oklch(0.50 0.010 265);

  --info:       oklch(0.72 0.13 245);
  --info-soft:  oklch(0.72 0.13 245 / 0.12);
  --info-line:  oklch(0.72 0.13 245 / 0.40);
  --danger:     oklch(0.71 0.17 25);
  --danger-soft: oklch(0.71 0.17 25 / 0.12);
  --danger-line: oklch(0.71 0.17 25 / 0.35);

  /* The second, and last, hue that carries meaning here: 155° = "the fix is in,
     look at it". It had to be its own colour because 245° is already spoken
     for — blue means the agent stopped and asked you something, and a done note
     and a blocked note are opposite instructions to the same person. Green is
     the loudest thing this overlay ever draws, which is correct: it is the only
     state that ends with the reviewer doing something. */
  --done:      oklch(0.76 0.14 155);
  --done-soft: oklch(0.76 0.14 155 / 0.13);
  --done-lift: oklch(0.76 0.14 155 / 0.20);
  --done-line: oklch(0.76 0.14 155 / 0.42);
  --on-done:   oklch(0.17 0.03 155);

  --ring: 0 0 0 1.5px oklch(0.72 0.13 245 / 0.75);
  --shadow-pop: 0 24px 48px oklch(0 0 0 / 0.5);
  --btn-primary-hover: oklch(1 0 0);

  font-family: var(--font-ui);
}

/* Light is weighed on its own, not inverted: white panels on a cool
   near-white ground, ink pulled down, every state hue dropped ~0.15 L so it
   still clears text contrast on white. */
.smn[data-theme='light'] {
  color-scheme: light;

  --bg:        oklch(0.965 0.003 265);
  --bg-raised: oklch(1 0 0);
  --bg-hover:  oklch(0.945 0.004 265);
  --bg-inset:  oklch(0.955 0.004 265);

  --line:        oklch(0 0 0 / 0.08);
  --line-strong: oklch(0 0 0 / 0.15);
  --line-hover:  oklch(0 0 0 / 0.25);

  --ink:   oklch(0.22 0.010 265);
  --ink-2: oklch(0.36 0.012 265);
  --muted: oklch(0.50 0.012 265);
  --faint: oklch(0.72 0.008 265);

  --info:       oklch(0.55 0.15 245);
  --info-soft:  oklch(0.55 0.15 245 / 0.10);
  --info-line:  oklch(0.55 0.15 245 / 0.35);
  --danger:     oklch(0.55 0.19 25);
  --danger-soft: oklch(0.55 0.19 25 / 0.09);
  --danger-line: oklch(0.55 0.19 25 / 0.30);

  /* Green drops further than the others on white: the label it carries is
     10.5px, so it is pulled to L 0.46 rather than the ~0.55 the rest of
     the state hues use. */
  --done:      oklch(0.46 0.13 155);
  --done-soft: oklch(0.46 0.13 155 / 0.10);
  --done-lift: oklch(0.46 0.13 155 / 0.16);
  --done-line: oklch(0.46 0.13 155 / 0.32);
  --on-done:   oklch(1 0 0);

  --ring: 0 0 0 1.5px oklch(0.55 0.15 245 / 0.6);
  --shadow-pop: 0 16px 40px oklch(0.2 0.01 265 / 0.22);
  --btn-primary-hover: oklch(0.10 0.01 265);
}

.smn *, .smn *::before, .smn *::after { box-sizing: border-box; }
.smn button { font: inherit; margin: 0; }

/* The layer itself never eats a click; only the pieces that are controls opt
   back in. Without this the whole app would be unusable while the overlay is
   mounted, which is every dev session. */
.smn { position: fixed; inset: 0; pointer-events: none; }
.smn-hit { pointer-events: auto; }

/* ── Launcher ─────────────────────────────────────────────────────────────
   Bottom-right, one row high, always the same three things: aim, count, list.
   It is furniture — it must be findable without ever being the loudest thing
   on somebody else's screenshot. */
.smn-bar {
  position: fixed;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-pop);
  pointer-events: auto;
}
.smn-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 24px;
  min-width: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--r-xs);
  background: none;
  color: var(--muted);
  font: 500 11.5px/1 var(--font-ui);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out),
              border-color var(--dur-fast) var(--ease-out),
              background-color var(--dur-fast) var(--ease-out);
}
.smn-btn:hover { background: var(--bg-hover); color: var(--ink); }
.smn-btn:focus-visible { outline: none; box-shadow: var(--ring); }
.smn-btn[aria-pressed='true'] { background: var(--info-soft); border-color: var(--info-line); color: var(--info); }
.smn-btn svg { width: 13px; height: 13px; }
.smn-count { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-ui); font-size: 11px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
/* Two tallies, each in the colour of what it counts, and each shown only when
   it is not zero — a permanent "· 0" trains the eye to stop reading the row. */
.smn-count__part { display: inline-flex; align-items: center; gap: 3px; }
.smn-count__part::before { content: '·'; color: var(--line-hover) }
.smn-count__part--wait { color: var(--info); }
.smn-count__part--done { color: var(--done); }
.smn-sep { width: 1px; height: 14px; background: var(--line); }

/* ── Aim mode ─────────────────────────────────────────────────────────────
   An outline plus one label. No scrim: the point is to see the screen
   normally and decide what is wrong with it. */
.smn-aim {
  position: fixed;
  border: 1px solid var(--info);
  background: var(--info-soft);
  border-radius: 2px;
  pointer-events: none;
}
.smn-aim__tag {
  position: absolute;
  left: 0;
  top: -19px;
  max-width: 60vw;
  padding: 1px 5px;
  border-radius: var(--r-xs);
  background: var(--info);
  color: oklch(0.14 0.01 265);
  font: 500 10.5px/1.6 var(--font-ui);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.smn-aim__tag--below { top: auto; bottom: -19px; }
/* Поки відкритий композер, підсвітка — єдиний звʼязок між коробкою по центру
   й тим, про що вона. Тому вона товща за прицільну й має світлий кант ззовні,
   щоб читатись і на темному, і на строкатому фоні. */
.smn-aim--subject {
  border-width: 2px;
  box-shadow: 0 0 0 1px var(--bg-raised);
}

/* ── Проміжок під прицілом ────────────────────────────────────────────────
   Блок і порожнеча між блоками — два різні предмети ноти, і сплутати їх
   дорого: «зменши тут» про картку і про дірку між картками правляться
   різними деклараціями. Тому підсвітка проміжку не має з прицільною рамкою
   жодної спільної риси, окрім того, що лежить на тому самому місці:

     — замість заливки штриховка, бо штрихують те, чого немає;
     — замість рамки по периметру дві риски на кромках виміру, як у
       кресленні: показано не предмет, а відстань;
     — і жодної хроми. Синій в оверлеї означає «твій хід», зелений — «полагоджено,
       глянь»; проміжок не вимагає від користувача нічого, тож колір йому
       був би брехнею. Форми тут вистачає з запасом.

   Кольори штриховки НЕ залежать від теми оверлея, і це навмисно: смуга лежить
   на ЧУЖІЙ сторінці, а тема тулзи нічого не каже про те, світлий чи темний під
   нею ґрунт. Тому пара: світла підкладка, що піднімає смугу на темному, і
   темні штрихи, що ловляться на світлому. Одне з двох працює завжди. */
.smn-gap {
  position: fixed;
  pointer-events: none;
  background-color: oklch(1 0 0 / 0.24);
  background-image: repeating-linear-gradient(45deg,
    oklch(0.18 0.02 265 / 0.32) 0 2px, transparent 2px 5px);
}
/* Кромки виміру. Вони ж рятують випадок, коли порожнеча в кілька пікселів і
   штриховці просто немає де проявитись: дві риски на 3px дірці зливаються в
   одну виразну лінію, і проміжок усе одно видно. */
.smn-gap::before, .smn-gap::after {
  content: '';
  position: absolute;
  background: oklch(0.58 0.02 265);
}
.smn-gap--block::before, .smn-gap--block::after { left: 0; right: 0; height: 1px; }
.smn-gap--block::before { top: 0 }
.smn-gap--block::after  { bottom: 0 }
.smn-gap--inline::before, .smn-gap--inline::after { top: 0; bottom: 0; width: 1px; }
.smn-gap--inline::before { left: 0 }
.smn-gap--inline::after  { right: 0 }

/* Виміряне значення — по центру смуги, і навмисно БІЛЬШЕ за неї: 4px дірка
   не має де вмістити підпис, а число потрібне саме на такій. Поруч, тихішим
   чорнилом, найімовірніше джерело — рівно одне слово, бо тут потрібен один
   погляд; повний перелік чекає в композері, де нота і складається. */
.smn-gap__val {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 1px 5px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-xs);
  background: var(--bg-raised);
  color: var(--ink);
  font: 600 10.5px/1.6 var(--font-ui);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  box-shadow: var(--shadow-pop);
}
.smn-gap__val em { font-style: normal; font-weight: 500; color: var(--muted); }
/* Той самий бейдж контейнера, що й у прицілу, але без синього: у смузі колір
   уже сказав би те, чого немає. */
.smn-aim__tag--quiet {
  border: 1px solid var(--line-strong);
  background: var(--bg-raised);
  color: var(--ink-2);
}
/* Keycaps: used by the list panel's offline state, which spells out the
   command that starts the server. */
.smn-kbd {
  padding: 1px 4px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-xs);
  background: var(--bg-inset);
  color: var(--muted);
  font: 500 10.5px/1.4 var(--font-ui);
}

/* ── Markers ──────────────────────────────────────────────────────────────
   One numbered pin per note, sitting on the element's top-left corner.

   Three states, split on three different channels so no two of them rely on
   telling one tint from another:
     pending  — neutral disc, nothing added. Waiting is the resting state and
                the resting state gets no ink.
     working  — still neutral, but a thin arc turns around the disc. No chroma:
                nobody has to do anything about a note an agent is holding, and
                colour in this tool is reserved for "your turn". Motion is the
                honest channel for "something is happening right now" anyway.
     resolved — the only FILLED pin, and the only green one. It is loud because
                it is the one state that is waiting on the reviewer.
   Blue stays what it already was: the last word in the thread was the agent's,
   i.e. it asked and stopped. That badge rides on top of any of the three. */
.smn-pin {
  position: fixed;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  transform: translate(-9px, -9px);
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--bg-raised);
  color: var(--ink-2);
  font: 500 10.5px/1 var(--font-ui);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: var(--shadow-pop);
  transition: color var(--dur-fast) var(--ease-out),
              border-color var(--dur-fast) var(--ease-out),
              background-color var(--dur-fast) var(--ease-out);
}
.smn-pin:hover { border-color: var(--line-hover); background: var(--bg-hover); color: var(--ink); }
.smn-pin:focus-visible { outline: none; box-shadow: var(--ring); }

/* The turning arc. One border side coloured, the rest transparent — the same
   figure a spinner draws, at a size where it reads as a ring rather than a
   dash. 1.8s is deliberately slower than a loading spinner: this is a status,
   not a wait, and it sits on top of somebody else's page for minutes at a
   time. */
.smn-pin--working::before {
  content: '';
  position: absolute;
  inset: -3px;
  border: 1.5px solid transparent;
  border-top-color: var(--muted);
  border-radius: 50%;
  animation: smn-turn 1.8s linear infinite;
}
@keyframes smn-turn { to { transform: rotate(1turn) } }

.smn-pin--done {
  border-color: var(--done-line);
  background: var(--done);
  color: var(--on-done);
}
.smn-pin--done:hover { border-color: var(--done); background: var(--done); color: var(--on-done); }

/* Which pin has its panel open is drawn with a neutral halo, not a tint: the
   tint slot belongs to the status now, and the open panel is standing right
   next to the pin saying the same thing anyway. */
.smn-pin--open { box-shadow: var(--shadow-pop), 0 0 0 2px var(--line-hover); }
.smn-pin--wait::after {
  content: '';
  position: absolute;
  right: -1px;
  top: -1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--info);
  box-shadow: 0 0 0 1.5px var(--bg-raised);
}
/* The badge's separating halo is the colour of what it sits ON, so on the one
   filled pin it has to be the fill. Compound state, not a specificity trick. */
.smn-pin--done.smn-pin--wait::after { box-shadow: 0 0 0 1.5px var(--done); }

/* ── State chip ───────────────────────────────────────────────────────────
   The same three states in words, for the list and the thread header. Shape
   carries as much as colour: ring / turning arc / filled disc, so the trio
   survives a monochrome screenshot and a reviewer who does not know the code
   for the colours yet. Lowercase and muted, because it is machine state, like
   every other machine value in this overlay. */
.smn-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: 500 10.5px/1.5 var(--font-ui);
  white-space: nowrap;
}
.smn-mark {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.smn-state--pending { color: var(--muted); }
.smn-state--pending .smn-mark { border: 1px solid var(--faint); }
.smn-state--working { color: var(--ink-2); }
.smn-state--working .smn-mark {
  width: 9px;
  height: 9px;
  border: 1.5px solid transparent;
  border-top-color: var(--ink-2);
  animation: smn-turn 1.8s linear infinite;
}
.smn-state--resolved { color: var(--done); }
.smn-state--resolved .smn-mark { background: var(--done); }
/* "The agent asked and stopped" is orthogonal to the status — a note can be
   held, or even fixed, and still have an unanswered question at the end of its
   thread. So it is a second chip rather than a fourth state. */
.smn-state--asked { color: var(--info); }
.smn-state--asked .smn-mark { background: var(--info); }

/* ── Panels: composer, thread, list ───────────────────────────────────────
   One box shape for all three. A tool with three different panel treatments
   reads as three tools. */
.smn-pop {
  position: fixed;
  display: flex;
  flex-direction: column;
  max-height: min(70vh, 520px);
  padding: 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg);
  background: var(--bg-raised);
  color: var(--ink-2);
  box-shadow: var(--shadow-pop);
  pointer-events: auto;
  animation: smn-in var(--dur) var(--ease-out) both;
}
@keyframes smn-in {
  from { opacity: 0; transform: translateY(-4px) scale(.985) }
  to   { opacity: 1; transform: none }
}
.smn-list {
  position: fixed;
  right: 12px;
  bottom: 48px;
  width: min(340px, calc(100vw - 24px));
}

/* Композер стоїть по центру екрана, а не біля елемента. Причина: елемент може
   бути будь-де — під краєм вʼюпорта, у вузькій колонці, під липкою шапкою, —
   і поповер біля нього то стрибає з кадру в кадр, то накриває сам предмет
   розмови. Центр не залежить ні від чого, тож не рухається при скролі й
   ресайзі, а що саме анотовано, видно з підсвітки й прев'ю кадру.

   Центрування через flex-обгортку, а не transform: у .smn-pop вже висить
   поява smn-in, яка анімує transform, і translate(-50%,-50%) з нею б
   конфліктував. Обгортка прозора для миші — клікати повз композер має
   сторінка, а не оверлей. */
.smn-center {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  pointer-events: none;
}
/* Всередині обгортки коробка вже не позиціюється сама; ширина стискається на
   вузькому екрані, бо padding обгортки з'їдає рівно 24px. */
.smn-pop--center {
  position: static;
  width: min(320px, 100%);
}

.smn-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
/* The chips sit between the title and the close button and never shrink: on a
   340px panel the title is the elastic part. */
.smn-head .smn-state { flex: 0 0 auto; align-self: center; }
.smn-title {
  flex: 1 1 auto;
  color: var(--ink);
  font: 600 12.5px/1.35 var(--font-ui);
  letter-spacing: -0.01em;
}
.smn-x {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-xs);
  background: none;
  color: var(--muted);
  font: 400 13px/1 var(--font-ui);
  cursor: pointer;
}
.smn-x:hover { background: var(--bg-hover); color: var(--ink); }
.smn-x:focus-visible { outline: none; box-shadow: var(--ring); }

/* The target line: what the note is attached to, in machine type, always
   visible while writing. Missing selector is stated, not hidden — it changes
   how the agent will have to find the thing. */
.smn-target {
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  font: 400 11px/1.5 var(--font-ui);
  color: var(--ink);
  overflow-wrap: anywhere;
}
.smn-target--none { color: var(--muted); }
/* Рядок «що саме анотовано» для ноти про проміжок. Стоїть НАД селектором
   контейнера, бо предмет тут порожнеча, а контейнер — лише її адреса; якби
   першим ішов селектор, нота читалась би як нота про контейнер. */
.smn-gap__sum {
  display: block;
  margin-bottom: 3px;
  color: var(--ink);
}
.smn-gap__sum b { font-weight: 600; font-variant-numeric: tabular-nums; }
.smn-chain {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 10.5px;
}

/* Прев'ю кадру: рівно стільки, щоб упізнати, ЩО саме поїде агенту, і не
   стільки, щоб панель стала галереєю. Кадр вирівняний по верхньому краю —
   у нижній частині високого блока цікавого майже не буває. */
.smn-shot {
  display: block;
  width: 100%;
  margin-top: 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
}
img.smn-shot {
  max-height: 168px;
  object-fit: contain;
  object-position: top center;
}
.smn-shot--wait, .smn-shot--none {
  padding: 9px 10px;
  color: var(--muted);
  font: 400 11px/1.4 var(--font-ui);
  text-align: center;
}

.smn-note {
  display: block;
  flex: 0 0 auto;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--ink);
  font: 400 12.5px/1.5 var(--font-ui);
  resize: vertical;
}
.smn-note::placeholder { color: var(--muted); }
.smn-note:hover { border-color: var(--line-hover); }
.smn-note:focus { outline: none; box-shadow: var(--ring); border-color: transparent; }

.smn-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.smn-foot__spacer { flex: 1 1 auto; }
.smn-err { flex: 1 1 auto; color: var(--danger); font: 500 11.5px/1.4 var(--font-ui); overflow-wrap: anywhere; }
.smn-hintline { flex: 1 1 auto; color: var(--faint); font: 400 11px/1.4 var(--font-ui); }
.smn-ghost, .smn-primary, .smn-danger {
  flex: 0 0 auto;
  padding: 5px 12px;
  border-radius: var(--r-sm);
  font: 500 12px/1.4 var(--font-ui);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out),
              border-color var(--dur-fast) var(--ease-out),
              background-color var(--dur-fast) var(--ease-out);
}
.smn-ghost { border: 1px solid var(--line-strong); background: none; color: var(--ink-2); }
.smn-ghost:hover { background: var(--bg-hover); color: var(--ink); }
.smn-danger { border: 1px solid var(--line-strong); background: none; color: var(--muted); }
.smn-danger:hover { border-color: var(--danger-line); background: var(--danger-soft); color: var(--danger); }
/* The one filled control: primary is ink-coloured, so it is the brightest
   thing in the box and coloured like nothing else. */
.smn-primary { border: 1px solid transparent; background: var(--ink); color: var(--bg-raised); }
.smn-primary:hover { background: var(--btn-primary-hover); }
.smn-ghost:focus-visible, .smn-primary:focus-visible, .smn-danger:focus-visible { outline: none; box-shadow: var(--ring); }
.smn-primary[disabled], .smn-ghost[disabled], .smn-danger[disabled] { opacity: .5; cursor: default; }

/* ── Thread ──────────────────────────────────────────────────────────────
   The original note first, then the exchange. Whose turn it is has to be
   legible from two feet away, so the agent's turn is the only tinted block. */
/* Скрол-область усередині коробки: min-height: 0 обовʼязковий, бо без нього
   flex-дитина не має права стати нижчою за свій вміст і коробка просто
   вилазить за max-height замість того, щоб прокручуватись. */
.smn-scroll { flex: 0 1 auto; min-height: 0; overflow-y: auto; margin: 0 -2px; padding: 0 2px; }
.smn-said {
  margin: 0 0 6px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  font: 400 12.5px/1.5 var(--font-ui);
  color: var(--ink-2);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.smn-said--first { color: var(--ink); }
.smn-said--agent { border-color: var(--info-line); background: var(--info-soft); }
.smn-said__who {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 3px;
  color: var(--muted);
  font: 500 10px/1.5 var(--font-ui);
  font-variant-numeric: tabular-nums;
  text-transform: lowercase;
}
.smn-said--agent .smn-said__who { color: var(--info); }

/* ── List ────────────────────────────────────────────────────────────────
   Every open note on this page, newest last so the numbering matches the
   pins. Rows, not cards: this is an index. */
.smn-rows { display: flex; flex-direction: column; }
.smn-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 7px 6px;
  border: 0;
  border-top: 1px solid var(--line);
  border-radius: var(--r-xs);
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.smn-rows > .smn-row:first-child { border-top: 0; }
.smn-row:hover { background: var(--bg-hover); }
.smn-row:focus-visible { outline: none; box-shadow: var(--ring); }
.smn-row__n {
  flex: 0 0 auto;
  min-width: 16px;
  padding-top: 1px;
  color: var(--faint);
  font: 500 10.5px/1.5 var(--font-ui);
  font-variant-numeric: tabular-nums;
}
.smn-row--wait .smn-row__n { color: var(--info); }
/* The one row treatment that is not at rest tints the whole row, the way
   fixlog's .is-wip does, so "fixed, go look" is findable in the index without
   reading a word. working deliberately gets no tint — it is news, not a task.
   The tint outranks the hover fill, so hover lifts within the same hue. */
.smn-row--done { background: var(--done-soft); }
.smn-row--done:hover { background: var(--done-lift); }
.smn-row--done .smn-row__n { color: var(--done); }
.smn-row__body { flex: 1 1 auto; min-width: 0; }
.smn-row__txt {
  color: var(--ink-2);
  font: 400 12px/1.45 var(--font-ui);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* One line, chips first: the state is the thing being scanned for, the clock
   and the selector are what you read once you have found the row. The tail is
   the only part allowed to shrink, so the chip is never the thing that gets
   ellipsed away. */
.smn-row__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font: 400 10.5px/1.5 var(--font-ui);
  font-variant-numeric: tabular-nums;
}
.smn-row__meta .smn-state { flex: 0 0 auto; }
.smn-row__tail {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Empty state teaches the one gesture the tool has. */
.smn-empty {
  padding: 10px 4px 4px;
  color: var(--muted);
  font: 400 12px/1.55 var(--font-ui);
}
.smn-empty b { display: block; margin-bottom: 3px; color: var(--ink-2); font-weight: 600; }

@media (prefers-reduced-motion: reduce) {
  .smn-pop { animation: none }
  .smn-btn, .smn-pin, .smn-ghost, .smn-primary, .smn-danger, .smn-row { transition: none }
  /* The arc stops and stands still. It keeps its shape — a broken ring is
     still not a full ring and not a filled disc — so the three states stay
     apart without anything moving. The word beside it does the rest. */
  .smn-pin--working::before, .smn-state--working .smn-mark { animation: none }
}
`

/* Two glyphs, drawn rather than imported: the icon layer in this repo fetches
   its bodies from api.iconify.design at runtime, and the review box is often
   offline. */
const IconAim = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="7" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </svg>
)
const IconList = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
)

type Theme = 'dark' | 'light'
const THEME_KEY = 'smn-theme'

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    /* private mode / blocked storage — the OS preference is a fine answer */
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export default function DevAnnotator() {
  const { pathname, search } = useLocation()
  /* See the header: "/" is ProtoNav, and the same app runs inside its iframe. */
  if (pathname === '/') return null
  return <Overlay pathname={pathname} search={search} />
}

function Overlay({ pathname, search }: { pathname: string; search: string }) {
  /* Порт нот більше не літерал: дефолт і весь порядок його пошуку живуть в
     одному місці на двох браузерних клієнтів — `../client/endpoints.js`.
     Стартуємо з дефолту (це рівно те, що робилось досі, тож інсталяція «з
     коробки» працює з першого кадру), а якщо в проєкті лежить підказка про
     нестандартні порти — перемикаємось на неї, щойно вона приїде. */
  const [endpoint, setEndpoint] = useState(
    () => `http://${location.hostname}:${DEFAULT_NOTES_PORT}`,
  )
  useEffect(() => {
    let alive = true
    void resolveEndpoints().then((e) => {
      if (alive) setEndpoint((prev) => (e.notes === prev ? prev : e.notes))
    })
    return () => {
      alive = false
    }
  }, [])

  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [notes, setNotes] = useState<Note[]>([])
  const [offline, setOffline] = useState(false)

  const [aiming, setAiming] = useState(false)
  const [hover, setHover] = useState<Anchor | null>(null)
  const [hoverTag, setHoverTag] = useState('')
  /* Не `null` = під курсором зараз порожнеча, а не блок. Тримається окремо
     від `hover`, бо прямокутник у них спільний (де малювати), а от що саме
     малювати — рамку чи смугу виміру — вирішує саме це поле. */
  const [hoverGap, setHoverGap] = useState<Gap | null>(null)

  /* Чернетка тримає й сам елемент, а не лише його прямокутник: композер стоїть
     по центру, тож підсвітка лишилась єдиним показником «про що ця нота», і
     її треба переміряти на скролі й ресайзі — а для цього потрібен вузол.

     `gapRel` є лише в чернетці про проміжок. Порожнеча власного вузла не має,
     тож переміряти її на скролі можна тільки заново — від контейнера й точки
     всередині нього, збереженої у ЙОГО координатах. Ширина й висота лежать
     поруч як остача: якщо після ресайзу проміжку в цьому місці вже немає
     (розмітка перебудувалась), смуга просто їде за контейнером, а не зникає
     й не стрибає в кут екрана. */
  const [draft, setDraft] = useState<{
    capture: Capture
    el: Element
    anchor: Anchor
    gapRel: { x: number; y: number; w: number; h: number; cx: number; cy: number } | null
  } | null>(null)
  /* Кадр живе поруч із чернеткою, а не всередині неї: зйомка асинхронна й
     завершується вже після того, як поповер відкрито. */
  const [shot, setShot] = useState<Shot | null>(null)
  /* Кожній зйомці — свій номер. Результат, який дорезолвився вже після
     скасування чернетки, зміни роуту чи анмаунту, не має ні потрапляти в
     стан, ні тихо тримати blob-URL: номер більше не поточний, тож URL
     відкликається на місці. Ефект нижче до такого випадку не дістає —
     `setShot` після анмаунту це no-op, і URL не відкликав би ніхто. */
  const shotRun = useRef(0)
  /* Сама обіцянка зйомки, а не лише її результат у стані: відправка мусить
     мати що чекати, інакше вона бере те, що ВСТИГЛО опинитись у стані. */
  const shotJob = useRef<Promise<Blob | null>>(Promise.resolve(null))
  const [openId, setOpenId] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const [pins, setPins] = useState<Record<string, Anchor>>({})

  /* ── Чернетка не переживає зміну роуту ─────────────────────────────────
     `Overlay` при навігації не перемонтовується, приціл у відкритій чернетці
     вже вимкнено — отже клік по посиланню штатно веде на інший екран із
     живою чернеткою в руках. `submit` бере `location.href` у мить відправки,
     тож нота приїхала б із НОВИМ роутом і селектором зі СТАРОГО, а виконавець
     пішов би не туди. Скидання йде в рендері, а не в ефекті: це штатний
     спосіб React підправити стан на зміну пропа, без зайвого проходу і без
     набивання нових порушень set-state-in-effect. */
  const [seenPath, setSeenPath] = useState(pathname)
  if (pathname !== seenPath) {
    setSeenPath(pathname)
    setDraft(null)
    setShot(null)
    setOpenId(null)
    setAiming(false)
    setHover(null)
    setHoverGap(null)
  }

  /* ── The shadow host ────────────────────────────────────────────────────
     Built in a state initializer, not at module scope: the module must stay
     side-effect-free or the production build cannot drop it, and building it
     in an effect instead would mean a setState-in-effect (one wasted render,
     and the rule the repo already trips on elsewhere). A detached host is a
     legal portal target; the effect only has to attach and detach it, which
     also makes an HMR cycle leave nothing behind to stack a second overlay
     on. */
  /* Blob-URL прев'ю тримає памʼять доти, доки його не відкликати, а чернеток
     за сесію буває десятки. */
  useEffect(() => {
    if (shot?.status !== 'ready') return
    const url = shot.url
    return () => URL.revokeObjectURL(url)
  }, [shot])

  /* Закриття чернетки — завжди разом із кадром: лишений кадр показався б у
     наступній ноті як її власний. */
  const closeDraft = useCallback(() => {
    /* Зйомка в польоті теж закривається: інакше вона дорезолвиться вже без
       чернетки й лишить по собі і кадр у стані, і невідкликаний blob-URL. */
    shotRun.current += 1
    shotJob.current = Promise.resolve(null)
    setDraft(null)
    setShot(null)
  }, [])

  const [host] = useState(() => {
    const el = document.createElement('div')
    el.dataset.smnHost = ''
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;'
    el.attachShadow({ mode: 'open' })
    return el
  })
  const shadow = host.shadowRoot

  useEffect(() => {
    document.body.appendChild(host)
    return () => host.remove()
  }, [host])

  /* Ref не можна чіпати в рендері, тож друга половина скидання чернетки на
     зміну роуту — тут: зйомка, почата на попередньому екрані, стає нечинною
     й відкличе свій blob-URL сама. Анмаунт (перехід на "/", де оверлей
     повертає null, або цикл HMR) закривається тим самим. */
  useEffect(() => {
    shotJob.current = Promise.resolve(null)
    return () => {
      shotRun.current += 1
    }
  }, [pathname])

  const load = useCallback(async () => {
    try {
      /* Unfiltered on purpose. `pending` alone would hide the two states the
         reviewer most needs to see: the note an agent is holding right now, and
         the one that is already fixed and waiting to be looked at. A note leaves
         this list by being deleted, nothing else. */
      const res = await fetch(`${endpoint}/notes`, { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const data: Note[] = await res.json()
      setNotes(data)
      setOffline(false)
    } catch {
      /* The server is started by hand. Not running is a normal state, not an
         error worth a dialog — the launcher just says so. */
      setOffline(true)
      setNotes([])
    }
  }, [endpoint])

  /* Re-read on every route change (a note belongs to one screen) and on a slow
     poll, because the agent's questions arrive from outside this tab. */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void load()
    }
    /* The first read is queued rather than run inline: fetching straight from
       the effect body counts as a synchronous setState to the hooks lint, and
       a task's delay is invisible next to the request itself. */
    const first = setTimeout(tick, 0)
    const t = setInterval(tick, 8000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [load, pathname, search])

  /* Notes for THIS screen, matched on pathname only: the query carries view
     state (`?as=admin`, filters) that changes under the reviewer's feet, and a
     note that vanished because a tab changed would look like data loss.
     Oldest first so the pin numbers do not renumber when a note is added. */
  const pageNotes = useMemo(() => {
    const mine = notes.filter((n) => {
      try {
        return new URL(n.url).pathname === pathname
      } catch {
        return false
      }
    })
    return mine.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }, [notes, pathname])

  /* Two tallies, because they are two different jobs for the reviewer: answer a
     question, or go look at a fix. Summing them into one "needs you" number
     would hide which one it is, and they are not interchangeable. */
  const waiting = useMemo(() => pageNotes.filter(awaitsHuman).length, [pageNotes])
  const done = useMemo(() => pageNotes.filter((n) => n.status === 'resolved').length, [pageNotes])
  const openNote = useMemo(() => pageNotes.find((n) => n.id === openId) ?? null, [pageNotes, openId])

  /* ── Коли кнопки списку немає взагалі ──────────────────────────────────
     Порожній список нема чого відкривати, а «0» на смужці — шум, який щоразу
     повідомляє, що нічого не сталось. Тому при нулі зникає САМА кнопка, а не
     лише її число.

     Виняток — сервер не відповідає. Тоді нот теж нуль, але причина інша, і
     панель списку лишається єдиним місцем, де про це взагалі написано; забрати
     кнопку означало б сховати єдину діагностику разом із порожнечею.

     Розпірки на місці кнопки навмисно немає (щойно такі прибирали). Замість
     неї — порядок: кнопка списку стоїть ПЕРШОЮ, а смужка притиснута до
     правого краю, тож її поява й зникнення рухають лише власний лівий край
     смужки. Приціл і тема при цьому не змінюють екранної позиції ні на
     піксель — а саме на них лягає мʼязова памʼять. */
  const showList = offline || pageNotes.length > 0

  /* ── Pin geometry ──────────────────────────────────────────────────────
     Recomputed on scroll and resize, rAF-throttled. Elements that no longer
     resolve simply get no pin; the list still shows the note and says so. */
  useEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      const next: Record<string, Anchor> = {}
      for (const n of pageNotes) {
        const el = resolveElement(n)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (!r.width && !r.height) continue
        next[n.id] = { x: r.left, y: r.top, w: r.width, h: r.height }
      }
      setPins(next)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    schedule()
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [pageNotes])

  /* ── Subject geometry ──────────────────────────────────────────────────
     Той самий rAF-трюк, що й для пінів, але для одного елемента — того, на
     який щойно тицьнули. Композер по центру нікуди не їде, а сторінка під ним
     їде, тож без цього підсвітка відклеїлась би від свого елемента при
     першому ж скролі. */
  const draftEl = draft?.el ?? null
  const draftRel = draft?.gapRel ?? null
  useEffect(() => {
    if (!draftEl) return
    let frame = 0
    const measure = () => {
      frame = 0
      const r = draftEl.getBoundingClientRect()
      let next: Anchor
      if (draftRel) {
        /* Порожнечу переміряємо тією самою функцією, що й при наведенні —
           другого алгоритму тут не заводиться. Точка береться з памʼяті у
           координатах контейнера, тож після скролу вона потрапляє туди ж, де
           стояв курсор при кліку. */
        const g = measureGap(draftEl, r.left + draftRel.cx, r.top + draftRel.cy, false)
        next = g
          ? { x: g.rect.x, y: g.rect.y, w: g.rect.w, h: g.rect.h }
          : { x: r.left + draftRel.x, y: r.top + draftRel.y, w: draftRel.w, h: draftRel.h }
      } else {
        next = { x: r.left, y: r.top, w: r.width, h: r.height }
      }
      setDraft((cur) => (cur && cur.el === draftEl ? { ...cur, anchor: next } : cur))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [draftEl, draftRel])

  /* ── Aim mode ──────────────────────────────────────────────────────────
     Listeners live on the document in the CAPTURE phase, not on a full-screen
     catcher: the catcher would swallow elementFromPoint (it would return the
     catcher every time) and the app's own handlers must never see the picking
     click. The cursor is set on <body> because a shadow rule cannot reach it;
     it is restored on exit, including the unmount path. */
  useEffect(() => {
    if (!aiming) return

    const track = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (!el || host.contains(el) || el === document.documentElement) return
      /* Дешевий прохід: селектори тут не будуються (`deep: false`), бо це
         рух миші, а `buildSelector` ходить по всьому документу. Прицілу
         досить властивості й числа. */
      const gap = measureGap(el, e.clientX, e.clientY, false)
      const r = el.getBoundingClientRect()
      setHover(
        gap
          ? { x: gap.rect.x, y: gap.rect.y, w: gap.rect.w, h: gap.rect.h }
          : { x: r.left, y: r.top, w: r.width, h: r.height },
      )
      setHoverGap(gap)
      setHoverTag(describe(el))
    }

    const pick = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (!el || host.contains(el)) return
      e.preventDefault()
      e.stopPropagation()
      const r = el.getBoundingClientRect()
      /* А тут — повний прохід: селектори сусідів і носіїв декларацій це те,
         заради чого нота про проміжок узагалі існує. */
      const gap = measureGap(el, e.clientX, e.clientY, true)
      setDraft({
        capture: gap ? captureGap(el, gap) : capture(el),
        el,
        anchor: gap
          ? { x: gap.rect.x, y: gap.rect.y, w: gap.rect.w, h: gap.rect.h }
          : { x: r.left, y: r.top, w: r.width, h: r.height },
        gapRel: gap
          ? {
              x: gap.rect.x - r.left,
              y: gap.rect.y - r.top,
              w: gap.rect.w,
              h: gap.rect.h,
              cx: gap.rect.x + gap.rect.w / 2 - r.left,
              cy: gap.rect.y + gap.rect.h / 2 - r.top,
            }
          : null,
      })
      setOpenId(null)
      setAiming(false)
      setHover(null)
      setHoverGap(null)

      /* Кадр знімається в мить кліку, а не при відправці: до моменту, коли
         користувач допише текст, сторінка вже могла доїхати анімацію, згорнути
         тултип чи перемалюватись після ре-рендера — і кадр показав би не те,
         на що дивилась людина. Зйомка нічого не блокує: не вдалась — нота
         поїде без неї. */
      setShot({ status: 'taking' })
      const run = shotRun.current + 1
      shotRun.current = run
      /* Субʼєкт кадру для проміжку — не контейнер, а сама порожнеча РАЗОМ із
         сусідами: контейнером тут часто виявляється пів сторінки, а дірка сама
         по собі в кадрі не читається. */
      shotJob.current = takeShot(gap ? gap.context : el, host).then(
        (ready) => {
          /* Чужий номер означає, що чернетки вже немає (скасування, зміна
             роуту, анмаунт) — прев'ю нікому показувати, тож URL відкликається
             тут-таки, інакше його не відкличе ніхто. Сам blob повертається
             все одно: за ним ще може прийти запізніла заливка кадру. */
          if (shotRun.current === run) setShot({ status: 'ready', ...ready })
          else URL.revokeObjectURL(ready.url)
          return ready.blob
        },
        (e: unknown) => {
          if (shotRun.current === run) {
            setShot({ status: 'failed', reason: e instanceof Error ? e.message : 'capture failed' })
          }
          return null
        },
      )
    }

    const swallow = (e: MouseEvent) => {
      /* mousedown/mouseup would still reach the app and start a drag, open a
         menu, or navigate before the click ever fires. */
      if (host.contains(e.target as Node)) return
      e.preventDefault()
      e.stopPropagation()
    }

    const prevCursor = document.body.style.cursor
    document.body.style.cursor = 'crosshair'
    document.addEventListener('mousemove', track, true)
    document.addEventListener('mousedown', swallow, true)
    document.addEventListener('mouseup', swallow, true)
    document.addEventListener('click', pick, true)
    return () => {
      document.body.style.cursor = prevCursor
      document.removeEventListener('mousemove', track, true)
      document.removeEventListener('mousedown', swallow, true)
      document.removeEventListener('mouseup', swallow, true)
      document.removeEventListener('click', pick, true)
    }
  }, [aiming, host])

  /* Alt+A aims, Alt+N opens the index, Esc backs out of whatever is open.
     Alt because Ctrl/Cmd combinations of two letters are all spoken for by the
     browser, and this has to work on a machine that is not the developer's. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAiming(false)
        setHover(null)
        setHoverGap(null)
        closeDraft()
        setOpenId(null)
        return
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const k = e.key.toLowerCase()
      if (k === 'a') {
        e.preventDefault()
        closeDraft()
        setOpenId(null)
        setAiming((v) => !v)
      } else if (k === 'n') {
        e.preventDefault()
        /* Хоткей робить рівно те, що кнопка, і зникає разом із нею: панель,
           яку не можна відкрити мишею, але можна клавішею, — це другий,
           непомітний стан тулзи. Уже відкриту панель Alt+N закриває завжди,
           бо інакше остання нота, видалена при відкритій панелі, замкнула б
           її на екрані до Esc. */
        setListOpen((v) => (v ? false : showList))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeDraft, showList])

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(THEME_KEY, next)
      } catch {
        /* the choice just does not survive the reload */
      }
      return next
    })
  }, [])

  /* ── Writes ────────────────────────────────────────────────────────────
     Truncation happens here, on this side of the wire, because the server
     answers 400 rather than trimming. */
  const submit = useCallback(
    async (text: string, c: Capture, job: Promise<Blob | null>) => {
      const id = newId()

      /* ── Чому кадр чекається ДО створення ноти ─────────────────────────
         `POST /notes` миттєво будить сторожа, той робить один `GET /notes` і
         одразу запускає виконавця. Заливка PNG на кілька мегабайт по LAN цю
         гонку майже завжди програє, тож у бриф їде варіант без кадру — при
         тому, що кадр знято. Губиться не файл, а весь сенс фічі: виконавець
         працює наосліп.

         Тому порядок такий: спершу коротке очікування зйомки, і лише потім
         нота. Стеля — пʼять секунд, і це саме СТЕЛЯ, а не очікування: не
         встиг — нота йде без кадру, а заливка добігає окремо й прикріпиться
         пізніше. Правило «кадр ніколи не блокує ноту» лишається чинним. */
      const settled = await Promise.race([
        job.catch(() => null),
        new Promise<Blob | null | undefined>((r) => setTimeout(() => r(undefined), SHOT_WAIT_MS)),
      ])
      const timedOut = settled === undefined
      const frame = settled ?? null
      const body = {
        id,
        createdAt: new Date().toISOString(),
        note: cut(text.trim(), MAX_NOTE),
        url: location.href,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        selector: c.selector,
        fullPath: c.fullPath,
        tagName: c.tagName,
        classes: c.classes,
        text: c.text,
        outerHTML: c.outerHTML,
        rect: c.rect,
        components: c.components.slice(0, MAX_COMPONENTS),
        /* Поля або немає, або воно повне — проміжного стану контракт не знає.
           Розсипати `spacing: null` у звичайні ноти означало б навчити читачів
           перевіряти його на кожній, і ознака «це нота про порожнечу» перестала
           б бути ознакою. */
        ...(c.spacing ? { spacing: c.spacing } : {}),
      }
      const res = await fetch(`${endpoint}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await errorOf(res))

      /* Кадр — ОКРЕМИМ запитом і після ноти: він у сотні разів важчий за JSON,
         має власний ліміт на сервері й власні способи не вдатись. Помилка тут
         навмисно не піднімається — нота вже на сервері, і показати через неї
         «send failed» означало б збрехати користувачу й змусити писати вдруге.
         Слід лишається в консолі, а в ноті — `shot: null`. */
      const upload = async (blob: Blob | null) => {
        if (!blob) return
        try {
          const shotRes = await fetch(`${endpoint}/notes/${encodeURIComponent(id)}/shot`, {
            method: 'POST',
            headers: { 'Content-Type': 'image/png' },
            body: blob,
          })
          if (!shotRes.ok) console.warn('[notes] frame not stored:', await errorOf(shotRes))
        } catch (e) {
          console.warn('[notes] frame not sent:', e)
        }
      }

      if (timedOut) {
        /* Не дочекались за стелю — нота вже пішла, а заливка добігає як є:
           кадр прикріпиться до тієї самої ноти, просто пізніше. Чекати на неї
           тут нема сенсу, композер закривається одразу. */
        void job.then(upload, () => {})
      } else {
        await upload(frame)
      }

      await load()
    },
    [endpoint, load],
  )

  const reply = useCallback(
    async (id: string, content: string) => {
      const res = await fetch(`${endpoint}/notes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: { role: 'human', content: cut(content.trim(), MAX_CONTENT) } }),
      })
      if (!res.ok) throw new Error(await errorOf(res))
      await load()
    },
    [endpoint, load],
  )

  const remove = useCallback(
    async (id: string) => {
      const res = await fetch(`${endpoint}/notes/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(await errorOf(res))
      setOpenId(null)
      await load()
    },
    [endpoint, load],
  )

  if (!shadow) return null

  const indexOf = (id: string) => pageNotes.findIndex((n) => n.id === id) + 1

  return createPortal(
    <>
      <style>{CSS_TEXT}</style>
      <div className="smn" data-theme={theme}>
        {aiming &&
          hover &&
          (hoverGap ? (
            <GapBand box={hover} spacing={hoverGap.spacing} tag={hoverTag} />
          ) : (
            <div className="smn-aim" style={{ left: hover.x, top: hover.y, width: hover.w, height: hover.h }}>
              <span className={`smn-aim__tag${hover.y < 24 ? ' smn-aim__tag--below' : ''}`}>{hoverTag}</span>
            </div>
          ))}
        {/* Поки пишеться нота, обраний предмет лишається підсвіченим: коробка
            відʼїхала в центр, і без підсвітки нічого не каже, про що вона.
            Смуга виміру тут тим паче обовʼязкова — порожнечу без неї не видно
            взагалі, а число лишається єдиним, що привʼязує текст до місця. */}
        {draft &&
          (draft.capture.spacing ? (
            <GapBand box={draft.anchor} spacing={draft.capture.spacing} />
          ) : (
            <div
              className="smn-aim smn-aim--subject"
              style={{ left: draft.anchor.x, top: draft.anchor.y, width: draft.anchor.w, height: draft.anchor.h }}
            />
          ))}
        {/* Pins live above the aim outline but below the panels. */}
        {!aiming &&
          pageNotes.map((n) => {
            const p = pins[n.id]
            if (!p) return null
            const wait = awaitsHuman(n)
            const state =
              n.status === 'working' ? ' smn-pin--working' : n.status === 'resolved' ? ' smn-pin--done' : ''
            /* The hover title says the state first and the note second: on a
               screen with four pins the state is what is being looked for. */
            const label = `${STATE_LABEL[n.status]}${wait ? ' · agent asked' : ''}`
            return (
              <button
                key={n.id}
                type="button"
                className={`smn-pin${state}${openId === n.id ? ' smn-pin--open' : ''}${wait ? ' smn-pin--wait' : ''}`}
                style={{ left: p.x, top: p.y }}
                title={`${label} — ${n.note}`}
                aria-label={`Note ${indexOf(n.id)}, ${label}`}
                onClick={() => {
                  closeDraft()
                  setOpenId((cur) => (cur === n.id ? null : n.id))
                }}
              >
                {indexOf(n.id)}
              </button>
            )
          })}

        {draft && (
          <Composer
            capture={draft.capture}
            shot={shot}
            onCancel={closeDraft}
            onSend={async (text) => {
              await submit(text, draft.capture, shotJob.current)
              closeDraft()
            }}
          />
        )}

        {openNote && (
          <Thread
            note={openNote}
            index={indexOf(openNote.id)}
            anchor={pins[openNote.id] ?? { x: window.innerWidth - 360, y: 60, w: 0, h: 0 }}
            onClose={() => setOpenId(null)}
            onReply={(text) => reply(openNote.id, text)}
            onDelete={() => remove(openNote.id)}
          />
        )}

        {listOpen && (
          <div className="smn-pop smn-list" role="dialog" aria-label="Notes on this screen">
            <div className="smn-head">
              <span className="smn-title">Notes on this screen</span>
              <button type="button" className="smn-x" onClick={() => setListOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            {offline ? (
              <div className="smn-empty">
                <b>Notes server is not responding</b>
                Start it: <span className="smn-kbd">node comments-harness/server/notes-server.mjs</span>
              </div>
            ) : pageNotes.length === 0 ? (
              <div className="smn-empty">
                <b>Nothing here yet</b>
              </div>
            ) : (
              <div className="smn-rows smn-scroll">
                {pageNotes.map((n, i) => {
                  const wait = awaitsHuman(n)
                  const lost = !pins[n.id]
                  return (
                    <button
                      key={n.id}
                      type="button"
                      className={`smn-row${n.status === 'resolved' ? ' smn-row--done' : ''}${wait ? ' smn-row--wait' : ''}`}
                      onClick={() => {
                        setDraft(null)
                        setOpenId(n.id)
                        const el = resolveElement(n)
                        el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                      }}
                    >
                      <span className="smn-row__n">{i + 1}</span>
                      <span className="smn-row__body">
                        <span className="smn-row__txt">{n.note}</span>
                        <span className="smn-row__meta">
                          <StateChip status={n.status} />
                          {wait && <AskedChip />}
                          <span className="smn-row__tail">
                            {shortTime(n.updatedAt)}
                            {' · '}
                            {/* Нота про проміжок мусить упізнаватись у списку:
                                інакше «зменшити тут» у переліку виглядає так
                                само, як нота про блок із тим самим селектором. */}
                            {n.spacing ? `${n.spacing.px}px space · ` : ''}
                            {n.selector || n.tagName || 'no selector'}
                            {lost ? ' · element not found' : ''}
                          </span>
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <div className="smn-bar">
          {/* Першою й лише за наявності того, що відкривати — див. showList вище. */}
          {showList && (
            <>
              <button
                type="button"
                className="smn-btn"
                aria-pressed={listOpen}
                title="Notes on this screen (Alt+N)"
                onClick={() => setListOpen((v) => !v)}
              >
                <IconList />
                <span className="smn-count">
                  {offline ? (
                    '—'
                  ) : (
                    <>
                      {pageNotes.length}
                      {done > 0 && (
                        <span className="smn-count__part smn-count__part--done" title="Fixed, waiting for your look">
                          {done}
                        </span>
                      )}
                      {waiting > 0 && (
                        <span className="smn-count__part smn-count__part--wait" title="Agent asked and is waiting">
                          {waiting}
                        </span>
                      )}
                    </>
                  )}
                </span>
              </button>
              <span className="smn-sep" />
            </>
          )}
          <button
            type="button"
            className="smn-btn"
            aria-pressed={aiming}
            title="Aim at an element (Alt+A)"
            onClick={() => {
              setDraft(null)
              setOpenId(null)
              setAiming((v) => !v)
            }}
          >
            <IconAim />
          </button>
          <span className="smn-sep" />
          <button
            type="button"
            className="smn-btn"
            title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '☾' : '☀'}
          </button>
        </div>
      </div>
    </>,
    shadow,
  )
}

/* The server always answers `{"error":"…"}`, never HTML — surface it verbatim
   rather than a status code, because the message names the field. */
async function errorOf(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (body && typeof body.error === 'string') return body.error
  } catch {
    /* fall through to the status line */
  }
  return `HTTP ${res.status}`
}

/* ── Composer ─────────────────────────────────────────────────────────────
   One field. Everything else on this panel is the evidence of WHAT was picked,
   because the most common failure of a note is that it points at the wrong
   element and nobody noticed until the fix landed. */
function Composer({
  capture: c,
  shot,
  onCancel,
  onSend,
}: {
  capture: Capture
  shot: Shot | null
  onCancel: () => void
  onSend: (text: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const t = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(t)
  }, [])

  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await onSend(text)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'send failed')
      setBusy(false)
    }
  }

  return (
    <div className="smn-center">
      <div className="smn-pop smn-pop--center" role="dialog" aria-label={c.spacing ? 'New spacing note' : 'New note'}>
        <div className="smn-head">
          {/* Заголовок називає предмет, а не дію: «нову ноту» користувач і так
              бачить, а от чи анотує він картку чи дірку між картками — ні. */}
          <span className="smn-title">{c.spacing ? 'New spacing note' : 'New note'}</span>
          <button type="button" className="smn-x" onClick={onCancel} aria-label="Cancel">
            ✕
          </button>
        </div>
        {/* Докази — селектор і кадр — їдуть у прокрутці, поле й кнопки лишаються
            на місці: кадр буває високим, а «куди писати» не має ховатись за
            краєм коробки на низькому екрані. */}
        <div className="smn-scroll">
          <div className={`smn-target${c.selector ? '' : ' smn-target--none'}`}>
            {c.spacing && <SpacingTarget spacing={c.spacing} />}
            {c.selector || `${c.tagName} — no unique selector, path only`}
            {c.components.length > 0 && <span className="smn-chain">{c.components.join(' ‹ ')}</span>}
          </div>
          {/* Кадр тут не редагують і не обводять — на нього дивляться, щоб
              побачити, що саме поїде агенту. Невдача каже про себе рядком і нічим
              не заважає: нота відправляється точно так само. */}
          {shot?.status === 'ready' && <img className="smn-shot" src={shot.url} alt="Frame of the picked element" />}
          {shot?.status === 'taking' && <div className="smn-shot smn-shot--wait">Capturing the frame…</div>}
          {shot?.status === 'failed' && <div className="smn-shot smn-shot--none">No frame — the note goes without it</div>}
        </div>
        <textarea
          ref={ref}
          className="smn-note"
          rows={4}
          maxLength={MAX_NOTE}
          placeholder="What is wrong and how it should be"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
          }}
        />
        <div className="smn-foot">
          {err ? (
            <span className="smn-err">{err}</span>
          ) : (
            <span className="smn-hintline">⌘/Ctrl + ⏎</span>
          )}
          <button type="button" className="smn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="smn-primary" disabled={busy || !text.trim()} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Thread ───────────────────────────────────────────────────────────────
   Two-way on purpose: an agent that cannot ask "всю плитку чи лише підпис?"
   guesses, and a guess costs a whole round trip.

   Delete is still the close. `resolved` is not it: it is the agent saying the
   fix is in, which makes the note the reviewer's to check, and only the check
   ends it. Nothing here writes a status — the three states are read, never set,
   because the agent owns them. */
function Thread({
  note,
  index,
  anchor,
  onClose,
  onReply,
  onDelete,
}: {
  note: Note
  index: number
  anchor: Anchor
  onClose: () => void
  onReply: (text: string) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const wait = awaitsHuman(note)

  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await onReply(text)
      setText('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'send failed')
    }
    setBusy(false)
  }

  const del = async () => {
    if (!confirmDel) {
      setConfirmDel(true)
      return
    }
    setBusy(true)
    setErr('')
    try {
      await onDelete()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete failed')
      setBusy(false)
    }
  }

  return (
    <div className="smn-pop" style={popoverStyle(anchor, 340)} role="dialog" aria-label={`Note ${index}`}>
      <div className="smn-head">
        <span className="smn-title">Note {index}</span>
        <StateChip status={note.status} />
        {wait && <AskedChip />}
        <button type="button" className="smn-x" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className={`smn-target${note.selector ? '' : ' smn-target--none'}`}>
        {note.spacing && <SpacingTarget spacing={note.spacing} />}
        {note.selector || note.fullPath}
        {note.components.length > 0 && <span className="smn-chain">{note.components.join(' ‹ ')}</span>}
      </div>

      <div className="smn-scroll">
        <p className="smn-said smn-said--first">
          <span className="smn-said__who">
            <span>you</span>
            <span>{shortTime(note.createdAt)}</span>
          </span>
          {note.note}
        </p>
        {note.thread.map((m, i) => (
          <p key={`${m.at}-${i}`} className={`smn-said${m.role === 'agent' ? ' smn-said--agent' : ''}`}>
            <span className="smn-said__who">
              <span>{m.role === 'agent' ? 'agent' : 'you'}</span>
              <span>{shortTime(m.at)}</span>
            </span>
            {m.content}
          </p>
        ))}
      </div>

      <textarea
        className="smn-note"
        style={{ marginTop: 8 }}
        rows={wait ? 3 : 2}
        maxLength={MAX_CONTENT}
        placeholder={wait ? 'Reply to the agent' : 'Add to the note'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
        }}
      />
      <div className="smn-foot">
        <button
          type="button"
          className="smn-danger"
          disabled={busy}
          onClick={() => void del()}
          onBlur={() => setConfirmDel(false)}
          title="Closing a note deletes it: history lives in fixlog"
        >
          {confirmDel ? 'Delete for sure?' : 'Delete'}
        </button>
        {err ? <span className="smn-err">{err}</span> : <span className="smn-foot__spacer" />}
        <button type="button" className="smn-primary" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Reply'}
        </button>
      </div>
    </div>
  )
}
