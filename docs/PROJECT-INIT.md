# Project init + onboard — turning a directory into a first-class cogyard project

cogyard owns project creation. Two user-facing commands turn a directory into a
project that the portal sees and that worktrees get ports for — the two things
that silently failed when a project was hand-stitched (the task-044 cogyard-site
incident: a loose folder, never registered, invisible to the portal).

They split on **precondition only**:

| Command | Precondition | What it does |
|---|---|---|
| `cogyard init <name>` | **greenfield** — nothing on disk | create the dir + `git init` + initial commit + a per-`kind` skeleton, then wire |
| `cogyard onboard [path]` | **adopt** an existing folder (with or without git) | `git init` if absent, then wire — **additive-only**, never overwrites a file you already have |

Both converge on one shared core (`ensureProjectWiring()` in
[`core/scaffold.mjs`](../core/scaffold.mjs)) and end in a state where
`cogyard tasks doctor` reports the project clean. The portal's "New / Adopt"
sidebar button POSTs to the same core through the `requireSameOrigin` write seam —
identical behaviour, no second implementation.

## Two guarantees

- **Idempotent.** Safe to re-run on a half-set-up project. A second run reports
  every step "present" and changes nothing (clean working tree, no new commit).
  This is the recovery path: if a project is half-wired, just run `onboard` again.
- **Additive-only.** Every write is create-if-absent. `.gitignore` is the one
  append target (original content preserved as a prefix). An existing `package.json`
  is **never** modified — if it lacks a `version`, you get a warning, not an edit.
  `onboard` leaves every pre-existing file byte-identical.

## Usage

```sh
# greenfield
cogyard init <name|path> --kind <k> [--store shared|normal] [--remote <url>] [--no-wiring]
# adopt an existing folder
cogyard onboard [path]   --kind <k> [--store shared|normal] [--remote <url>] [--no-wiring]
```

| Flag | Default | Notes |
|---|---|---|
| `--kind` | *(required)* | `single` · `fullstack` · `static` · `library`. Drives the skeleton + version stamping. |
| `--store` | `shared` | `shared` moves `_tasks/` to the `~/gitroot/_tasks/<slug>` store (portal-visible default); `normal` keeps `_tasks/` as a tracked dir in the repo. |
| `--remote` | none | git remote for the shared task store (passed through to `convert`). |
| `--no-wiring` | off | skip `.claude/worktree-config.json`. Auto-skipped for `kind=library`. |

The portal: click **+ New** / **Adopt** at the bottom of the sidebar project list.

## The wiring steps (`ensureProjectWiring`)

Each step is create-if-absent and reuses an existing primitive rather than
reimplementing it:

1. **git** — `git init -b main` if absent.
2. **register** — `registerProject()` → portal visibility (this is the step that
   was skipped on cogyard-site). The registry slug is the single source of truth.
3. **package.json** — create minimal (with a `version`) if absent; never touch an
   existing one (warn if it has no `version`).
4. **.gitignore** — append the essentials (`node_modules`, `dist/`, `version.json`,
   `.claude/launch.json`, `.env.worktree`); the `_tasks` line is added by `convert`.
5. **skeleton** (init only) — per-`kind` minimal files (README + an entry file; a
   static site gets an `index.html` with a version footer).
6. **version stamping** — a generated `scripts/generate-version.mjs` (the
   build-time version+SHA pattern from this repo's own
   [`scripts/generate-version.mjs`](../scripts/generate-version.mjs)); `library`
   opts out (it exposes its version via `package.json`).
7. **worktree wiring** — `.claude/worktree-config.json`, the **real opt-in** the
   port hook keys on ([`hooks/worktree-ports.mjs`](../hooks/worktree-ports.mjs)), plus a
   committed `.env.worktree.defaults`. There is no `worktree-projects.list` — that was
   documented but read by no code. **The port contract:** the SessionStart hook merges
   each worktree's reserved `PORT`/`FRONTEND_PORT` into `.env.worktree`; your
   `npm run dev` must source it and bind `$FRONTEND_PORT` (and `$PORT`) — never a
   hardcoded port, or the preview lands on the wrong one. `cogyard init --kind static`
   seeds a `dev` script that already does this; `single`/`fullstack` leave `dev` to
   you/`bd-scaffold-*` (the config's `_comment` + the README state the contract).
8. **task store** — shared by default via `convertToSharedStore` (extracted from
   `cogyard tasks convert`); the `⚠ no _tasks` fix. No-ops when already a symlink.

`cogyard tasks init` is **not** the front door — it is a low-level primitive
(`mkdir _tasks/` + register an already-set-up repo). Its help points here.

## The shared seam

The conversion logic lives in `core/scaffold.mjs` (`convertToSharedStore`), so
`init`/`onboard`, the portal route, and `cogyard tasks convert` all share one
implementation. The portal endpoints (`server/routes/projects.mjs`) are the second
writes on the read-mostly `/api` surface — they go through the documented
`requireSameOrigin` + `readBody` seam in `server/http.mjs` and nowhere else.

## Verify it worked

```sh
cogyard tasks doctor          # the slug shows model=shared, no ⚠
cogyard tasks projects list   # the slug appears without ⚠
# → project visible at http://cogyard/ ; a worktree in it gets a port pair
```

## Kinds

Start with four hardcoded kinds (`single` / `fullstack` / `static` / `library`);
a general project-type plugin system is deliberately out of scope. `fullstack`
seeds only the cogyard wiring — use the `bd-scaffold-fullstack` skill for the
Angular + Node/Express + SQL monorepo shape.
