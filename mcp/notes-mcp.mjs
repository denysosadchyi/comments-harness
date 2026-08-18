/* LOCAL ONLY — lives in `comments-harness/`, which .git/info/exclude keeps out of git.
   Dev tooling, never product code; nothing in the app imports it, and Vite
   ignores it (the overlay glob matches `./dev/*.local.tsx`, this is `.mjs`).

   What it is: the MCP stdio bridge between Claude and the note server on
   :4747, replacing the third-party `agentation-mcp` that was removed. Three
   processes share one contract (`comments-harness/docs/contract.md`) — the server, the
   in-page overlay, and this. The server owns the data and arbitrates the
   contract; this file owns NO state whatsoever. Every tool call is one HTTP
   request and back. That is the whole design: if the bridge ever cached a note
   list, a queue that moved in the browser would be invisible here until the
   cache expired, and the agent would confidently work on a note the user had
   already closed.

   ── Why no `@modelcontextprotocol/sdk` ────────────────────────────────────
   The brief allowed either the SDK via `npm install --no-save` or a hand-
   written protocol, and this is hand-written. Reasoning:

   - `--no-save` deliberately keeps the package out of `package.json` (it is a
     dev tool, not a product dependency), which makes it *extraneous* — and the
     next plain `npm install` prunes extraneous packages. So the SDK route ends
     with a bridge that silently stops booting after any unrelated dependency
     change, with a `ERR_MODULE_NOT_FOUND` surfacing inside Claude's MCP
     startup where nobody is looking. `notes-server.mjs` already chose zero
     dependencies for exactly this reason, and a bridge more fragile than the
     server it fronts is the wrong trade.
   - What the SDK would actually save here is small: stdio MCP is newline-
     delimited JSON-RPC 2.0 with four methods that matter (`initialize`,
     `notifications/initialized`, `tools/list`, `tools/call`). That is the ~80
     lines below, and they are lines that never change.

   If a future need does pull the SDK in, restore it with:
       npm install --no-save @modelcontextprotocol/sdk
   (and re-run that after every `npm install`, which prunes it again).

   ── Why the output of `notes_pending` is text, not JSON ───────────────────
   A raw note is ~15 fields, most of them (`outerHTML`, `rect`, `viewport`,
   `classes`) irrelevant to deciding what to fix. Dumping the array costs
   hundreds of tokens per note and still leaves the agent to work out which
   parts matter. The compact rendering below carries exactly what a fix needs —
   where (url + selector), what (the element and its component chain), and what
   was asked (the note plus the thread) — so the agent can start work from the
   listing without a follow-up `notes_get`. `notes_get` remains for the case
   where the full record genuinely matters. */

import { createInterface } from 'node:readline'

import config, { NOTES_URL } from '../config.mjs'

/* The HOST is loopback on purpose and not configurable: the bridge always runs
   on the same machine as the server (Claude spawns it locally), so one less
   thing can be pointed at the wrong place. The PORT is not a constant, though
   — it comes from `harness.config.json`, the same key the server reads, so a
   project that had to move off 4747 does not end up with a bridge quietly
   talking to nobody. */
const BASE = NOTES_URL
const START_HINT = `Start it with: node ${config.harnessRoot}/server/notes-server.mjs &`

/* Long enough that a slow disk write never trips it, short enough that a hung
   server surfaces as an error instead of a stuck agent turn. Every tool but
   `notes_watch` uses it; watching is meant to hang, so it passes its own. */
const TIMEOUT_MS = 5000

/* Watch limits. The default is a minute — long enough that a user typing a
   note has time to finish, short enough that a watch which nobody feeds costs
   one cheap round trip to notice. The ceiling matches the server's and stays
   under any sane MCP client's own call timeout; a watch that outlives the
   client's patience is reported as a broken tool rather than a quiet minute.
   The client's abort is set slightly past the server's own timeout so the
   normal empty answer always arrives as a 200, never as a local abort. */
const WATCH_DEFAULT_S = 60
const WATCH_MAX_S = 600
const WATCH_SLACK_MS = 5000

/* ── HTTP ────────────────────────────────────────────────────────────────
   One helper for every call. Returns `{ ok, status, data }` for anything the
   server actually answered, and THROWS only for transport failures, because
   those two need opposite handling: a 404 is information for the agent ("that
   note is gone"), a connection refused is an operator problem ("your server
   is not running"). Collapsing them into one error type is what makes MCP
   bridges report "note not found" when the truth is nothing is listening. */
async function call(method, path, body, timeoutMs = TIMEOUT_MS) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    /* fetch wraps the socket error, so the real reason is one level down in
       `cause`. Rethrown as a plain sentence with the fix in it: this string
       goes straight into the model's context, where a stack trace is noise
       and "run this command" is the entire useful content. */
    const code = e?.cause?.code
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      throw new Error(`The note server on ${BASE} is not running. ${START_HINT}`)
    }
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`The note server on ${BASE} did not answer in ${timeoutMs} ms.`)
    }
    throw new Error(`Could not reach the note server on ${BASE}: ${e?.message || e}. ${START_HINT}`)
  }

  /* 204 (DELETE) has no body; everything else is JSON by contract, including
     every error. A parse failure here means the server broke its own contract,
     which is worth saying out loud rather than papering over. */
  if (res.status === 204) return { ok: true, status: 204, data: null }
  const raw = await res.text()
  let data = null
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error(`The note server returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`)
    }
  }
  return { ok: res.ok, status: res.status, data }
}

/* The server's error shape is `{"error":"…"}` for every failure, so the text
   it wrote is surfaced verbatim — it was written to be read by whoever called,
   and rephrasing it here would only add a second, staler wording. */
function httpError(r, fallback) {
  const msg = r.data && typeof r.data === 'object' && r.data.error ? r.data.error : fallback
  return new Error(`${msg} (HTTP ${r.status})`)
}

/* ── Rendering ───────────────────────────────────────────────────────────
   Everything below turns a stored note into the few lines an agent needs. */

/* Local wall-clock, because the person who left the note and the person
   reading the listing are the same person in the same timezone; a UTC ISO
   string would need mental arithmetic to answer "is this the one I just
   wrote?". Seconds are dropped — the question is always "how recent", never
   "at what instant". */
function when(iso) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return String(iso ?? '?')
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`

  /* A relative age next to it: the whole triage question for a pending queue
     is which notes are fresh, and "4m ago" answers it without comparing two
     timestamps by eye. */
  const mins = Math.round((Date.now() - t) / 60000)
  let ago
  if (mins < 1) ago = 'just now'
  else if (mins < 60) ago = `${mins}m ago`
  else if (mins < 60 * 24) ago = `${Math.round(mins / 60)}h ago`
  else ago = `${Math.round(mins / (60 * 24))}d ago`

  return `${stamp} (${ago})`
}

/* Keeps a single rendered line from swallowing the listing when a note quotes
   a wall of markup or a page has an enormous URL. */
function clip(s, max) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim()
  return str.length > max ? `${str.slice(0, max - 1)}…` : str
}

/* The target line is the one an agent acts on, so it says WHICH kind of
   locator it got. `selector` is the stable one; `fullPath` is the positional
   fallback the contract guarantees is always present, and it is labelled as
   such because a positional path is worth re-verifying before trusting it —
   the DOM may have shifted since the click. */
function targetLine(n) {
  if (n.selector) return `  target:    ${clip(n.selector, 200)}`
  return `  target:    (no stable selector) ${clip(n.fullPath, 240)}`
}

/* The status is spelled out on every line rather than only for the unusual
   values. A queue that mixes untaken and taken work is unreadable if "taken"
   is the absence of a marker, and `working` is the whole reason the listing
   shows more than `pending` now: the agent must not start a second note while
   one is already in hand, and the user must be able to see which one that is. */
function statusLine(n) {
  if (n.status === 'working') return '  · IN PROGRESS (already taken)'
  if (n.status === 'pending') return '  · new'
  return `  · ${n.status}`
}

/* Нота про проміжок описує ПОРОЖНЕЧУ, а не блок, і агент має зрозуміти це з
   першого виклику: інакше він піде правити елемент, на який показує
   `selector`, хоча предмет зауваження — дірка поруч. Рядок тому каже три речі
   одразу — скільки пікселів, уздовж якої осі й між чим і чим, — а перелік
   джерел лишається брифові й `notes_get`: тут важливо не «чим полагодити», а
   «що саме анотовано». */
function spacingLine(n) {
  const sp = n.spacing
  if (!sp || typeof sp !== 'object') return null
  const side = (v) => (v ? clip(v, 80) : '(кромка)')
  const between = Array.isArray(sp.between) ? sp.between : [null, null]
  const kinds = Array.isArray(sp.sources) ? sp.sources.map((s) => s.kind) : []
  const from = kinds.length ? ` · створено: ${[...new Set(kinds)].join(', ')}` : ''
  return (
    `  ⇔ ПРОМІЖОК ${sp.px}px (${sp.axis}) між ${side(between[0])} і ${side(between[1])}` +
    `${from} — предмет ноти порожнеча, не елемент`
  )
}

function renderNote(n) {
  const lines = []
  lines.push(`[${n.id}]  ${when(n.createdAt)}${statusLine(n)}`)
  lines.push(`  note:      ${clip(n.note, 1200)}`)
  lines.push(`  url:       ${clip(n.url, 300)}`)
  lines.push(targetLine(n))

  const sp = spacingLine(n)
  if (sp) lines.push(sp)

  /* The element's own text and tag disambiguate the target when the same
     selector matches a family of nodes, and cost one short line. */
  const el = [n.tagName, n.text ? `“${clip(n.text, 120)}”` : null].filter(Boolean).join(' ')
  if (el) lines.push(`  element:   ${el}`)

  /* Bottom-up per the contract, which is the order you read it in: the nearest
     component is the one most likely to own the defect, and the ones after it
     say where to look if it does not. */
  const comps = Array.isArray(n.components) ? n.components : []
  if (comps.length) lines.push(`  component: ${comps.join(' < ')}`)

  const thread = Array.isArray(n.thread) ? n.thread : []
  if (thread.length) {
    lines.push('  thread:')
    for (const m of thread) lines.push(`    ${m.role}: ${clip(m.content, 600)}`)

    /* The one piece of state that changes what the agent should DO. A thread
       ending on an agent message means a question was asked and nothing came
       back — picking the note up again and re-asking, or worse, guessing an
       answer and implementing it, is the exact failure this label prevents. */
    if (thread[thread.length - 1].role === 'agent') {
      lines.push('  ⏳ WAITING FOR USER — the last message is the agent\'s question; do not act yet.')
    }
  }

  return lines.join('\n')
}

/* ── Tools ───────────────────────────────────────────────────────────────
   Exactly the seven the contract lists. The surface is closed on purpose — the
   overlay and the dispatcher were designed around it, and an eighth
   convenience tool here would be a way to mutate the store that the other two
   do not know about. Each returns the string handed back to the model. */

const TOOLS = [
  {
    name: 'notes_pending',
    description:
      'List the OPEN review notes left on the app by the user, newest first — both the ' +
      'untaken ones (marked "new") and any note already taken by an agent (marked ' +
      '"IN PROGRESS"). Returns a compact human-readable summary per note: id, age, url, ' +
      'selector (or DOM path when no stable selector exists), the note text, the component ' +
      'chain, a "ПРОМІЖОК" line when the subject of the note is the empty space next to an ' +
      'element rather than the element itself, and the conversation so far. This is normally all you need to start a fix — ' +
      'do not follow it with notes_get unless you specifically need a field it does not ' +
      'show. Pick a note marked "new", then call notes_start on it before anything else.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      /* Open work is pending PLUS working, and the server filters one status at
         a time, so the whole list is fetched and narrowed here rather than
         asking twice and stitching two answers back into creation order. */
      const r = await call('GET', '/notes')
      if (!r.ok) throw httpError(r, 'could not list notes')
      const all = Array.isArray(r.data) ? r.data : []
      const list = all.filter((n) => n.status === 'pending' || n.status === 'working')
      if (!list.length) return 'No open notes.'
      const taken = list.filter((n) => n.status === 'working').length
      const head =
        `${list.length} open note${list.length === 1 ? '' : 's'}` +
        (taken ? ` (${taken} already in progress):` : ':')
      return `${head}\n\n${list.map(renderNote).join('\n\n')}`
    },
  },

  {
    name: 'notes_watch',
    description:
      'Block until the user does something: leaves a new note, or answers a question you ' +
      'asked with notes_reply. Returns the same compact summary as notes_pending for ' +
      'whatever arrived, or says nothing happened when the wait runs out — in which case ' +
      'simply call it again. This is how work starts by itself: finish a fix, then watch. ' +
      'It only reports what happens AFTER the call begins, so check notes_pending first if ' +
      'you have not looked at the queue yet.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: {
          type: 'number',
          description: `How long to wait before giving up, 1–${WATCH_MAX_S} (default ${WATCH_DEFAULT_S}).`,
        },
      },
      required: [],
      additionalProperties: false,
    },
    async run({ timeout_seconds }) {
      let seconds = WATCH_DEFAULT_S
      if (timeout_seconds !== undefined && timeout_seconds !== null) {
        const n = Number(timeout_seconds)
        if (!Number.isFinite(n) || n <= 0) throw new Error('timeout_seconds must be a positive number')
        /* Clamped rather than rejected: a model asking for an hour wants "as
           long as possible", and failing the call over it would waste a turn
           to teach it a ceiling it can simply be given. */
        seconds = Math.min(n, WATCH_MAX_S)
      }

      /* No `since`: the server reads its absence as "from this moment", which
         is exactly the semantics of a watch that has just been started. */
      const r = await call('GET', `/notes/watch?timeout=${seconds}`, undefined, seconds * 1000 + WATCH_SLACK_MS)
      if (!r.ok) throw httpError(r, 'could not watch for notes')
      const list = Array.isArray(r.data) ? r.data : []
      if (!list.length) {
        return `Nothing new in ${seconds}s. Call notes_watch again to keep waiting, or stop if you are done.`
      }
      const head = `${list.length} note${list.length === 1 ? '' : 's'} changed while watching:`
      return `${head}\n\n${list.map(renderNote).join('\n\n')}`
    },
  },

  {
    name: 'notes_get',
    description:
      'Fetch one note in full, as raw JSON including every field and the whole thread. ' +
      'Use when notes_pending left out something you need (outerHTML, rect, viewport, ' +
      'classes) or to re-read a note by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id, e.g. n-m1a2b3c4' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run({ id }) {
      /* There is no GET /notes/:id in the contract — the server exposes the
         collection and per-id mutations only. Rather than invent an endpoint
         (which would make this bridge a client of an API that does not exist),
         the single note is picked out of the full list. The store holds tens
         of notes at most, so the cost is a rounding error. */
      const r = await call('GET', '/notes')
      if (!r.ok) throw httpError(r, 'could not list notes')
      const found = (Array.isArray(r.data) ? r.data : []).find((n) => n.id === id)
      if (!found) throw new Error(`No note ${id}. It may have been closed already.`)
      return JSON.stringify(found, null, 2)
    },
  },

  {
    name: 'notes_start',
    description:
      'Claim a note: mark it "working" so the user can see you have picked it up. Call ' +
      'this FIRST, the moment you decide to take a note — before reading any code, before ' +
      'opening a file, before asking anything. It is one cheap call and it is the only ' +
      'signal the review page has that work has begun; skipping it means the note sits ' +
      'looking untouched until it silently disappears. It is a marker, not a lock: nothing ' +
      'is blocked and you may set a note back with notes_start on another one, or leave it ' +
      'working if you abandon it. Follow with notes_resolve once the fix is made.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run({ id }) {
      const r = await call('PATCH', `/notes/${encodeURIComponent(id)}`, { status: 'working' })
      if (!r.ok) throw httpError(r, `could not start ${id}`)
      return `Note ${id} is marked in progress. Do the fix, then call notes_resolve.`
    },
  },

  {
    name: 'notes_reply',
    description:
      'Ask the user a question about a note, or tell them what you did. The message is ' +
      'appended to the note thread with role "agent" and shows up in the in-page overlay. ' +
      'Use this when a note is ambiguous — guessing at an unclear instruction is wrong ' +
      'about as often as it is right. After replying, stop and wait for an answer.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note id' },
        content: { type: 'string', description: 'Message to the user, ≤ 4000 characters' },
      },
      required: ['id', 'content'],
      additionalProperties: false,
    },
    async run({ id, content }) {
      const r = await call('PATCH', `/notes/${encodeURIComponent(id)}`, {
        reply: { role: 'agent', content },
      })
      if (!r.ok) throw httpError(r, `could not reply to ${id}`)
      /* The count is a nicety; the reply already landed. Reading `.length` off
         an unchecked `thread` would turn a SUCCESSFUL reply into an isError
         the moment the server answers with a shape this line did not expect. */
      const n = Array.isArray(r.data?.thread) ? r.data.thread.length : null
      return n === null
        ? `Replied to ${id}; waiting for the user.`
        : `Replied to ${id}. The thread now has ${n} message(s); waiting for the user.`
    },
  },

  {
    name: 'notes_resolve',
    description:
      'Mark a note resolved: the fix is made but the note stays in the store so the user ' +
      'can verify it. It disappears from notes_pending. This is NOT closing the note — ' +
      'closing is notes_delete, after the user has confirmed.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run({ id }) {
      const r = await call('PATCH', `/notes/${encodeURIComponent(id)}`, { status: 'resolved' })
      if (!r.ok) throw httpError(r, `could not resolve ${id}`)
      return `Note ${id} is resolved. It is out of the pending queue but still readable; delete it once the user has confirmed the fix.`
    },
  },

  {
    name: 'notes_delete',
    description:
      'Close a note for good — it is removed from the store and cannot be recovered. ' +
      'Do this only after the fix has been verified, or when the user dismisses the note ' +
      '(dismissing and closing are the same operation by design). The record of finished ' +
      'work belongs in the fix folder comments-harness/data/fixes/<id>/, not in the note ' +
      'store; data/fixlog.md is a GENERATED index of those folders and is never edited by hand.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run({ id }) {
      const r = await call('DELETE', `/notes/${encodeURIComponent(id)}`)
      if (!r.ok) throw httpError(r, `could not delete ${id}`)
      return `Note ${id} deleted.`
    },
  },
]

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/* ── JSON-RPC / MCP plumbing ─────────────────────────────────────────────
   stdio MCP is newline-delimited JSON-RPC 2.0 in both directions. Two rules
   are easy to get wrong and both are fatal:

   1. Nothing but protocol frames may ever touch stdout. A stray console.log
      lands mid-stream and the client drops the connection with a parse error
      that names no culprit. Diagnostics therefore go to stderr, which the
      client shows as server logs.
   2. A notification (a message with no `id`) must get NO response at all —
      not a result, not an error. `notifications/initialized` is the one that
      arrives in practice, and answering it makes strict clients disconnect. */

const PROTOCOL_VERSION = '2025-06-18'

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(msg) {
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null

  switch (method) {
    case 'initialize':
      /* Echo the client's protocol version when it names one. The client is
         Claude Code, it moves faster than this file will, and version
         negotiation failures present as a bridge that "just doesn't appear" —
         agreeing with whatever it asked for is both correct per spec (we
         support the same tool surface across these revisions) and the option
         that does not silently break on a client upgrade. */
      reply(id, {
        protocolVersion:
          typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        /* Ім'я, під яким міст представляється Claude. Береться з префікса
           проєкту-господаря (`config.prefix`), бо чуже ім'я в чужому репозиторії
           людина в списку MCP-серверів не впізнає. */
        serverInfo: { name: `${config.prefix}-notes`, version: '1.0.0' },
      })
      return

    /* Handshake acknowledgement and a couple of capability probes clients send
       unprompted. `ping` must answer an empty result; the notification must
       answer nothing (see rule 2 above). */
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      reply(id, {})
      return

    case 'tools/list':
      reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
      return

    case 'tools/call': {
      const tool = BY_NAME.get(params?.name)
      if (!tool) {
        replyError(id, -32602, `Unknown tool: ${params?.name}`)
        return
      }
      try {
        const text = await tool.run(params?.arguments ?? {})
        reply(id, { content: [{ type: 'text', text }], isError: false })
      } catch (e) {
        /* A failed tool call is reported as a SUCCESSFUL RPC carrying
           `isError: true`, not as a JSON-RPC error. That is the MCP
           convention, and it matters: a protocol-level error is a bridge
           malfunction the model cannot act on, whereas "the server is not
           running, start it with …" is something it can read and fix. */
        reply(id, { content: [{ type: 'text', text: e?.message || String(e) }], isError: true })
      }
      return
    }

    default:
      /* Unknown *requests* get the standard method-not-found; unknown
         notifications are ignored, since the sender is not listening. */
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
  }
}

/* Line-buffered input. Empty lines are skipped (some clients send keepalive
   newlines) and an unparseable line is logged to stderr rather than crashing —
   one bad frame should not take down a bridge that is otherwise fine. */
const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch (e) {
    console.error(`[notes-mcp] ignoring unparseable line: ${e.message}`)
    return
  }
  /* Not awaited: requests are independent HTTP round-trips and JSON-RPC
     matches responses by id, so letting a slow call block the next one would
     only add latency for no ordering guarantee anyone needs. */
  handle(msg).catch((e) => {
    console.error(`[notes-mcp] handler failed: ${e?.message || e}`)
    if (msg?.id !== undefined && msg?.id !== null) replyError(msg.id, -32603, String(e?.message || e))
  })
})

/* When the client closes the pipe there is nothing left to serve. Exiting
   explicitly avoids a lingering process holding a dead stdin. */
rl.on('close', () => process.exit(0))
