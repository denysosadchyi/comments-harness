/* LOCAL ONLY — this file lives in `comments-harness/`, which .git/info/exclude keeps
   out of git. It is a dev tool, never product code, and nothing in the app
   imports it. Vite ignores it too: the App.tsx overlay glob matches
   `./dev/*.local.tsx`, and this is `.mjs`.

   What it is: the review half of the fix-log loop. The annotation server on
   :4747 owns work that is still open; the fix folders `data/fixes/<id>/` own
   work that is finished, and `data/fixlog.md` is the index GENERATED from them
   (`server/build-index.mjs`) — a derived file, never edited by hand. Neither
   holds an opinion about whether a fix actually satisfied the reviewer, and
   the index must stay a regenerable projection of the folders — a reviewer
   typing verdicts into it would lose them at the next rebuild. So the verdicts
   live in their own file, written by their own process, on their own port.

   The record of interest is the REWORK HISTORY. Every send-back is one
   iteration — «чому не влаштувало» — and every close carries what the redo
   changed. Kept as a full array, never overwritten, because the file doubles
   as a training corpus: request → what the agent did → why it was rejected →
   what the rework fixed. Older records may still carry a single legacy
   `rework` slot and a `stars` field; both are read transparently and never
   destroyed on write.

   Zero dependencies on purpose. It is started by hand
   (`node comments-harness/server/fixlog-server.mjs &`), survives `npm install` pruning
   extraneous packages, and has nothing to break when the lockfile changes.

   Two things that look like over-engineering and are not:

   1. CORS is fully permissive and OPTIONS is answered. The review is opened
      from ANOTHER machine on the LAN (the dev server binds 0.0.0.0), so the
      page origin is `http://<lan-ip>:<dev-port>` while this is port 4748 —
      a cross-origin request by the browser's reckoning, preflighted the
      moment the body is JSON. Without this, every POST fails as an opaque
      "Failed to fetch". For the same reason port 4748 has to be reachable
      from the LAN — open it in the firewall to the local subnet, never wider.

   2. Writes go to a temp file and are then renamed over the target. rename(2)
      within one filesystem is atomic, so a crash or a concurrent read can see
      the old file or the new file and never a half-written one. Writing in
      place would let a crash mid-write leave truncated JSON — and the file is
      the only copy of every rating ever given. */
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

import config from '../config.mjs'

/* ── Configuration ────────────────────────────────────────────────────────
   Port comes from `harness.config.json` (see `config.mjs`), but only for the
   processes that can read a file. The review page cannot — it runs in a
   browser — so it asks the NOTES server for this port over `GET /config`
   (see `client/endpoints.js`). Nothing here has to be told about that: this
   server and that endpoint read the same `config.mjs`. */
const PORT = config.ratingsPort
const HOST = config.host
/* Resolved from this file's own location, never from cwd — see the twin
   reasoning in `notes-server.mjs`. The review page reads this same file over
   HTTP, which it can because `public/fixlog-ratings.json` is a symlink to it;
   the canonical copy stays inside the harness so the tool can move whole. */
const HARNESS_ROOT = resolve(import.meta.dirname, '..')
const FILE = join(HARNESS_ROOT, 'data', 'fixlog-ratings.json')

/* Guardrails on untrusted input. The reviewer is trusted, a stray script on
   the LAN is not, and this process writes to disk. */
const MAX_BODY = 64 * 1024 // one rating is ~200 bytes; anything larger is noise
/* The same 64 as in `notes-server.mjs`, and it has to be: a rating is keyed by
   a fix folder name, and no folder name can be longer than the note id it came
   from. A wider ceiling here only lets a verdict be filed under a key no fix
   could ever have. */
const MAX_ID = 64
/* Generous, because this is a human explaining why a fix was not good enough —
   the same ceiling the note server gives a note. Text over it is REFUSED, not
   trimmed: see the rejection sites below. */
const MAX_NOTE = 4000

/* ── Identity ───────────────────────────────────────────────────────────
   A rating is keyed by the FIX's own id — the name of its folder in
   `data/fixes/<id>/`: `n-msu1hdbtclmq` for a fix that came from an overlay
   note, `f-2026-08-10-07` for the ones migrated out of the hand-written log.
   That id is permanent, so the verdict stays attached to the fix forever.

   Before this, the key was the pair `«час|роут»` scraped off the markdown row,
   with `#2`, `#3` suffixes when two fixes shared the pair. It is gone, and the
   old shape is REFUSED rather than accepted: a legacy client posting `11:4x|
   /search` would otherwise create an orphan record that no row on the review
   page can ever show, and nobody would notice until the ratings were counted.
   Loud 400 beats a silent write to nowhere. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const idError = (id) => {
  if (!id) return 'id must be a non-empty string'
  if (id.length > MAX_ID) return `id must be at most ${MAX_ID} characters`
  if (!ID_RE.test(id)) {
    return (
      `«${id}» is not a fix id. Ratings are keyed by the fix folder name ` +
      '(data/fixes/<id>/) — e.g. «n-msu1hdbtclmq» or «f-2026-08-10-07». ' +
      'The legacy «час|роут» key is no longer accepted.'
    )
  }
  return ''
}

/* ── Store ──────────────────────────────────────────────────────────────
   Kept in memory and mirrored to disk on every write. Memory is the read
   path (a GET never touches the disk), disk is the durable copy. Loading
   once at boot means a corrupted file is noticed immediately, at start, not
   on the first request hours later. */
let ratings = load()

function load() {
  /* On a fresh clone `data/` does not exist yet and the first write would die
     with a bare ENOENT from deep inside persist(). Create it here, once, so
     the failure mode is a directory that could not be made and says so. */
  try {
    mkdirSync(dirname(FILE), { recursive: true })
  } catch (e) {
    console.error(`[fixlog] could not create ${dirname(FILE)} (${e.message}).`)
    process.exit(1)
  }
  if (!existsSync(FILE)) {
    persist({})
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
    /* Arrays and null are also valid JSON but not a valid store; refuse to
       treat them as one rather than silently start from empty and overwrite. */
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root is not an object')
    }
    return parsed
  } catch (e) {
    console.error(`[fixlog] ${FILE} is unreadable (${e.message}).`)
    console.error('[fixlog] Refusing to start — move it aside to begin fresh.')
    process.exit(1)
  }
}

function persist(data) {
  /* Temp file in the SAME directory: rename is only atomic within a
     filesystem, and /tmp is frequently a different one. */
  const tmp = join(dirname(FILE), `.fixlog-ratings.${process.pid}.${Date.now()}.tmp`)
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

/* ── Rework history ─────────────────────────────────────────────────────
   Source of truth is `reworks: [{note, at, done, doneAt?, result?}, …]`.
   Records written before the history existed carry a single `rework` slot;
   these helpers read both shapes so the old file needs no migration pass —
   a legacy record is upgraded the first time it is written to, not before.

   For the dispatcher the record ALSO keeps a `rework` mirror of the latest
   iteration: its poller reads `r.rework.note` / `r.rework.done` and must
   keep working unchanged. The mirror is maintained on every write. */
const rwList = (rec) =>
  Array.isArray(rec?.reworks) ? rec.reworks : rec?.rework ? [rec.rework] : []

const lastOpen = (rec) => {
  const l = rwList(rec)
  const last = l[l.length - 1]
  return last && !last.done ? last : null
}

/* ── HTTP ───────────────────────────────────────────────────────────── */
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

function send(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    ...cors,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    /* The drawer refetches on every open and must never see a 304-cached
       snapshot of somebody else's session. */
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        /* Stop reading but do NOT destroy the socket — the same discipline as
           `notes-server.mjs`. Destroying it means the 400 that explains what
           happened is written into a dead connection and the client sees a
           broken pipe instead, which contradicts the one promise this server
           makes: an error is always JSON. Node tears the socket down itself
           once the response has been flushed over the unread upload. */
        req.pause()
        const err = new Error(`body too large — max ${MAX_BODY} bytes`)
        err.tooLarge = true
        reject(err)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  /* URL may carry a cache-busting query string; only the path matters. */
  const path = (req.url || '/').split('?')[0]

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }

  if (req.method === 'GET' && path === '/health') {
    send(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && path === '/ratings') {
    send(res, 200, ratings)
    return
  }

  if (req.method === 'POST' && path === '/rate') {
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch (e) {
      send(res, 400, { ok: false, error: e.tooLarge ? e.message : `bad JSON: ${e.message}` })
      return
    }

    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const idErr = idError(id)
    if (idErr) {
      send(res, 400, { ok: false, error: idErr })
      return
    }

    /* Accept a numeric string too — a form control that stringifies its value
       is a likelier client than a malicious one. */
    const stars = Number(body.stars)
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      send(res, 400, { ok: false, error: 'stars must be an integer 1..5' })
      return
    }

    /* Over-long text is REFUSED, never trimmed. Trimming answers `ok: true`
       to a reviewer whose last paragraph has just been thrown away, and
       nothing anywhere says so — the note server has always sent a 400 here
       and this one now agrees. */
    const note = typeof body.note === 'string' ? body.note.trim() : ''
    if (note.length > MAX_NOTE) {
      send(res, 400, { ok: false, error: `note must be at most ${MAX_NOTE} characters` })
      return
    }

    /* Kept for old clients even though the UI no longer sends stars; the
       upsert replaces the verdict but must never eat the rework history the
       record may also carry — spreading the previous record in keeps it. */
    const record = { ...(ratings[id] || {}), id, stars, note, updatedAt: new Date().toISOString() }
    const next = { ...ratings, [id]: record }
    try {
      persist(next)
    } catch (e) {
      /* Memory is NOT updated on a failed write, so the store never claims a
         durability it does not have, and the drawer surfaces the failure. */
      send(res, 500, { ok: false, error: `could not persist: ${e.message}` })
      return
    }
    ratings = next
    send(res, 200, { ok: true, rating: record })
    return
  }

  /* Rework queue. This is an instruction — the fix was wrong and must be
     redone, with the reviewer's words attached. Each send-back is one
     ITERATION in the record's history: a fix can go around the loop several
     times, and every round is kept, because the history is the corpus. */
  if (req.method === 'POST' && path === '/rework') {
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch (e) {
      send(res, 400, { ok: false, error: e.tooLarge ? e.message : `bad JSON: ${e.message}` })
      return
    }

    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const idErr = idError(id)
    if (idErr) {
      send(res, 400, { ok: false, error: idErr })
      return
    }

    const note = typeof body.note === 'string' ? body.note.trim() : ''
    if (!note) {
      send(res, 400, { ok: false, error: 'note is required — it is the instruction' })
      return
    }
    /* Refused rather than trimmed: this note IS the instruction for the redo,
       and a silently amputated instruction is a redo done wrong. */
    if (note.length > MAX_NOTE) {
      send(res, 400, { ok: false, error: `note must be at most ${MAX_NOTE} characters` })
      return
    }

    const prev = ratings[id] || { id }
    const list = rwList(prev).slice()
    const now = new Date().toISOString()
    if (list.length && !list[list.length - 1].done) {
      /* One fix has at most ONE open instruction at a time: re-sending while
         an iteration is still open AMENDS its note rather than queueing a
         second — the reviewer is refining the ask, not asking twice. A new
         iteration begins only after the previous one was closed. */
      list[list.length - 1] = { ...list[list.length - 1], note, at: now }
    } else {
      list.push({ note, at: now, done: false })
    }
    const record = {
      ...prev,
      id,
      reworks: list,
      rework: list[list.length - 1], // dispatcher-compat mirror of the latest
      updatedAt: now,
    }
    const next = { ...ratings, [id]: record }
    try { persist(next) } catch (e) {
      send(res, 500, { ok: false, error: `could not persist: ${e.message}` })
      return
    }
    ratings = next
    send(res, 200, { ok: true, rating: record })
    return
  }

  /* What the dispatcher polls: everything sent back and not yet redone.
     Items keep the flat `rework` mirror the dispatcher already understands —
     synthesised on the way out for legacy records that only have the slot. */
  if (req.method === 'GET' && path === '/rework') {
    const open = Object.values(ratings)
      .filter((r) => lastOpen(r))
      .map((r) => ({ ...r, rework: lastOpen(r) }))
    send(res, 200, { count: open.length, items: open })
    return
  }

  /* The dispatcher closes the current open iteration once it has redone the
     fix. An optional `result` — what the redo actually changed — is stored on
     the iteration: it is the corpus's answer to «що виправила доробка». */
  if (req.method === 'POST' && path === '/rework-done') {
    let body
    try { body = JSON.parse((await readBody(req)) || '{}') } catch (e) {
      send(res, 400, { ok: false, error: e.tooLarge ? e.message : `bad JSON: ${e.message}` }); return
    }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const idErr = idError(id)
    if (idErr) { send(res, 400, { ok: false, error: idErr }); return }
    const rec = ratings[id]
    const list = rwList(rec).slice()
    if (!rec || !list.length) { send(res, 404, { ok: false, error: 'no rework for that id' }); return }
    if (list[list.length - 1].done) {
      /* Closing twice is not an error — the old server tolerated it, and a
         retried POST after a dropped response must not turn into a 404. */
      send(res, 200, { ok: true, rating: rec })
      return
    }
    const result = typeof body.result === 'string' ? body.result.trim() : ''
    if (result.length > MAX_NOTE) {
      send(res, 400, { ok: false, error: `result must be at most ${MAX_NOTE} characters` })
      return
    }
    const closed = {
      ...list[list.length - 1],
      done: true,
      doneAt: new Date().toISOString(),
      ...(result ? { result } : {}),
    }
    list[list.length - 1] = closed
    const record = { ...rec, reworks: list, rework: closed, updatedAt: new Date().toISOString() }
    const next = { ...ratings, [id]: record }
    try { persist(next) } catch (e) {
      send(res, 500, { ok: false, error: `could not persist: ${e.message}` }); return
    }
    ratings = next
    send(res, 200, { ok: true, rating: record })
    return
  }

  send(res, 404, { ok: false, error: `no route for ${req.method} ${path}` })
})

server.listen(PORT, HOST, () => {
  console.log(`[fixlog] ratings on http://${HOST}:${PORT} → ${FILE}`)
  console.log(`[fixlog] ${Object.keys(ratings).length} rating(s) loaded`)
})
