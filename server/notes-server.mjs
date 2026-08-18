/* LOCAL ONLY — this file lives in `comments-harness/`, which .git/info/exclude keeps
   out of git. It is a dev tool, never product code, and nothing in the app
   imports it. Vite ignores it too: the App.tsx overlay glob matches
   `./dev/*.local.tsx`, and this is `.mjs`.

   What it is: the note store that replaced Agentation on :4747. Three
   processes share one contract (`comments-harness/docs/contract.md`) — this server,
   the MCP bridge, and the in-page overlay — and only this one owns the data.
   The bridge and the overlay hold no state of their own; they read and write
   through HTTP so there is exactly one copy of every note and exactly one
   arbiter of what a valid note is. That is why validation lives here and is
   strict: a note that gets in malformed is a note the other two have to
   defend against forever.

   Notes are OPEN work. Closing one is a DELETE, not a status — the history
   of finished work belongs in the fix folders `comments-harness/data/fixes/<id>/`,
   written by the dispatcher; `data/fixlog.md` is the human-readable index
   GENERATED from them (`server/build-index.mjs`) and is never edited by hand.
   Hence `dismissed` is spelled DELETE.

   Three statuses, and the middle one is not a lock. `working` exists for
   VISIBILITY, not for arbitration: one agent works one note, so there is no
   race to guard. What there is, is a review page (`review/fixlog.html`) that
   already draws an "in progress" row — sheen animation, pulsing dot, "In
   progress" caption — and a user who otherwise sees a note jump straight from
   "new" to "gone" with no sign anybody picked it up. Because it is not a lock,
   transitions are NOT policed: an agent that died mid-fix must be able to put
   the note back to `pending`, and a state machine here would make that
   recovery impossible from the outside.

   Zero dependencies on purpose. It is started by hand
   (`node comments-harness/server/notes-server.mjs &`), survives `npm install` pruning
   extraneous packages, and has nothing to break when the lockfile changes.

   Three things that look like over-engineering and are not:

   1. CORS is fully permissive, OPTIONS is answered, and the allowed-methods
      list includes PATCH and DELETE. The page is opened from ANOTHER machine
      on the LAN (the dev server binds 0.0.0.0), so its origin is
      `http://<lan-ip>:<dev-port>` while this is port 4747 — cross-origin by
      the browser's reckoning, and preflighted the moment the body is JSON or
      the method is anything past POST. Omitting PATCH/DELETE from the list
      does not fail loudly; it fails as an opaque "Failed to fetch" on every
      reply and every close, which is far worse to debug.

   2. Writes go to a temp file and are then renamed over the target. rename(2)
      within one filesystem is atomic, so a crash or a concurrent read can see
      the old file or the new file and never a half-written one. Writing in
      place would let a crash mid-write leave truncated JSON — and the file is
      the only copy of every open note.

   3. A corrupt store file stops the process instead of starting empty. An
      empty start would be followed by the first write overwriting the file
      that was merely unreadable, destroying every pending note. Refusing to
      boot is recoverable; a silent reset is not.

   `GET /notes/watch` is the one endpoint that does not answer immediately: it
   is long-polling, and it exists because without it a note only starts work
   when a dispatcher happens to ask. See the waiters section below. */
import { createServer } from 'node:http'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import config, { configComplaints } from '../config.mjs'

/* ── Configuration ────────────────────────────────────────────────────────
   Everything that a different project might have to change is here, at the
   top, and nothing below reaches for a path or a port of its own.

   The port is a constant rather than an env var on purpose: three processes
   (this, the MCP bridge, the in-page overlay) must agree on it, and a value
   read by only one of them is a silent disagreement.

   Server-side that agreement is now `harness.config.json` — this file and the
   bridge read the same key. The OVERLAY still cannot: it runs in the browser,
   where there is no config file to read, so `overlay/annotator.tsx` keeps the
   number literally. Change the port and you change it in two places, not one:
   here (via the config) and there. */
const PORT = config.notesPort
const HOST = config.host
/* Resolved from this file's own location, never from cwd: the server is
   normally launched from the project root with `node comments-harness/…`,
   but nothing stops someone starting it from elsewhere, and a store path
   that depends on cwd would then create a second, empty store. */
const HARNESS_ROOT = resolve(import.meta.dirname, '..')
/* Inside the harness, NOT inside the host project's `public/`. Everything
   under a Vite `public/` is copied verbatim into `dist/` and shipped, so a
   store living there would publish every open note — internal review comments
   about unfinished screens — on the production site. The harness directory is
   git-excluded and never enters the bundle, which is what this file needs.
   (The ratings store next door is reachable over HTTP by necessity — the
   review page fetches it — and is exposed through a symlink from `public/`,
   not by living there.) */
const FILE = join(HARNESS_ROOT, 'data', 'fixlog-notes.json')
/* Block shots live NEXT TO the store, not inside it: a note is read whole on
   every request and a few hundred kilobytes of base64 per note would make the
   flat file unusable. The note carries only the relative path. */
const SHOTS_DIR = join(HARNESS_ROOT, 'data', 'shots')

/* Guardrails on untrusted input, straight from the contract's limits table.
   The reviewer is trusted, a stray script on the LAN is not, and this process
   writes to disk. Truncation is the OVERLAY's job — anything that arrives
   over a limit is a client that ignored the contract, so it gets a 400 rather
   than a quiet trim that would hide the bug. */
const MAX_BODY = 128 * 1024
/* The shot has its own ceiling, thirty times the JSON one: a 1400 px-wide PNG
   at 2× is comfortably under 4 MB, and anything past that is a client that
   ignored the contract's capture limits. */
const MAX_SHOT = 4 * 1024 * 1024
const MAX_ID = 64
/* The first character is pinned to [A-Za-z0-9] on purpose, exactly as in
   `fixlog-server.mjs`: `.` and `..` would otherwise pass, and an id that
   starts with a dot becomes a dotfile shot (`..png`) that `GET /shots/:file`
   refuses to serve — a 200 on upload pointing at nothing. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_NOTE = 4000
const MAX_CONTENT = 4000
const MAX_OUTER_HTML = 2048
const MAX_TEXT = 300
const MAX_COMPONENTS = 8
/* Not in the limits table, but every remaining string field still needs a
   ceiling or MAX_BODY becomes the only bound and a single note can be 128 KB
   of selector. Generous enough that no honest client ever meets it. */
const MAX_MISC = 4000

/* Order is the lifecycle order, and the error messages print it, so a client
   that sends a bad status is told the sequence and not just the set. */
const STATUSES = ['pending', 'working', 'resolved']
const ROLES = ['agent', 'human']

/* ── Store ──────────────────────────────────────────────────────────────
   Kept in memory and mirrored to disk on every write. Memory is the read
   path (a GET never touches the disk), disk is the durable copy. Loading
   once at boot means a corrupted file is noticed immediately, at start, not
   on the first request hours later. */
let notes = load()

function load() {
  /* On a fresh clone `data/` does not exist yet and the first write would die
     with a bare ENOENT from deep inside persist(). Create it here, once, so
     the failure mode is a directory that could not be made and says so. */
  try {
    mkdirSync(dirname(FILE), { recursive: true })
  } catch (e) {
    console.error(`[notes] could not create ${dirname(FILE)} (${e.message}).`)
    process.exit(1)
  }
  if (!existsSync(FILE)) {
    persist([])
    return []
  }
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
    /* Objects and null are also valid JSON but not a valid store; the store
       is a FLAT ARRAY of notes. Refuse to treat anything else as one rather
       than silently start from empty and overwrite. */
    if (!Array.isArray(parsed)) throw new Error('root is not an array')
    return parsed
  } catch (e) {
    console.error(`[notes] ${FILE} is unreadable (${e.message}).`)
    console.error('[notes] Refusing to start — move it aside to begin fresh.')
    process.exit(1)
  }
}

function persist(data) {
  /* Temp file in the SAME directory: rename is only atomic within a
     filesystem, and /tmp is frequently a different one. */
  const tmp = join(dirname(FILE), `.fixlog-notes.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmp, FILE)
  } catch (e) {
    /* Leave no debris behind if the rename is what failed. */
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* nothing useful to do — the write already failed */
    }
    throw e
  }
}

/* ── Shots ──────────────────────────────────────────────────────────────
   Same write discipline as the store: temp file in the SAME directory, then
   renamed over the target, so a reader never sees a half-written PNG and a
   crash mid-upload leaves no truncated image claiming to be the shot. */
function persistShot(id, buf) {
  mkdirSync(SHOTS_DIR, { recursive: true })
  const target = join(SHOTS_DIR, `${id}.png`)
  const tmp = join(SHOTS_DIR, `.${id}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, buf)
    renameSync(tmp, target)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* nothing useful to do — the write already failed */
    }
    throw e
  }
}

/* Best effort by design: the shot is a reference, not a record, so a note must
   still close when its image is already gone or was never taken. */
function removeShot(id) {
  try {
    const target = join(SHOTS_DIR, `${id}.png`)
    if (existsSync(target)) unlinkSync(target)
  } catch (e) {
    console.error(`[notes] could not remove shot for ${id}: ${e.message}`)
  }
}

/* ── Validation ─────────────────────────────────────────────────────────
   The contract's note shape, enforced field by field. Two rules shape all of
   this: fields not in the contract are DROPPED rather than stored (the dead
   Agentation vocabulary — `intent`, `severity`, `computedStyles`… — must not
   creep back in through a stale client), and fields that the agent relies on
   to find the element again are required rather than optional. `selector` may
   be null because a unique one is not always derivable; `fullPath` may not,
   because it is the fallback that makes a null selector survivable. */

const isStr = (v) => typeof v === 'string'

function badRect(r) {
  if (r === undefined || r === null) return null // optional
  if (typeof r !== 'object' || Array.isArray(r)) return 'rect must be an object'
  for (const k of ['x', 'y', 'w', 'h']) {
    if (!Number.isFinite(r[k])) return `rect.${k} must be a number`
  }
  return null
}

function badViewport(v) {
  if (v === undefined || v === null) return null // optional
  if (typeof v !== 'object' || Array.isArray(v)) return 'viewport must be an object'
  for (const k of ['w', 'h']) {
    if (!Number.isFinite(v[k])) return `viewport.${k} must be a number`
  }
  return null
}

/* Returns an error string, or null when the body is a well-formed note. The
   caller keeps the shaping separate from the checking so that a rejected note
   never leaves a half-built record behind. */
function validateIncoming(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be an object'

  if (!isStr(b.id) || !b.id.trim()) return 'id is required — the overlay generates it'
  const id = b.id.trim()
  if (id.length > MAX_ID) return `id must be ≤ ${MAX_ID} characters`
  if (!ID_RE.test(id)) return 'id may only contain [A-Za-z0-9._-]'

  if (!isStr(b.note) || !b.note.trim()) return 'note is required — it is the whole point'
  if (b.note.length > MAX_NOTE) return `note must be ≤ ${MAX_NOTE} characters`

  if (!isStr(b.url) || !b.url.trim()) return 'url is required — full, with query'
  if (b.url.length > MAX_MISC) return `url must be ≤ ${MAX_MISC} characters`

  if (!isStr(b.fullPath) || !b.fullPath.trim()) return 'fullPath is required and never null'
  if (b.fullPath.length > MAX_MISC) return `fullPath must be ≤ ${MAX_MISC} characters`

  /* Explicitly nullable: the overlay says "I could not build a unique one". */
  if (b.selector !== undefined && b.selector !== null) {
    if (!isStr(b.selector)) return 'selector must be a string or null'
    if (b.selector.length > MAX_MISC) return `selector must be ≤ ${MAX_MISC} characters`
  }

  for (const k of ['tagName', 'classes']) {
    if (b[k] === undefined || b[k] === null) continue
    if (!isStr(b[k])) return `${k} must be a string`
    if (b[k].length > MAX_MISC) return `${k} must be ≤ ${MAX_MISC} characters`
  }

  if (b.text !== undefined && b.text !== null) {
    if (!isStr(b.text)) return 'text must be a string'
    if (b.text.length > MAX_TEXT) return `text must be ≤ ${MAX_TEXT} characters`
  }

  if (b.outerHTML !== undefined && b.outerHTML !== null) {
    if (!isStr(b.outerHTML)) return 'outerHTML must be a string'
    if (b.outerHTML.length > MAX_OUTER_HTML) {
      return `outerHTML must be ≤ ${MAX_OUTER_HTML} characters — the overlay truncates`
    }
  }

  const rectErr = badRect(b.rect)
  if (rectErr) return rectErr
  const vpErr = badViewport(b.viewport)
  if (vpErr) return vpErr

  if (b.components !== undefined && b.components !== null) {
    if (!Array.isArray(b.components)) return 'components must be an array'
    if (b.components.length > MAX_COMPONENTS) {
      return `components must be ≤ ${MAX_COMPONENTS} entries`
    }
    if (!b.components.every((c) => isStr(c) && c.length <= MAX_MISC)) {
      return 'components must be strings'
    }
  }

  if (b.createdAt !== undefined && b.createdAt !== null) {
    if (!isStr(b.createdAt) || Number.isNaN(Date.parse(b.createdAt))) {
      return 'createdAt must be an ISO timestamp'
    }
  }

  return null
}

/* Builds the stored record. Whitelisted field by field, so an over-eager
   client cannot smuggle extra keys into the store: what the MCP bridge and
   the overlay read is exactly what the contract lists.

   `status`, `updatedAt` and `thread` are SERVER-owned on create — the POST
   body is documented as not carrying them, and a client that sends them
   anyway is simply ignored rather than trusted. `thread` starts as an empty
   array, never undefined, so every reader can iterate it unguarded. */
function shape(b) {
  const now = new Date().toISOString()
  return {
    id: b.id.trim(),
    /* The overlay's clock is the one that saw the click; ours is only the
       fallback for a client that omitted it. It is a CLIENT clock, so nothing
       that compares timestamps across processes may use it — see receivedAt. */
    createdAt: isStr(b.createdAt) && !Number.isNaN(Date.parse(b.createdAt)) ? b.createdAt : now,
    /* Server-owned arrival stamp, and the only timestamp the watch endpoint
       compares against. `createdAt` comes from the browser: a laptop whose
       clock trails the server by a minute would stamp every new note as older
       than "now" and no watcher would ever wake — a silent stall of the whole
       pipeline with no error anywhere. Both clocks are kept because they
       answer different questions (when the reviewer clicked vs. when we heard
       about it) and `createdAt` is in the contract. */
    receivedAt: now,
    updatedAt: now,
    status: 'pending',
    note: b.note,

    url: b.url,
    viewport: b.viewport ?? null,

    selector: isStr(b.selector) ? b.selector : null,
    fullPath: b.fullPath,
    tagName: isStr(b.tagName) ? b.tagName : null,
    classes: isStr(b.classes) ? b.classes : null,
    text: isStr(b.text) ? b.text : '',
    outerHTML: isStr(b.outerHTML) ? b.outerHTML : '',
    rect: b.rect ?? null,

    components: Array.isArray(b.components) ? b.components : [],

    /* Always null on create, whatever the body claims: the shot arrives in its
       own `POST /notes/:id/shot` after the note exists, and a client that could
       name its own file here would be naming a path on our disk. */
    shot: null,

    thread: [],
  }
}

/* ── HTTP ───────────────────────────────────────────────────────────── */
const cors = {
  'Access-Control-Allow-Origin': '*',
  /* PATCH and DELETE are load-bearing here, not decoration: replying to a
     note and closing one are the two most-used calls, and both are
     preflighted from the LAN page. */
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

function send(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    ...cors,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    /* The overlay and the bridge poll; neither may ever be handed a
       304-cached snapshot of a queue that has since moved. */
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/* Errors are ALWAYS this shape — `{"error":"…"}`, never HTML. The bridge
   surfaces `error` verbatim to the agent, so an HTML error page would reach
   a model as a wall of markup instead of a reason. */
const fail = (res, code, error) => send(res, code, { error })

/* 204 carries no body, so it must not carry the JSON content headers either. */
function sendEmpty(res, code) {
  res.writeHead(code, cors)
  res.end()
}

/* Reads the whole request body as bytes, refusing anything over `limit`. The
   limit is a parameter and not the constant, because the shot endpoint carries
   a PNG and has a ceiling three orders of magnitude larger than the JSON one —
   one reader with two ceilings, rather than two readers that drift apart. */
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        /* Stop reading but do NOT destroy the socket: the client deserves the
           error that explains what happened, and a destroyed connection reaches
           it as a bare "empty reply from server". Node tears the socket down
           itself once the response has been flushed over the unread upload. */
        req.pause()
        const err = new Error(`body too large — max ${limit} bytes`)
        err.tooLarge = true
        reject(err)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readBody(req) {
  return (await readRaw(req, MAX_BODY)).toString('utf8')
}

/* Commits a new array to disk first and to memory only on success, so the
   store never claims a durability it does not have. Returns an error string
   on failure, null on success. */
function commit(next) {
  try {
    persist(next)
  } catch (e) {
    return `could not persist: ${e.message}`
  }
  notes = next
  /* Every mutation is a potential wakeup. Called here rather than at each call
     site so a future writer cannot forget it: if it changed the store, the
     watchers hear about it. */
  wake()
  return null
}

/* ── Watch (long polling) ───────────────────────────────────────────────
   The reason this endpoint exists: a note that lands in the store while no
   dispatcher is asking just sits there. The removed third-party tool had a
   blocking `watch_annotations` and that single call is what made fixes start
   by themselves. This is the same idea in HTTP terms.

   Deliberately long polling and not SSE/WebSocket: the consumer is an MCP
   tool call, which is one request and one response by nature. A stream would
   have to be collapsed back into a single answer anyway, and `fetch` with a
   timeout is the whole client.

   Two events count as "something happened", and only two:
   - a note created (still `pending`) after `since` — new work;
   - a `human` message appended after `since` — the user answered a question
     the agent asked, which is the other thing that unblocks work.
   An agent's own reply must NOT wake anyone: the agent wrote it, and waking
   on it would spin a watcher against itself. A status change is not an event
   either — `working` and `resolved` are both set BY the agent, and a DELETE
   removes the note. Note that the first rule keys off arrival time and
   `status === 'pending'`, so a note the agent has already taken (`working`)
   stops being new work the moment it is taken, which is exactly right.

   Every timestamp compared here is one THIS process wrote — `receivedAt` on
   the note, `at` on the thread message. `createdAt` is the browser's clock
   and is deliberately not used: comparing a foreign clock against our
   `Date.now()` makes wakeups depend on how well the reviewer's laptop is
   synchronised. Notes written before `receivedAt` existed fall back to
   `createdAt`, which is the best that can be said about them. */

/* Open waiters. A Set because removal by identity happens on every finish and
   every dropped connection, and there are single digits of these at most. */
const waiters = new Set()

const WATCH_DEFAULT_S = 60
const WATCH_MAX_S = 600

/* Arrival by the SERVER's clock, with the pre-receivedAt store as fallback. */
const arrivedMs = (n) => Date.parse(n.receivedAt || n.createdAt || 0)

function eventsSince(sinceMs) {
  return notes
    .filter((n) => {
      if (n.status === 'pending' && arrivedMs(n) > sinceMs) return true
      const thread = Array.isArray(n.thread) ? n.thread : []
      return thread.some((m) => m.role === 'human' && Date.parse(m.at) > sinceMs)
    })
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
}

function wake() {
  /* Copied before iterating: a waiter that fires removes itself from the set.
     Guarded one by one because this runs inside SOMEBODY ELSE'S request: a
     waiter whose socket died mid-answer would throw out of `commit()` and
     leave the writer — whose data is already safely on disk — with no
     response at all. One dead watcher must not take a healthy write with it. */
  for (const w of [...waiters]) {
    try {
      w.check()
    } catch (e) {
      console.error(`[notes] waiter wakeup failed: ${e.message}`)
    }
  }
}

const server = createServer(async (req, res) => {
  const url = req.url || '/'
  /* The query string is meaningful on GET /notes and cache-busting noise
     everywhere else, so path and query are separated once, up front. */
  const [path, query = ''] = url.split('?')
  const params = new URLSearchParams(query)

  /* Preflight is answered for every path, including ones that do not exist:
     the browser asks before it knows, and a 404 here reads to it as a CORS
     failure rather than a missing route. */
  if (req.method === 'OPTIONS') {
    sendEmpty(res, 204)
    return
  }

  if (req.method === 'GET' && path === '/health') {
    /* `waiting` is how you tell a leak from a coincidence: it must fall back
       to 0 once the watchers hang up, and it is the only view into a set that
       is otherwise invisible from outside the process. */
    send(res, 200, { status: 'ok', notes: notes.length, waiting: waiters.size })
    return
  }

  if (req.method === 'GET' && path === '/notes') {
    const status = params.get('status')
    if (status !== null && !STATUSES.includes(status)) {
      fail(res, 400, `status must be one of ${STATUSES.join(', ')}`)
      return
    }
    const list = status === null ? notes : notes.filter((n) => n.status === status)
    /* Newest first. Sorting on read rather than keeping the array ordered on
       write means the on-disk file stays in creation order, which is what you
       want when reading it by hand or diffing two snapshots. */
    const sorted = list
      .slice()
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    send(res, 200, sorted)
    return
  }

  /* Must be tested before the `/notes/:id` matcher below, which would
     otherwise read "watch" as a note id. */
  if (req.method === 'GET' && path === '/notes/watch') {
    const rawSince = params.get('since')
    /* No `since` means "from now on" — the caller is starting to listen, not
       catching up, and defaulting to the epoch would return the whole backlog
       instantly and make the very first watch useless. */
    let sinceMs = Date.now()
    if (rawSince !== null && rawSince !== '') {
      /* An ISO string is what the notes carry; epoch milliseconds are what a
         shell caller reaches for. Both are accepted, neither is guessed at. */
      const parsed = /^\d+$/.test(rawSince) ? Number(rawSince) : Date.parse(rawSince)
      if (!Number.isFinite(parsed)) {
        fail(res, 400, 'since must be an ISO timestamp or epoch milliseconds')
        return
      }
      sinceMs = parsed
    }

    const rawTimeout = params.get('timeout')
    let timeoutS = WATCH_DEFAULT_S
    if (rawTimeout !== null && rawTimeout !== '') {
      /* Whole seconds only, per the contract's 1…600: a fractional or
         sub-second timeout is a client that read a different contract, and
         accepting it quietly would make `timeout=0.5` look supported. */
      const parsed = Number(rawTimeout)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > WATCH_MAX_S) {
        fail(res, 400, `timeout must be a number of seconds between 1 and ${WATCH_MAX_S}`)
        return
      }
      timeoutS = parsed
    }

    /* The queue may already hold something newer than `since` — answer at once
       rather than sleep through work that is sitting right there. */
    const ready = eventsSince(sinceMs)
    if (ready.length) {
      send(res, 200, ready)
      return
    }

    /* Timing out is a 200 with `[]`, never a 408 or a hang: the caller's next
       move is identical either way (ask again), and an error status would make
       an ordinary quiet minute look like a failure in the agent's transcript. */
    let done = false
    const waiter = {
      check() {
        const list = eventsSince(sinceMs)
        if (list.length) finish(list)
      },
    }
    const timer = setTimeout(() => finish([]), timeoutS * 1000)

    function finish(list) {
      if (done) return
      done = true
      clearTimeout(timer)
      waiters.delete(waiter)
      send(res, 200, list)
    }

    /* The client walking away is the common case, not the exception: an agent
       turn ends, Claude kills the bridge, the socket dies mid-wait. Without
       this the waiter stays in the set and its timer keeps the event loop busy
       for up to ten minutes, and a day of that is a slow leak in a process
       that is meant to run for weeks. `close` fires after a normal response
       too, hence the `done` guard — by then there is nothing left to clean. */
    req.on('close', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      waiters.delete(waiter)
    })

    waiters.add(waiter)
    return
  }

  if (req.method === 'POST' && path === '/notes') {
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch (e) {
      /* A body over MAX_BODY lands here too — the read rejects and the parse
         never happens — but it gets its own message, because "bad JSON" would
         send the client hunting for a syntax error that is not there. */
      fail(res, 400, e.tooLarge ? e.message : `bad JSON: ${e.message}`)
      return
    }

    const err = validateIncoming(body)
    if (err) {
      fail(res, 400, err)
      return
    }

    const note = shape(body)
    /* Ids come from the overlay, so collisions are its bug, not ours — but a
       duplicate would silently shadow a live note in every reader that does a
       find-by-id, so it is refused loudly instead. */
    if (notes.some((n) => n.id === note.id)) {
      fail(res, 400, `note ${note.id} already exists`)
      return
    }

    const persistErr = commit([...notes, note])
    if (persistErr) {
      fail(res, 500, persistErr)
      return
    }
    send(res, 201, note)
    return
  }

  /* POST /notes/:id/shot — the block screenshot, raw `image/png` bytes.
     Matched BEFORE the `/notes/:id` rule below, which would otherwise read
     "n-abc/shot" as an id and answer 404 for a note that exists. */
  const shotMatch = path.match(/^\/notes\/(.+)\/shot$/)
  if (shotMatch && req.method === 'POST') {
    let id
    try {
      id = decodeURIComponent(shotMatch[1])
    } catch {
      fail(res, 400, 'malformed id in path')
      return
    }
    /* The id becomes a filename, so it is held to the same charset as on
       create — a note whose id got into the store by another route must still
       not be able to name a path outside `data/shots/`. */
    if (id.length > MAX_ID || !ID_RE.test(id)) {
      fail(res, 400, 'id may only contain [A-Za-z0-9._-]')
      return
    }

    let buf
    try {
      buf = await readRaw(req, MAX_SHOT)
    } catch (e) {
      /* 413 and not 400: the body is well-formed, there is simply too much of
         it, and the overlay reacts by dropping the shot rather than retrying. */
      fail(res, e.tooLarge ? 413 : 400, e.message)
      return
    }
    if (!buf.length) {
      fail(res, 400, 'empty body — expected raw image/png bytes')
      return
    }

    /* Checked AFTER the read: bailing early would leave the upload unread on
       the socket, and the client sees a reset instead of the 404. */
    const index = notes.findIndex((n) => n.id === id)
    if (index === -1) {
      fail(res, 404, `no note ${id}`)
      return
    }

    try {
      persistShot(id, buf)
    } catch (e) {
      fail(res, 500, `could not write shot: ${e.message}`)
      return
    }

    const rel = `shots/${id}.png`
    const next = notes.slice()
    next[index] = { ...notes[index], shot: rel, updatedAt: new Date().toISOString() }
    const persistErr = commit(next)
    if (persistErr) {
      fail(res, 500, persistErr)
      return
    }
    send(res, 200, { shot: rel })
    return
  }

  /* GET /shots/:file — this is a path arriving from the network and landing in
     the filesystem, so the name is whitelisted rather than sanitised: one flat
     charset, no separators, and `..` refused outright. Nothing is joined until
     the name has passed. */
  const fileMatch = path.match(/^\/shots\/(.+)$/)
  if (fileMatch && req.method === 'GET') {
    let name
    try {
      name = decodeURIComponent(fileMatch[1])
    } catch {
      fail(res, 404, 'no such shot')
      return
    }
    /* `..` survives the charset test (both characters are allowed on their
       own), hence the second, explicit refusal. */
    if (!ID_RE.test(name) || name.includes('..') || !name.endsWith('.png')) {
      fail(res, 404, 'no such shot')
      return
    }
    const target = join(SHOTS_DIR, name)
    let buf
    try {
      buf = readFileSync(target)
    } catch {
      fail(res, 404, 'no such shot')
      return
    }
    res.writeHead(200, {
      ...cors,
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      /* A shot is replaced in place when the same note is re-captured, so a
         cached copy would show the reviewer the previous defect. */
      'Cache-Control': 'no-store',
    })
    res.end(buf)
    return
  }

  /* /notes/:id — the id is the whole remaining segment. Decoded because the
     overlay is entitled to encode it, even though the contract's charset
     never actually needs escaping. */
  const idMatch = path.match(/^\/notes\/(.+)$/)
  if (idMatch) {
    let id
    try {
      id = decodeURIComponent(idMatch[1])
    } catch {
      fail(res, 400, 'malformed id in path')
      return
    }
    if (req.method === 'PATCH') {
      let body
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch (e) {
        fail(res, 400, e.tooLarge ? e.message : `bad JSON: ${e.message}`)
        return
      }
      /* Located AFTER the read, never before it: the body arrives over the
         LAN, so `await readBody` is a whole round trip during which the event
         loop runs other requests. An index taken before that await is stale by
         the time it is written — a DELETE in the gap shifts it onto a
         different note (overwriting its status and thread), and if the deleted
         note was the last one, `index === notes.length` and the PATCH
         resurrects it. From here to the commit there is not a single await, so
         nothing can move the array under us. Same discipline as POST and the
         shot endpoint. */
      const index = notes.findIndex((n) => n.id === id)
      if (index === -1) {
        fail(res, 404, `no note ${id}`)
        return
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        fail(res, 400, 'body must be an object')
        return
      }

      const hasStatus = body.status !== undefined
      const hasReply = body.reply !== undefined
      if (!hasStatus && !hasReply) {
        fail(res, 400, 'expected status or reply')
        return
      }

      const prev = notes[index]
      const patched = { ...prev }

      if (hasStatus) {
        if (!STATUSES.includes(body.status)) {
          /* The set is closed — closing a note is DELETE, never a fourth
             status. Which of the three, though, is the caller's business:
             any transition is allowed, including backwards, because
             `working` is a visibility marker and an agent that crashed has
             to be able to hand the note back as `pending`. */
          fail(res, 400, `status must be one of ${STATUSES.join(', ')}`)
          return
        }
        patched.status = body.status
      }

      if (hasReply) {
        const r = body.reply
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
          fail(res, 400, 'reply must be an object')
          return
        }
        if (!ROLES.includes(r.role)) {
          fail(res, 400, `reply.role must be one of ${ROLES.join(', ')}`)
          return
        }
        if (!isStr(r.content) || !r.content.trim()) {
          fail(res, 400, 'reply.content is required')
          return
        }
        if (r.content.length > MAX_CONTENT) {
          fail(res, 400, `reply.content must be ≤ ${MAX_CONTENT} characters`)
          return
        }
        /* Append only. The thread is the record of what was asked and
           answered; rewriting or trimming it would destroy the one thing that
           explains why a fix ended up the way it did. */
        patched.thread = [
          ...(Array.isArray(prev.thread) ? prev.thread : []),
          { role: r.role, content: r.content, at: new Date().toISOString() },
        ]
      }

      patched.updatedAt = new Date().toISOString()

      const next = notes.slice()
      next[index] = patched
      const persistErr = commit(next)
      if (persistErr) {
        fail(res, 500, persistErr)
        return
      }
      send(res, 200, patched)
      return
    }

    if (req.method === 'DELETE') {
      /* No body to read, so the lookup and the write are in the same tick. */
      const index = notes.findIndex((n) => n.id === id)
      /* Deleting a note that is already gone is a 404 rather than a silent
         204: the caller is a dispatcher closing a specific piece of work, and
         "it was not there" is information it should see, not swallow. */
      if (index === -1) {
        fail(res, 404, `no note ${id}`)
        return
      }
      const next = notes.slice()
      next.splice(index, 1)
      const persistErr = commit(next)
      if (persistErr) {
        fail(res, 500, persistErr)
        return
      }
      /* After the store commit, and never before: if the write had failed the
         note would still be open, and it must not be left pointing at an image
         that has already been deleted. */
      removeShot(id)
      sendEmpty(res, 204)
      return
    }
  }

  fail(res, 404, `no route for ${req.method} ${path}`)
})

server.listen(PORT, HOST, () => {
  for (const line of configComplaints) console.log(`[notes] конфіг: ${line}`)
  console.log(`[notes] notes on http://${HOST}:${PORT} → ${FILE}`)
  console.log(`[notes] ${notes.length} note(s) loaded`)
})
