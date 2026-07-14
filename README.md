<p align="center">
  <img src="branding/cogyard-mark.svg" alt="cogyard" width="96" height="96">
</p>

<h1 align="center">cogyard</h1>

<p align="center"><em>from AI chats to shipped products</em></p>

<p align="center">
  Keep track of multiple projects running at once —
  every task, worktree, and merge across every project in one place.
</p>

---

**cogyard** takes you from AI chats to shipped products. The LLM is the new
compiler: you think at product level, not code level, and direct a fleet of
agents across all your projects at once. Each project gets a `_tasks/` directory
of markdown task files; a Node engine parses them, tracks git/worktree state,
allocates ports, and enforces atomic claims; an Angular portal shows every task,
worktree, and merge across every project in one place. (Claude Code first, but
any agent or human plugs into the same CLI.)

The agent is the worker; you are the reviewer. Tasks in, checkmarks out.

## How it works

- **Task files** — `_tasks/NNN-<slug>.md`, YAML frontmatter (status, deps,
  scope, claims) over a markdown body. The source of truth for every piece of
  work.
- **Collision-free claims** — parallel sessions in different worktrees claim a
  task atomically before touching it, so two agents never race on the same work.
- **Worktree-aware** — each Claude worktree gets its own port pair and dev
  environment; the portal shows which worktree owns which task.
- **AI-agnostic engine** — the `core/` data layer and `cli/` are plain Node.
  Claude Code drives it through thin skills, but anything that can call the CLI
  (another agent, a script, a human) works the same way.

---

## Install

cogyard has two halves you install independently: the **engine** (the `cogyard`
CLI + portal, agent-agnostic) and the **Claude driver** (skills/commands/hooks
that let Claude Code drive the engine). You can run the engine with no agent at
all.

**Requirements:** Node 22 LTS or newer, `git`, and a Unix-like OS — macOS or Linux
(Windows via WSL). The CLI and portal are pure Node; `git` is used throughout.

### 1. The engine

```sh
npm i -g cogyard   # puts the `cogyard` command on your PATH
cogyard serve      # → http://localhost:7440
```

Or try it without installing anything:

```sh
npx cogyard serve
```

The published package ships the portal UI prebuilt — no build step, no clone.

<details>
<summary><strong>From source</strong> (the dev path — hacking on cogyard itself)</summary>

```sh
git clone https://github.com/cogyard/cogyard.git cogyard
cd cogyard
npm install        # npm workspaces — root + the portal UI
npm start          # builds the UI on first run (~30s), then serves → http://localhost:7440
npm link           # optional: put this checkout's `cogyard` on your PATH
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the dev-server setup.
</details>

Verify with `cogyard --help`. To confirm the install is wired correctly — right
Node, `git` on PATH, a writable `~/.cogyard/`, projects registered — run
`cogyard doctor`: a one-shot ok/warn/fail preflight that prints a fix line per
problem (it only reports; it never changes anything). It exits non-zero only if
something makes cogyard genuinely unrunnable, so it's safe in a CI smoke check.

Per-machine state (project registry, worktree port allocations, usage ledger)
lives in `~/.cogyard/` — override with the `COGYARD_HOME` env var. Every env
var, state file, default port, and tool requirement is listed in
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

### 2. The Claude driver (optional)

The Claude Code driver ships in-repo as a plugin; the repo is its own
marketplace.

- **Plugin marketplace** — add this repo as a marketplace and install the
  `cogyard` plugin (`/plugin` flow in Claude Code).
- **Manual install** — for environments without the marketplace flow:
  ```sh
  cogyard claude install          # symlink skills + commands into ~/.claude
  cogyard claude install --rules  # also write cogyard's operating rules into CLAUDE.md
  cogyard claude uninstall        # remove what install added
  ```
  This prints the `settings.json` SessionStart-hook block to paste in (a plugin
  can't deliver always-on rules itself).

Other agents (or a human) drive the same engine by calling the CLI directly —
see [Driving cogyard with any agent](#driving-cogyard-with-any-agent).

### 3. The desktop app (optional)

A native Electron shell that wraps the portal in its own window (dock badge,
notifications) is available as an opt-in extra — it is **not** part of the default
install, so the Electron toolchain only downloads if you ask for it:

```sh
npm run desktop        # build the macOS app (.dmg) — installs desktop's deps on first run
npm run desktop:dev    # …or run it in dev against your live repo
```

The supported baseline is the browser portal (`cogyard serve`); the desktop app
is purely a convenience wrapper over it.

---

## Quick start

```sh
# Turn a directory into a cogyard project (creates it + git + skeleton + wiring):
cogyard init my-app --kind fullstack

# …or adopt an existing folder you already have (additive-only, never overwrites):
cd existing-project
cogyard onboard . --kind single

# Confirm it's wired and portal-visible:
cogyard tasks doctor
cogyard tasks projects list

# Run the portal (API + SPA on one origin):
cogyard serve            # http://localhost:7440
```

`init` and `onboard` differ **only on precondition** — `init` for a greenfield
directory (nothing on disk), `onboard` to adopt an existing folder. Both are
**idempotent** (safe to re-run; a half-wired project is repaired by running
`onboard` again) and **additive-only** (an existing `package.json` is never
modified). Full reference: [`docs/PROJECT-INIT.md`](docs/PROJECT-INIT.md).

---

## The `cogyard` command

```
cogyard <command> [...]

  init   <name>     create a NEW project (dir + git + skeleton + full wiring)
  onboard [path]    adopt an EXISTING folder as a project (additive-only)
  tasks  <…>        task store: sync, projects, doctor, next-id, current, analyze, mount
  env    <…>        environment + claims: detect, port-owner, claim, release
  tunnel <…>        expose a worktree's dev server at a stable hostname
  usage  <…>        token/cost ledger: collect, report, backfill
  serve  [--port N] run the portal (API + SPA) on one origin (default PORT 7440)
  doctor            install preflight — is this machine wired to run cogyard?
  claude <install|uninstall>  install the Claude driver (skills/commands) into ~/.claude
  hook   <name>     engine hook entrypoint (session-start | validate-frontmatter)
```

Run `cogyard <command> --help` for a subcommand's own options.

### `cogyard init` / `cogyard onboard`

| Flag | Default | Notes |
|---|---|---|
| `--kind` | *(required)* | `single` · `fullstack` · `static` · `library` — drives the skeleton + version stamping. |
| `--store` | `shared` | `shared` moves `_tasks/` to the shared store (`<COGYARD_PROJECTS_ROOT>/_tasks/<slug>`, default `~/gitroot`); `normal` keeps `_tasks/` tracked in the repo. |
| `--remote` | none | git remote for the shared task store. |
| `--no-wiring` | off | skip `.claude/worktree-config.json` (auto-skipped for `kind=library`). |

### `cogyard tasks`

| Subcommand | What it does |
|---|---|
| `sync pull` | Rebase `_tasks/` from the canonical's git remote (cross-machine stores only). |
| `sync push "<msg>"` | Commit (and push, if a remote exists) task edits. **Use this instead of `git add _tasks/`** — shared stores are gitignored symlinks. |
| `projects [list]` | Show registered projects. |
| `projects register` / `remove <slug>` | Manage the registry (remove never deletes files). |
| `next-id <slug>` | Atomically reserve the next id and create `_tasks/NNN-<slug>.md` (race-safe across clones). |
| `current` | JSON of currently-claimed tasks in this repo (the `/commit` skill uses it to auto-tag commits). |
| `convert [--store <p>] [--remote <u>]` | Convert a repo's tracked `_tasks/` to a shared store. |
| `mount` | In a worktree, recreate the base checkout's `_tasks` symlink (the SessionStart hook does this automatically). |
| `doctor` | Audit every registered project's storage health. |
| `staleness` / `drift <id>` | Drift gates: is this checkout behind the default branch / have a task's paths changed since it was last reviewed. |
| `analyze [--apply]` | Heuristic backfill for unknown-frontmatter tasks. |

### `cogyard env`

| Subcommand | What it does |
|---|---|
| `detect` | JSON of the current environment (planet, ports, worktree, branch). |
| `port-owner <port>` | Which worktree owns a TCP port. |
| `claim <task-file> <session-id>` | Atomically claim a task (refuses if claimed by another session). |
| `release <task-file>` | Clear the claim (the worked-in worktree/branch record survives). |

> **Never hand-edit `claimed_at` / `claimed_by_session`** in a task file — use
> `claim`/`release` for atomicity. **Never `git add _tasks/`** when it's a
> symlink — use `tasks sync push`.

---

## Task files

Each project keeps a `_tasks/` directory of `NNN-<slug>.md` files: a YAML
frontmatter block over a markdown body. The file is the source of truth for one
unit of work — `core/` parses it, the portal renders it, the CLI claims and
syncs it.

### Status vocabulary

| status | meaning | backlog? | `done_date` |
|---|---|---|---|
| `OPEN` | active backlog — pickable now (or waiting on an unmet dep) | yes | null |
| `PARKED` | deliberately shelved; not abandoned | yes (waiting) | null |
| `ENOUGH` | a version of done — shipped, leftovers recorded in the body | **no** | set |
| `DONE` | fully complete; nothing left | no | set |
| `OBSOLETE` | abandoned / superseded; will not be done | no | — |

`ENOUGH` is treated as a done-family state everywhere `DONE` is (excluded from
backlog, satisfies dependencies, never flagged stale), but signals "satisfied
for now, leftovers worth harvesting later." There is no "blocked" status:
blocked on another task = `depends_on` + stay `OPEN` (the portal derives
`waiting on #N` and self-clears it); blocked on something external = `PARKED`.
Full notes: [`docs/TASK-STATUS-VOCABULARY.md`](docs/TASK-STATUS-VOCABULARY.md).

### Storage

`_tasks/` is either a normal tracked directory in the repo (`--store normal`) or
a **shared store** (`--store shared`, the default): a gitignored absolute symlink
into `<COGYARD_PROJECTS_ROOT>/_tasks/<slug>` (default `~/gitroot`), its own git
repo on a `tasks` branch. The shared
model lets every worktree see the same task files instantly and survives across
clones. Commit shared-store edits with `cogyard tasks sync push`, never
`git add`.

---

## Working tasks with Claude Code

With the Claude driver installed, two skills handle the task lifecycle. They
trigger on natural phrasing — you don't type the skill name.

| Say… | Skill | What it does |
|---|---|---|
| "file this as a task", "park this for later", "spec this out" | **write-task** | Authors a new shelf-stable `_tasks/NNN-*.md` file. |
| "do task 037", "pick up task X", "work on task Y" | **pickup-task** | Reads, claims, and executes an existing task — sync → claim → (optional) task-named worktree → drift check → work → release. |

Other driver skills: **commit** (auto-tags commits with the active task id),
**handoff** (paste-ready brief for a fresh session), **debt-cleanup**
(structured multi-phase refactor). The **`/cogyard`** command opens the portal.

Doing it by hand (any agent, no driver): `cogyard tasks next-id <slug>` to
create a file, `cogyard env claim <file> <session-id>` before you touch it,
`cogyard env release <file>` when done, `cogyard tasks sync push "<msg>"` to
persist.

---

## The portal

One cross-project view of what every agent is doing — backlog, claims, which
worktree owns which task, and a token/cost usage tab.

```sh
cogyard serve              # API + built SPA on one origin, http://localhost:7440
cogyard serve --port 7437  # pick a port
```

The portal is **read-mostly**: it's a viewer, not an editor. The only write
endpoints are the usage-refresh button and the New/Adopt-project action, both
same-origin-gated. For a clean hostname (`http://cogyard`) put a reverse proxy
in front — see [`docs/DEPLOY.md`](docs/DEPLOY.md) (includes the TLS note for dock
badges) and [`Caddyfile.example`](Caddyfile.example).

---

## Worktree ports

Run `npm run dev` in two Claude worktrees of the same repo and they'd both grab
the same port. cogyard's machine-wide SessionStart hook reserves a **unique port
pair per worktree** — universally, no opt-in. The reservation is just a registry
row + a briefing injected into the new session's context, so the session knows
its ports.

If a project additionally commits a `.claude/worktree-config.json`, the hook
goes further: it writes `.planet` / env files / `launch.json` so dev servers
bind the reserved ports automatically. Allocations live in `~/.cogyard/ports.json`.
You start a worktree's dev server yourself (e.g. via the Claude_Preview MCP) when
you need it — nothing keeps it running in the background.

Full operational reference (schema, debugging):
[`docs/WORKTREE-PORTS.md`](docs/WORKTREE-PORTS.md).

---

## Tunnels

Expose a project's **current worktree** dev server at a stable public Cloudflare
hostname — and the tunnel follows whichever worktree you're working in.

```sh
cloudflared tunnel login                      # one-time, interactive (you do this)
cogyard tunnel enable <project> <hostname>    # one-time per project
cogyard tunnel here                           # repoint at the active worktree (auto on session start)
cogyard tunnel status | list
cogyard tunnel disable [--delete]
```

cogyard gives each worktree a different dynamic port; `tunnel here` rewrites the
tunnel's ingress to the active worktree's port so one hostname tracks your work.
Uses cloudflared local-config mode + a per-project LaunchAgent. macOS-only today.
Full reference + the hard-won gotchas: [`docs/TUNNELS.md`](docs/TUNNELS.md).

---

## Usage ledger

cogyard harvests token/cost data from agent session transcripts into a per-machine
ledger under `~/.cogyard/usage/`, surfaced in the portal's usage tab.

```sh
cogyard usage collect      # harvest new transcript content (idempotent)
cogyard usage backfill     # harvest all existing transcripts once
cogyard usage report [project]   # cost/token rollup, all projects or one in detail
```

Cost is computed from the active driver's price table; with no agent active
(the no-op adapter) tokens still ledger but cost stays null rather than invented.

---

## Driving cogyard with any agent

The engine (`core/`) and CLI (`cli/`) are agent-agnostic. Three things are
inherently agent-specific — worktree layout, where transcripts live, and the
model price table — and live behind a small **adapter** interface
(`drivers/<name>/adapter.mjs`). The engine resolves the active adapter once
at import (env var `COGYARD_DRIVER`, `~/.cogyard/config.json`, or
auto-detect) and falls back to a built-in no-op adapter so the CLI and portal run
with no agent at all.

Adding an agent = a new `drivers/<name>/adapter.mjs` against the contract;
the engine never imports it by name. `drivers/claude/` is the reference
driver (and a Claude Code plugin). Full contract:
[`docs/DRIVERS.md`](docs/DRIVERS.md).

---

## Architecture

One data layer; everything else is a thin front end over it. `core/` knows
nothing about the CLI, HTTP, or UI — the CLI, the API server, and the worktree
hooks all *import* it. The portal talks to the server's read-only `/api`; agent
drivers plug in behind an adapter and the engine never names one.

```
                  core/  ── data layer: frontmatter parse · registry · git ·
                    │      worktree · ports · lane graph. Importable, no CLI/HTTP/UI.
      ┌─────────────┼──────────────┬───────────────┐
      ▼             ▼              ▼               ▼
    cli/         server/        hooks/        drivers/
  cogyard,     read-only       worktree       agent drivers;
  tasks, env,    /api over     session setup   claude/ is the
  tunnel,        core/         (ports + _tasks  reference adapter
  usage          │             mount)           + Claude plugin
  (skills +      ▼
   humans)    frontend/  ── Angular + PrimeNG SPA, consumes /api/*

docs/      configuration, worktree-port, tunnel, deploy, init references
branding/  logo + brand brief
```

The rule that keeps it honest: **`server/` owns no task or git logic — it imports
`core/`.** The CLI and the HTTP API are two thin front ends over one source of truth.

## Development

```sh
npm install
npm run api                 # Node API on :7440
cd frontend && npm start    # ng serve on :4200, proxies /api → :7440
```

Contributing guidelines, the layering invariants to keep, and the read-only
`/api` contract: [CONTRIBUTING.md](CONTRIBUTING.md). Deeper architecture and
local-setup notes: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Brand

The mark is a wheel of six checkmarks (tasks completed, cycling) around an
amber spark (the live agent at the hub). Indigo `#3F3D9E` does the work; amber
`#F59E0B` marks the one live thing. Full brief: [`branding/BRAND.md`](branding/BRAND.md).

## License

[MIT](LICENSE) © 2026 Ben Dehghan
