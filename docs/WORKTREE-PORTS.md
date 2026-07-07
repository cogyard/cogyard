# Worktree port management

Cross-project infrastructure that gives Claude Code worktrees their own port
pair so dev servers don't collide with the parent project (or with each other).

This file is the operational reference — what exists, how it
works, how to use it, how to debug.

---

## The problem it solves

Claude Code worktrees live at `<repo>/.claude/worktrees/<name>/` — sibling
working trees of the same repo, on different branches. Dev servers default to
fixed ports declared in env files or `.planet`. If you run `npm run dev` in
two worktrees at once, both bind the same port and the second fails. Claude
Code provides no built-in way to assign per-worktree ports.

## How it works at a glance

1. A user-level `SessionStart` hook is registered in `~/.claude/settings.json`. It fires on every Claude session start, machine-wide.
2. **Every Claude worktree gets a reserved port pair — universally, no opt-in.** Reservation is a registry row + a session briefing; it touches nothing in the repo. Non-worktree sessions exit in microseconds. (The old machine-level allowlist and the config-as-opt-in model are both retired.)
3. If the project additionally has a committed `.claude/worktree-config.json`, the hook wires the worktree (`.planet`, env files, `launch.json`) using project-specific strategies and pops a macOS notification with the URL. Without a config, the briefing still tells the session its reserved ports; nothing is written and no notification fires.
4. The hook also prints a self-contained briefing to stdout — Claude Code injects SessionStart hook stdout into the new session's system context, so the spawned Claude session "knows" the port assignments, the command to start servers, and the required `preview_stop` → `preview_start` sequence to make the Claude Desktop preview pane work.

## File layout

### User-level (this machine's installation)

| Path | Purpose |
|---|---|
| `~/.claude/settings.json` | Hook registered here under `hooks.SessionStart`. Also contains `mcp__Claude_Preview__*` permission allowlist entries so spawned sessions can drive the preview pane. |
| `~/gitroot/cogyard/hooks/worktree-session-start.sh` | 5-line bash shim (the path `settings.json` registers). Execs `worktree-session.mjs`; always exits 0 so a failing hook never blocks session start. |
| `~/gitroot/cogyard/hooks/worktree-session.mjs` | THE hook — single node entry point: gates, `_tasks` automount, universal port reservation, per-project env wiring, notification, session briefing. |
| `~/gitroot/cogyard/hooks/worktree-ports.mjs` | Port allocator: `allocate <path>`, `release <path>`, `list`, `gc`. Atomic writes via tmp+rename, exclusive lock via `O_EXCL` sentinel with 30-second stale-lock recovery. Liveness-checks ports via `lsof` before assigning. Also exports `findParentMarker` — the single project-discovery walk used by the whole pipeline. |
| `~/.cogyard/ports.json` | The registry. Per-machine state, NOT synced. Backend range `4900–4999`, frontend range `9300–9399` — disjoint from any other project's dev-server ports. |
| `~/.cogyard/logs/worktree-hook.log` | Append-only log of hook runs (one line per success or failure). |

### Per-project (in each opted-in repo, committed to main)

| Path | Purpose |
|---|---|
| `<repo>/.claude/worktree-config.json` | Tells the hook how to set up worktrees for this project (schema below). **Must be committed to main** so worktrees branched from main find it. |
| `<repo>/.gitignore` | Should ignore `.claude/launch.json` (which the hook writes per-worktree). |

### Per-worktree (written by the hook every session start; gitignored)

| Path | Purpose |
|---|---|
| `<worktree>/.planet` | If `kind=planet`: `PLANET_NAME`, `PORT`, `FRONTEND_PORT`. Backend/frontend read this. |
| `<worktree>/.env.development` | Per `env_files` strategy (symlink, copy, or merge). |
| `<worktree>/.env.production` | Same. |
| `<worktree>/.claude/launch.json` | Names a launch entry that runs the project's `dev_script` and forwards `preview_port_var`'s allocated port. Read by Claude Desktop's `Claude_Preview` MCP. |

## Per-project config schema

```json
{
  "project_name": "myproject",
  "kind": "planet",                  // "planet" (project has .planet at root) or "single"
  "dev_script": "npm run dev:no-tunnel",
  "launch_name": "dev:no-tunnel",    // name used inside .claude/launch.json
  "port_vars": {                     // env-var-name → allocated side ("backend" | "frontend")
    "PORT": "backend",
    "FRONTEND_PORT": "frontend"
  },
  "preview_port_var": "FRONTEND_PORT",   // which var holds the port the preview pane iframes
  "planet_name_var": "PLANET_NAME",      // (kind=planet only)
  "planet_name_template": "{parent}-{worktree}",  // (kind=planet only)
  "env_files": [
    { "source": "../.env.development", "target": ".env.development", "strategy": "symlink" },
    { "source": "../.env.production",  "target": ".env.production",  "strategy": "symlink" }
  ]
}
```

`env_files.strategy`:
- **`symlink`** — target is a symlink to source (resolved relative to the project root). Cheap; parent edits visible immediately. Used when the env file lives outside the worktree (planet's parent dir).
- **`copy`** — target is a file copy of source. Frozen at hook-run time.
- **`merge`** — target = source contents + the `port_vars` assignments appended at the end. Last-assignment-wins semantics work for both `dotenv` and bash `source`. Used when the env file lives at the repo root (single-clone projects).

### Projects currently opted in

| Project | Path prefix | `kind` | Env strategy | Dev script | Port vars |
|---|---|---|---|---|---|
| `projectA` | `~/projects/projectA/` | `planet` | `symlink` (parent dir) | `npm run dev:no-tunnel` | `PORT`, `FRONTEND_PORT` |
| `projectB` | `~/projects/projectB/` | `single` | `merge` (repo root) | `npm run dev` | `BACKEND_PORT`, `FRONTEND_PORT` |

## Runtime flow on a new worktree session

1. Claude Code opens a session. SessionStart hook fires.
2. `worktree-session-start.sh` (shim) execs `worktree-session.mjs`, which runs:
   1. **Worktree-path check** (bash). `$CLAUDE_PROJECT_DIR` must contain `/.claude/worktrees/`. Else `exit 0`.
   2. **Allocate — always.** Every worktree gets a reserved pair before any config is consulted.
   3. **Config walk.** Walks up parents to find the project root containing `.claude/worktree-config.json`. Not found → print a reserved-ports briefing (so the session knows its ports), write nothing, no notification, `exit 0`. Found → continue to full wiring below.
   4. `node worktree-ports.mjs allocate "$CLAUDE_PROJECT_DIR"` → returns JSON `{ backend, frontend, parent_planet, worktree_name }`. Idempotent (same path → same entry). Runs `gc` first to recycle dead worktrees. Liveness-checks via `lsof` so allocated ports are actually free.
   5. `python3 worktree-setup.py` writes the per-config files (`.planet` if `kind=planet`, env files per strategy, `.claude/launch.json`).
   6. Sends macOS notification: title `Worktree ready: <worktree-name>`, body `Frontend: http://localhost:<P>\nBackend: :<B>`.
   7. Prints a multi-line briefing to stdout (becomes new session's context).
3. User (or Claude in the spawned session, per the worktree carve-out in the project's `CLAUDE.md`) runs `dev_script`. Servers bind to the allocated ports.
4. Preview pane in Claude Desktop iframes `http://localhost:<preview_port>` once servers are bound.

**Failure policy**: the hook always `exit 0`. Any failure (corrupt registry, disk full, allocator crash, port exhaustion, missing config) is logged to `worktree-hook.log` and surfaced via a `Worktree port hook FAILED` notification. A non-zero exit would block Claude session start — strictly worse than an unallocated worktree.

## Permanent dev server — REMOVED (reverted 2026-06-24)

**This feature is gone, permanently. It must never come back.**

A launchd KeepAlive "supervisor" was added (`hooks/worktree-supervisor.mjs`,
agent `com.cogyard.wtsup`) that the SessionStart hook installed
automatically to keep worktree dev servers running in the background across
crashes/logout/reboot. It was claimed to be "hard-bounded so it can never fan
out." **That was false.** On 2026-06-24 it spawned a restart storm of roughly 100
`npm` / `nodemon` / `node` processes across multiple projects (dozens in a
single project alone) and froze the machine, which had to be recovered by hand.

It has been torn out in full: the supervisor script, the `ensureSupervisorInstalled`
call + `keepalive` stamp in the SessionStart hook, the `keepalive` CLI subcommand,
the no-ad-hoc-server block-hook and its `hooks.json` entry, the launchd agent +
plist, and the `~/.cogyard/supervisor.json` config — all deleted. A proposed
follow-up ("make the supervisor enforce itself") is abandoned.

**Do not reintroduce any of it.** No supervisor. No auto-installed launchd agent.
No background process that starts servers on its own. No "disabled by default"
mode, no opt-in flag, no config switch — there is no acceptable version of this.
A worktree's dev server is started by a human or the `Claude_Preview` MCP
(`preview_start`) when needed and stopped when done. **Nothing the worktree system
does may launch a long-running process by itself.**

## What the spawned session sees (briefing format)

The hook prints a briefing to stdout. SessionStart hook stdout is injected into the new session's context as additional system context. The briefing names the worktree + ports and tells the session to start the dev server itself via the `Claude_Preview` MCP (`preview_start`) — nothing keeps a server running in the background.

Generated text lives in `worktree-session.mjs`. To change wording, edit that script. Concrete shape:

```
=== Worktree dev environment ===
Project       : myproject
Worktree      : keen-mayer-c3ead5
Worktree path : ~/projects/myproject/.claude/worktrees/keen-mayer-c3ead5
Project root  : ~/projects/myproject

Allocated ports:
  backend  port = 4900
  frontend port = 9300

# Dev server
  Start it for this session via the Claude_Preview MCP: preview_start name="dev".
  Nothing keeps a server running across sessions — start it when you need it.

# Direct URLs
  Frontend : http://localhost:9300
  Backend  : http://localhost:4900
...
```

## Onboarding a new project

Ports are reserved for every worktree automatically — "onboarding" only means enabling full env-file wiring:

1. Write `<repo>/.claude/worktree-config.json` per the schema above.
2. Add `.claude/launch.json` to the project's `.gitignore`.
3. **Commit `worktree-config.json` and the gitignore change to main.** Without this, worktrees branched from main won't find the config when the hook walks up. (Real bug we hit during initial setup.)

## Operating and debugging

| Need | Command |
|---|---|
| What's allocated? | `node ~/gitroot/cogyard/hooks/worktree-ports.mjs list` |
| Free a stale entry | `node ~/gitroot/cogyard/hooks/worktree-ports.mjs release <abs-path>` |
| Free all dead worktrees | `node ~/gitroot/cogyard/hooks/worktree-ports.mjs gc` |
| Hook recent activity | `tail -f ~/.cogyard/logs/worktree-hook.log` |
| Run hook manually (e.g. to see briefing) | `CLAUDE_PROJECT_DIR=<worktree> bash ~/gitroot/cogyard/hooks/worktree-session-start.sh` |
| Stale lockfile (>30s) | Auto-recovered on next allocate. Manual: `rm ~/.cogyard/ports.json.lock` |

## Known limitations / caveats

- **The hook fires for every Claude session on the machine.** The worktree-path + config-existence gates are fast (a few stats), but they do run every time. Cost: negligible.
- **`worktree-config.json` MUST be on main**, not just on a feature branch. The hook walks up to the parent repo's working tree (which is checked out on main).
- **`Claude_Preview` MCP returns stale "reused" handles** across sessions even when the underlying npm process has died. If `preview_start` reports a reused handle but nothing is listening, run `preview_stop` then `preview_start` again.
- **Preview MCP permissions** must be in `~/.claude/settings.json` `permissions.allow` (13 entries for `mcp__Claude_Preview__*` are already there).
- **No Cloudflare tunnel for worktrees.** Tunnels are pre-provisioned per top-level project. Worktree dev servers are localhost-only.
- **Cookie collisions** between two simultaneously running worktrees on `localhost:*`: they share the cookie jar because cookies ignore port. Workaround: separate browser profiles.
- **No process-level isolation.** Two worktrees can run their own dev servers on distinct ports, but they share the same database (per the parent project's env file) by default.
