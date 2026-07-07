# Configuration

Everything cogyard assumes about your machine, and every knob you can turn. The
design goal: **sensible defaults for a common setup, an override for every
assumption, and nothing personal hardcoded.**

## How settings are resolved (first match wins)

1. **Environment variable** — per-invocation override.
2. **`~/.cogyard/config.json`** — persistent machine config (see schema below).
3. **Per-project committed file** — `.claude/worktree-config.json` (opt-in worktree
   wiring).
4. **Built-in default.**

## Environment variables

| Variable | Default | What it controls |
|---|---|---|
| `COGYARD_HOME` | `~/.cogyard` | Where all per-machine config + state lives (registry, ports, tunnels, usage, logs). Move it and everything follows. |
| `COGYARD_PROJECTS_ROOT` | `~/gitroot` | The conventional parent of your project clones, and the root of the shared task-store (`<root>/_tasks/<slug>`). Falls back to `config.json.projectsRoot` (settable in `/settings`), then `~/gitroot`. **Only a default + a label-shortener — never required.** A repo anywhere still works. |
| `COGYARD_DRIVER` | auto-detect → no-op | Which agent adapter is active (e.g. `claude`). Falls back to `~/.cogyard/config.json`, then auto-detection, then a built-in no-op (runs fine with no agent). See [DRIVERS.md](DRIVERS.md). |
| `COGYARD_LAUNCHD_PREFIX` | `com.cogyard` | Reverse-DNS prefix for the macOS LaunchAgents that `tunnel` creates (e.g. `com.cogyard.cloudflared.<name>`). Set it to your own domain if you prefer. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where `cogyard claude install` writes the driver's skills/commands. (Honored by Claude Code itself, too.) |
| `PORT` | `7440` | Port the portal server binds. `cogyard serve --port N` sets this for you. |
| `EDITOR` | `vi` | Editor opened by `cogyard tasks analyze --backfill`. |

Set by the host agent (you don't set these): `CLAUDE_PROJECT_DIR`, `CLAUDECODE`
(read by the worktree hooks and driver auto-detection), and `COGYARD_DEV_GUARD`
(internal orphan-guard set by `scripts/dev.sh`).

## `~/.cogyard/` — state files

All under `COGYARD_HOME`. Created on demand; safe to inspect, back up, or delete
(cogyard rebuilds what it can).

| Path | Contents |
|---|---|
| `projects.json` | The project registry (`cogyard tasks projects list`). |
| `ports.json` | Worktree port allocations **and** the allocatable ranges (see Ports). |
| `tunnels.json` | Tunnel-enabled projects + their hostnames. |
| `config.json` | Persistent machine config (schema below). Optional. |
| `usage/` | The token/cost usage ledger. |
| `logs/` | LaunchAgent + worktree-hook logs. |

### `config.json` schema

Optional. Recognized keys:

```jsonc
{
  "driver": "claude",        // active agent adapter
  "projectsRoot": "/abs/path",    // overrides the ~/gitroot default
  "defaults": {                   // New / Add-existing drawer prefill
    "kind": "single"              // one of: single | fullstack | static | library
  },
  "ui": {                         // portal UI preferences
    "weekStart": "sunday",        // activity heatmap first row: sunday | monday
    "dayStart": 0,                // first hour (0-23) on the punch-card axis
    "hiddenTabs": []              // project-tab-strip tabs to hide, e.g. ["board", "branches"]
  }
}
```

- `driver` — the active agent adapter, same values as `COGYARD_DRIVER`
  (the env var wins if both are set). Omit the file entirely to auto-detect.
- `projectsRoot` — overrides the `~/gitroot` default for `PROJECTS_ROOT` (below).
  `COGYARD_PROJECTS_ROOT` wins if both are set.
- `defaults` — the project-creation defaults the portal's New / Add-existing drawer
  prefills with (and the `/settings` view edits). An invalid `kind` is ignored,
  falling back to the built-in (`single`). The task store is always shared (the
  `normal` choice was removed), so there's no settable `store` default. There is no
  default git `remote` — it's inherently per-project, so the drawer's remote field
  is always entered fresh.
- `ui` — portal UI preferences, edited in `/settings`. `weekStart`/`dayStart` drive
  the activity views. `hiddenTabs` hides tabs from every
  project's tab strip — any of `tasks`, `board`, `branches`, `worktrees`, `graph`,
  `files`, `activity`, `settings` (unknown ids are ignored). Hiding only trims the
  strip: deep links to a hidden tab still render it, and the global `/settings`
  view (sidebar cog) is always reachable, so you can't lock yourself out.

All of this is editable in the portal under **Settings** (the same form is the
first-run setup wizard shown when no projects are registered yet). `COGYARD_HOME`
and `driver` are shown read-only there — `COGYARD_HOME` is where `config.json`
itself lives (env/CLI-only), and the driver selector arrives with a second
adapter.

**`PROJECTS_ROOT` resolution**: `COGYARD_PROJECTS_ROOT` env →
`config.json.projectsRoot` → `~/gitroot`, mirroring how `driver` resolves. It's
read at process start, so a `projectsRoot` change made in `/settings` (or by editing
the file) takes effect on the next server start — for the always-on portal, the
LaunchAgent reload in the deploy step.

## Per-project / per-worktree files

| File | Tracked? | Written by | Purpose |
|---|---|---|---|
| `.claude/worktree-config.json` | committed | you | **Opt-in.** Presence makes the SessionStart hook wire `.planet` / env files / `launch.json` so dev servers bind the worktree's reserved ports. |
| `.planet`, `.env.worktree`, `.env.claimed`, `.claude/launch.json` | gitignored | SessionStart hook | This worktree's reserved ports + dev env. Do not hand-edit — rewritten every session start. |
| `.tunnel` | committed marker | `cogyard tunnel` | Marks the project tunnel-enabled. |
| `_tasks/` | gitignored symlink | `init` / `convert` | The task store — a symlink into the shared store at `<PROJECTS_ROOT>/_tasks/<slug>`. (Shared is the only model; a legacy in-repo `_tasks/` dir is still detected by `doctor` and offered a `convert`.) |

## Ports

| Role | Default | Configure |
|---|---|---|
| Portal server (prod, behind a reverse proxy) | `7437` | `PORT` env / `cogyard serve --port` |
| Portal server (dev) | `7440` | `PORT` env / `--port` |
| Angular dev server (`npm start` in `frontend/`) | `4200` | Angular CLI |
| Per-worktree backend | first free in **4900–4999** | edit `ranges` in `~/.cogyard/ports.json` |
| Per-worktree frontend | first free in **9300–9399** | edit `ranges` in `~/.cogyard/ports.json` |

To change the worktree ranges, edit the `ranges` object in `~/.cogyard/ports.json`:

```json
{ "ranges": { "backend": [4900, 4999], "frontend": [9300, 9399] }, "allocations": {} }
```

## Tools & platform

> Run **`cogyard doctor`** to check this whole list at once — it reports ok/warn/fail
> for the Node version, `git`, a writable `~/.cogyard/`, the registry, and more, with
> a fix line per problem (it diagnoses only; it never changes anything).

**Required**

- **Node 22 LTS or newer** (Node 20 reached end-of-life on 2026-04-30; the engine
  uses global `fetch` and the built-in `node --test` runner, and the optional
  desktop build needs ≥ 22.12). Enforced via `engines` in `package.json`.
- **git** — used by nearly every command (init, the portal's git views, task sync,
  env detection). `cogyard` fails with a clear message if it's missing.
- **npm** — `npm i -g cogyard` (or, from a clone, install + `npm link`).

**Platform:** macOS and Linux. **Windows is supported via WSL** — the worktree
hooks are bash scripts and port-ownership checks use `lsof`, neither of which runs
on native Windows.

**Optional / feature-specific**

- **`lsof`** — `cogyard env port-owner` and dev-server ownership checks (Unix).
- **`cloudflared`** — the `tunnel` feature.
- **`launchctl`** + **`~/Library/LaunchAgents`** — macOS background services
  (the always-on portal recipe and tunnels).
- **`nvm`**, **`/opt/homebrew`** — referenced only by the example macOS LaunchAgent
  in `bin/` (an optional deployment recipe — see [DEPLOY.md](DEPLOY.md)).
- **`caddy`** — the documented reverse-proxy example for a clean hostname.
- **`python3`** — only the `static` project skeleton's default dev server.
