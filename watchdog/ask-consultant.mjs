#!/usr/bin/env node
/*
  Консультація: виконавець питає, консультант вирішує.

  Проблема, яку це знімає. Виконавець, якому неясно *як має бути*, дописував
  питання в тред і повертав ноту в `pending` — і вона стояла, доки людина не
  відповість. Конвеєр, заведений щоб прибрати людину з кінця `notes_watch`,
  повертав її ж у середину, і найдорожча пауза була саме тут: не в правці, а
  в очікуванні одного речення.

  Тепер питання йде не до людини, а до консультанта — сильної моделі, яка
  нічого не править, а лише ухвалює рішення. Виконавець отримує рішення на
  stdout і виконує його в тому ж прогоні; нота не зупиняється.

  Запуск (це робить ВИКОНАВЕЦЬ, не сторож):

      node comments-harness/watchdog/ask-consultant.mjs <id-ноти> "<питання>"

  Питання можна віддати й через stdin, якщо воно довге або багаторядкове.

  Коди виходу — контракт із виконавцем, і він письмовий у брифі:
    0 — рішення на stdout, роби його;
    1 — консультації не сталося (консультант упав, сплив таймаут, вимкнено).
        Виконавець НЕ зависає: вирішує сам і каже це у звіті. Обґрунтування
        просте — нота вже в роботі, репозиторій уже може бути змінений, і
        повертати її в `pending` посеред правки гірше, ніж ухвалити рішення
        з тим, що є, і назвати його вголос;
    2 — покликали неправильно (немає id чи питання, ноти не існує). Це не
        обставина, а помилка, і мовчки лікувати її не треба.

  Слід лишається у двох місцях, обидва навмисно:
    - рядок у `dispatcher.log` — той самий лог, що й у сторожа, бо читають
      його разом: скільки консультацій, на яких нотах, по скільки секунд;
    - запис у `data/consults/<id>.json` — його сторож підбирає, закриваючи
      правку, і кладе в `fix.json` поруч із рішенням класифікатора. Через
      день роботи буде видно цифри, а не здогадки про ціну.

  І сама консультація дописується в тред ноти ОДНИМ повідомленням із роллю
  `human` і префіксом `[<модель>, консультація]`. Роль саме `human`: контракт
  :4747 знає лише `agent`/`human`, розширювати його заради цього не варто, а
  рішення тут ухвалила сторона, що вирішує. Плюс практичне: останнє слово за
  агентом означає «чекаємо людину», і нота знову б зупинилась.

  Нуль npm-залежностей, як і решта теки.
*/
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import config from '../config.mjs'
import { readTemplate, renderTemplate } from './template.mjs'

const HERE = import.meta.dirname
const HARNESS = path.resolve(HERE, '..')
const DATA_DIR = path.join(HARNESS, 'data')
const CONSULTS_DIR = path.join(DATA_DIR, 'consults')
const LOG_FILE = path.join(HERE, 'dispatcher.log')
const NOTES_URL = process.env.NOTES_URL || `http://127.0.0.1:${config.notesPort}`

const C = config.consultant

/* Лог спільний зі сторожем і формат той самий: час, подія, id, суть. Читають
   їх разом, тож другий файл означав би зшивати дві стрічки очима. */
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    /* лог не має права вбити консультацію */
  }
  process.stderr.write(line)
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim()

async function api(method, urlPath, body, timeoutMs = 15_000) {
  const res = await fetch(`${NOTES_URL}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/* ── Промпт ─────────────────────────────────────────────────────────────── */

/* Контекст беремо з самої ноти, а не з переказу виконавця: переказ уже раз
   пройшов через того, хто не зрозумів, і другий переказ додав би тільки шуму. */
function buildPrompt(note, question) {
  const tpl = readTemplate(path.join(HERE, C.template))
  const thread = (note.thread || []).length
    ? note.thread.map((m) => `- **${m.role}** (${m.at}): ${m.content}`).join('\n')
    : '_порожній — користувач нічого не уточнював_'
  let route = '—'
  try {
    route = new URL(note.url).pathname
  } catch {
    /* кривий url — роуту немає, це не привід не питати */
  }
  const values = {
    ID: note.id,
    URL: note.url,
    ROUTE: route,
    SELECTOR: note.selector,
    FULLPATH: note.fullPath,
    TAGNAME: note.tagName,
    CLASSES: note.classes,
    TEXT: note.text,
    COMPONENTS: (note.components || []).join(' → '),
    NOTE: note.note,
    THREAD: thread,
    QUESTION: question,
    OUTERHTML: note.outerHTML,
  }
  /* Кадр — лише якщо файл справді на місці: впевнене «відкрий цей PNG» без
     PNG коштує кількох марних `Read` і здогадки замість кадру. */
  if (note.shot) {
    const abs = path.join(DATA_DIR, note.shot)
    if (fs.existsSync(abs)) values.SHOT = abs
  }
  const sp = note.spacing
  if (sp && typeof sp === 'object') {
    const between = Array.isArray(sp.between) ? sp.between : [null, null]
    const side = (v) => (v ? `\`${v}\`` : '`(кромка)`')
    const sources = Array.isArray(sp.sources) ? sp.sources : []
    values.SPACING = 'yes'
    values.SPACING_PX = sp.px
    values.SPACING_AXIS = sp.axis
    values.SPACING_BETWEEN = `${side(between[0])} і ${side(between[1])}`
    values.SPACING_SOURCES = sources.length
      ? sources.map((x) => `\`${x.property}: ${x.value}\` на \`${x.selector || '?'}\``).join('; ')
      : 'оверлей не назвав джерело'
  }
  return renderTemplate(tpl, values)
}

/* ── Прогін консультанта ────────────────────────────────────────────────── */

/* Свій таймаут, окремий від таймауту прогону. Консультант, що думає довше за
   саму правку, — це не консультація, а зупинка; краще хай виконавець вирішує
   сам і напише це у звіт. */
function runConsultant(prompt) {
  return new Promise((resolve) => {
    const argv = C.args.map((a) => a.replaceAll('{{PROMPT}}', prompt).replaceAll('{{MODEL}}', C.model))
    let child
    try {
      child = spawn(C.command, argv, {
        cwd: config.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: `${config.prefix}-consultant` },
      })
    } catch (err) {
      resolve({ ok: false, why: `не запустився: ${err.message}` })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* уже помер сам */
      }
      finish({ ok: false, why: `не вклався у ${C.timeoutS} с` })
    }, C.timeoutS * 1000)
    child.stdout.on('data', (b) => {
      out += b
      if (out.length > 20000) out = out.slice(0, 20000)
    })
    child.stderr.on('data', (b) => {
      err += b
      if (err.length > 2048) err = err.slice(0, 2048)
    })
    child.on('error', (e) => finish({ ok: false, why: `не запустився: ${e.message}` }))
    child.on('close', (code) => {
      const text = out.trim()
      if (code !== 0) {
        finish({ ok: false, why: `вийшов з кодом ${code}${err ? `: ${oneLine(err)}` : ''}` })
        return
      }
      if (!text) {
        finish({ ok: false, why: 'відповів порожнечею' })
        return
      }
      finish({ ok: true, decision: text })
    })
  })
}

/* ── Слід ───────────────────────────────────────────────────────────────── */

/* Запис поруч зі стором, а не в теку правки: теки ще немає — вона зʼявиться,
   коли сторож закриватиме ноту, і саме тоді він цей файл підбере. */
function remember(id, record) {
  try {
    fs.mkdirSync(CONSULTS_DIR, { recursive: true })
    const file = path.join(CONSULTS_DIR, `${id}.json`)
    let all = []
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(prev)) all = prev
    } catch {
      /* немає файлу або він побитий — починаємо список заново */
    }
    all.push(record)
    fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`)
  } catch (err) {
    log(`УВАГА КОНСУЛЬТАЦІЯ ${id} · не записали слід: ${err.message}`)
  }
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main() {
  const [id, ...rest] = process.argv.slice(2)
  const question = (rest.join(' ') || readStdin()).trim()
  if (!id || !question) {
    console.error(
      'Виклик: node comments-harness/watchdog/ask-consultant.mjs <id-ноти> "<питання>"\n' +
        '(питання можна віддати й через stdin)',
    )
    process.exit(2)
  }

  if (!C.enabled) {
    console.log(
      'Консультації вимкнено в конфізі. Вирішуй сам і скажи у звіті, що саме вирішив і чому.',
    )
    process.exit(1)
  }

  let note
  try {
    note = (await api('GET', '/notes')).find((n) => n.id === id) || null
  } catch (err) {
    console.log(`Сервер нот недоступний (${err.message}). Вирішуй сам і скажи це у звіті.`)
    log(`ЗБІЙ КОНСУЛЬТАЦІЯ ${id} · сервер нот недоступний: ${err.message}`)
    process.exit(1)
  }
  if (!note) {
    console.error(`Ноти ${id} немає у сторі — перевір id.`)
    process.exit(2)
  }

  const startedAt = Date.now()
  log(`КОНСУЛЬТАЦІЯ ${id} · ${C.model} · «${oneLine(question).slice(0, 120)}»`)
  const verdict = await runConsultant(buildPrompt(note, question))
  const ms = Date.now() - startedAt
  const secs = (ms / 1000).toFixed(1)

  if (!verdict.ok) {
    remember(id, {
      at: new Date().toISOString(),
      ms,
      model: C.model,
      ok: false,
      question: oneLine(question).slice(0, 500),
      why: verdict.why,
    })
    log(`ЗБІЙ КОНСУЛЬТАЦІЯ ${id} · ${secs}с · ${verdict.why}`)
    console.log(
      `Консультант не відповів (${verdict.why}). Не зупиняйся: ухвали рішення сам, ` +
        'зроби правку і напиши у звіті, що консультація не вдалася і що ти вирішив.',
    )
    process.exit(1)
  }

  /* Тред — одним повідомленням: питання і рішення разом. Двома вони
     розʼїжджаються в історії, і через місяць не видно, що на що відповідь. */
  const entry =
    `[${C.model}, консультація]\n` + `Питання: ${question}\n` + `Рішення: ${verdict.decision}`
  try {
    await api('PATCH', `/notes/${id}`, { reply: { role: 'human', content: entry } })
  } catch (err) {
    /* Рішення вже є, і воно важливіше за запис у тред: віддаємо виконавцю,
       а про незаписане кажемо в лог. */
    log(`УВАГА КОНСУЛЬТАЦІЯ ${id} · рішення є, але в тред не лягло: ${err.message}`)
  }

  remember(id, {
    at: new Date().toISOString(),
    ms,
    model: C.model,
    ok: true,
    question: oneLine(question).slice(0, 500),
    decision: oneLine(verdict.decision).slice(0, 1000),
  })
  log(`ГОТОВО КОНСУЛЬТАЦІЯ ${id} · ${secs}с · «${oneLine(verdict.decision).slice(0, 120)}»`)
  console.log(verdict.decision)
}

main().catch((err) => {
  log(`ЗБІЙ КОНСУЛЬТАЦІЯ · ${err.stack || err.message}`)
  console.log(`Консультація зірвалась (${err.message}). Вирішуй сам і скажи це у звіті.`)
  process.exit(1)
})
