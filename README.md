# Comments Harness

Visual comments on a frontend, fixed by agents.

You open your own dev server, point at the element that bothers you, write one
sentence about what is wrong with it — and a minute later the fix is in the
code. Between those two moments there is no ticket, no "the thing in the card,
top right", no screenshot with an arrow drawn on it.

The note carries the context by itself: the route it was taken on, a CSS
selector for the element, the chain of React component names above it, the
element's geometry, and a raster shot of the block. So the agent that picks the
note up does not go looking for the place — it already knows which file family
to open and what the user was looking at.

Written for the case where the person reviewing the UI and the person fixing it
are not the same actor: a human looks, an agent edits, and the note is the whole
handoff.

The docs in `docs/` are in Ukrainian and stay that way; this page says in
English what each of them covers.

## Parts

Six processes and files, zero npm dependencies, two HTTP ports.

| Part | File | What it does |
|---|---|---|
| Overlay | `overlay/annotator.tsx` | crosshair, popover, markers and the comment thread, rendered inside your dev build |
| Notes server | `server/notes-server.mjs` | :4747, owns the open notes, long-polls for the watchdog |
| MCP bridge | `mcp/notes-mcp.mjs` | seven tools an agent uses to read, claim and close notes |
| Watchdog | `watchdog/dispatcher.mjs` | waits on the note long-poll and on the rework queue, and launches an executor (`claude -p`) per task |
| Review page | `review/fixlog.html` | table of open and closed work, verdicts, rework history |
| Verdicts server | `server/fixlog-server.mjs` | :4748, verdicts and rework iterations, deliberately separate from notes |
| Browser config | `client/endpoints.js` | the one place the two browser clients get the server ports from — the sole default, plus the lookup order |

Lifecycle: a note is `pending` when written, `working` when an agent claims it,
`resolved` when the edit is made. The watchdog then writes a fix folder under
`data/fixes/<id>/`, rebuilds the `data/fixlog.md` index from those folders, and
deletes the note. Closing is automatic — there is no human approval step in it.
If the result is wrong, "Send back" on the review page opens a rework iteration
against the fix folder on :4748, and the watchdog runs a second attempt with a
brief built from the folder plus the complaint.

## Install with Claude Code

This is the intended path. The harness is meant for a project where Claude Code
already runs, and mounting the overlay requires editing your project's own code
anyway — so an agent here is the shortest route, not a gimmick.

Give the agent this, in the root of the project you want to annotate:

```
Clone https://github.com/denysosadchyi/comments-harness into this project
and set it up: run node comments-harness/setup.mjs, then wire the overlay
into the app as it tells you.
```

The agent will read `setup.mjs` and `docs/porting.md` and finish the one thing
the script cannot do on its own: mount the overlay entry point inside your
`src/`, dev-build only, in a way that leaves nothing behind in a production
build. How that is done depends on your bundler — `docs/porting.md` describes
the Vite lazy-glob version used here, the three bugs it already paid for, and
what changes in other setups.

## Install by hand

Requires Node ≥ 20.11 (`import.meta.dirname`). Nothing else — no npm install.

```sh
cd <your project root>
git clone https://github.com/denysosadchyi/comments-harness comments-harness
node comments-harness/setup.mjs
```

`setup.mjs` writes `harness.config.json`, creates the empty stores, generates
systemd user units from templates under your project's name
(`<project>-notes`, `<project>-ratings`, `<project>-watchdog`), registers the
MCP bridge with Claude Code, and symlinks the review page into your static
directory. It is idempotent: a second run leaves everything that already exists
alone. At the end it prints exactly what is left for a human — the overlay
mounting snippet and the review URL.

Flags: `--no-systemd` (units land in `generated-units/`, you start the
processes yourself), `--no-mcp`, `--no-symlinks`, `--prefix=<name>`,
`--notes-port=N`, `--ratings-port=N`, `--project-root=<path>`, `--force`.
`node setup.mjs --help` prints the same list.

Without systemd:

```sh
node comments-harness/server/notes-server.mjs &
node comments-harness/server/fixlog-server.mjs &
node comments-harness/watchdog/dispatcher.mjs &
curl -s localhost:4747/health   # {"status":"ok","notes":0,"waiting":0}
curl -s localhost:4748/health   # {"ok":true}
```

With systemd, one thing stays manual: `loginctl enable-linger $USER`, or the
units die with your login session.

## Configuration

`harness.config.json` (written by setup, not tracked in git) is the single
place for machine-dependent values: project root, name prefix, ports, executor
command and the watchdog's limits. Precedence is default → config file →
environment variable. The full field list with defaults and reasoning is in
`config.mjs`, which is meant to be read.

## Limits — read before installing

- **No human between the click and the changed file.** The watchdog launches
  the executor with `--dangerously-skip-permissions`. An agent edits your
  working tree unattended, off a one-sentence note. It never commits, but it
  does write. Run this on a dev checkout you can `git diff`, not on anything
  you would not want rewritten.
- **The executor is Claude Code.** `claude -p "<brief>"` is the default
  command. It is a config field, so another CLI is possible in principle, but
  nothing else has been tried and the brief format assumes Claude Code's MCP
  registration.
- **Linux and systemd user units.** The units, the linger step and the paths
  assume that. Everything except the units is plain Node and should run
  anywhere, but nothing else is tested.
- **Ports 4747 and 4748**, both bound to `0.0.0.0` by default so the review
  page opens from a phone or another machine. If your dev server is exposed on
  the LAN, open those two ports to the LAN subnet only.
- **The browser side asks for the ports; it does not know them.** The overlay
  and the review page cannot read `harness.config.json`, so they get the ports
  at runtime: `GET <notes>/config` returns `{notesPort, ratingsPort}` (a
  whitelist — nothing else from the config leaves the process), and a
  non-default notes port is announced by `harness-ports.json`, a static file
  `setup.mjs` writes next to the review page when, and only when, your ports
  differ from the defaults. The single default, `DEFAULT_NOTES_PORT` in
  `client/endpoints.js`, exists because the first request has to go somewhere:
  the page is served by your dev server, which knows nothing about the harness.
  Change a port in one place — the config — and re-run `setup.mjs`.
- **Fix history is append-mostly and local.** `data/` is state, not code, and
  it is not designed to be shared or merged between machines.

## Documentation

All of `docs/` is in Ukrainian.

| File | Covers |
|---|---|
| `docs/architecture.md` | the parts, the boundaries between them, the data flow, why there are no dependencies |
| `docs/contract.md` | the contract: note schema, the :4747 HTTP API, limits, the tool list, and a separate section on :4748 (verdicts, `reworks[]`) |
| `docs/agents.md` | the executor agent's working cycle and what a brief must contain |
| `docs/watchdog.md` | the watchdog: long polling, which events wake it and which do not, the rework queue |
| `docs/review-page.md` | the review table, its three live states, the ghost filter, verdicts and reworks |
| `docs/porting.md` | mounting into someone else's project, and the traps already paid for |
| `docs/fix-folder.md` | what a closed fix folder holds and what it deliberately does not |

`docs/contract.md` is the source of truth for three processes at once. When in
doubt about a field or a response code, go there rather than to the code.

## Data

`data/` holds state, not code, and is not tracked in git:

- `fixlog-notes.json` — open notes, written by :4747;
- `fixlog-ratings.json` — verdicts and rework iterations, written by :4748;
- `fixes/<id>/` — the source of truth for closed fixes: one folder each, with
  metadata, the request and its thread, the shot and the run log;
- `fixlog.md` — a *derived* index of closed work, rebuilt whole from those
  folders by `server/build-index.mjs`. Editing it by hand is pointless;
- `shots/` — shots for still-open notes; on close a shot moves into the fix
  folder.

The store deliberately does not live in the project's static directory:
everything there is normally copied into the build and published, and open
notes are internal remarks about unfinished screens.

## License

MIT, see `LICENSE`.

`overlay/vendor/` contains html2canvas-pro 2.3.9, vendored byte-for-byte
outside `package.json` (with its own MIT license file and an update recipe in
`overlay/vendor/README.md`). It is loaded dynamically — it is only needed when
a note takes a shot.
