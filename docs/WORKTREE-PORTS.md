# Worktree port management

Cross-project infrastructure that gives Claude Code worktrees their own port
pair so dev servers don't collide with the parent project (or with each other).

This file is the operational reference — what exists, how it
works, how to use it, how to debug.

---

## The problem it solves

Claude Code worktrees live at `<repo>/.claude/worktrees/<name>/` — sibling
working trees of the same repo, on different branches. Dev servers default to
fixed ports declared in env files. If you run `npm run dev` in
two worktrees at once, both bind the same port and the second fails. Claude
Code provides no built-in way to assign per-worktree ports.

## How it works at a glance

1. A user-level `SessionStart` hook is registered in `~/.claude/settings.json`. It fires on every Claude session start, machine-wide.
2. **Every Claude worktree gets a reserved port pair — universally, no opt-in.** Reservation is a registry row + a session briefing; it touches nothing in the repo. Non-worktree sessions exit in microseconds. (The old machine-level allowlist and the config-as-opt-in model are both retired.)
3. If the project additionally has a committed `.cogyard/worktree.json`, the hook wires the worktree (env files, `launch.json`) using project-specific strategies and pops a macOS notification with the URL. Without a config, the briefing still tells the session its reserved ports; nothing is written and no notification fires.
4. The hook also prints a self-contained briefing to stdout — Claude Code injects SessionStart hook stdout into the new session's system context, so the spawned Claude session "knows" the port assignments, the command to start servers, and the required `preview_stop` → `preview_start` sequence to make the Claude Desktop preview pane work.

## File layout

### User-level (this machine's installation)

| Path | Purpose |
|---|---|
| `~/.claude/settings.json` | Hook registered here under `hooks.SessionStart`. Also contains `mcp__Claude_Preview__*` permission allowlist entries so spawned sessions can drive the preview pane. |
| `~/gitroot/cogyard/hooks/worktree-session-start.sh` | 5-line bash shim (the path `settings.json` registers). Execs `worktree-session.mjs`; always exits 0 so a failing hook never blocks session start. |
| `~/gitroot/cogyard/hooks/worktree-session.mjs` | THE hook — single node entry point: gates, task-store link automount (`.cogyard/tasks`), universal port reservation, per-project env wiring, notification, session briefing. |
| `~/gitroot/cogyard/hooks/worktree-ports.mjs` | Port allocator: `allocate <path>`, `release <path>`, `list`, `gc`. Atomic writes via tmp+rename, exclusive lock via `O_EXCL` sentinel with 30-second stale-lock recovery. Liveness-checks ports via `lsof` before assigning. Also exports `findParentMarker` — the single project-discovery walk used by the whole pipeline. |
| `~/.cogyard/ports.json` | The registry. Per-machine state, NOT synced. Backend range `30000–30999`, frontend range `31000–31999` — disjoint from any other project's dev-server ports. |
| `~/.cogyard/logs/worktree-hook.log` | Append-only log of hook runs (one line per success or failure). |

### Per-project (in each opted-in repo, committed to main)

| Path | Purpose |
|---|---|
| `<repo>/.cogyard/worktree.json` | Tells the hook how to set up worktrees for this project (schema below). **Must be committed to main** so worktrees branched from main find it. The old `<repo>/.claude/worktree-config.json` is no longer read. |
| `<repo>/.gitignore` | Should ignore `.claude/launch.json` (which the hook writes per-worktree). |

### Per-worktree (written by the hook every session start; gitignored)

| Path | Purpose |
|---|---|
| `<worktree>/.env.development` | A link to the file `env_files` names in the project root — never a copy. |
| `<worktree>/.env.production` | Same. |
| `<worktree>/.claude/launch.json` | **The file `preview_start` reads while the chat is inside this worktree.** The preview tool reads `<chat's current folder>/.claude/launch.json` and nothing else (tested 2026-10-17 to 2026-10-19, Claude desktop 2.42304.0, Claude Code 2.1.296). The hook writes exactly one entry here, `wt-<worktree-name>`, the name the briefing gives you, replacing whatever was there: the desktop app drops a copy of the main checkout's file into a worktree it creates, and that copy's entries would run the main checkout's servers. A config with no dev command gets no file. Never hand-edit it; the hook rewrites it on every run. Earlier versions of the hook deleted this file, having concluded from an August test that the tool read the main checkout's file from a worktree; what that test most likely saw was the app's copy. |
| `<main checkout>/.claude/launch.json` | The same `wt-<worktree-name>` entry for every worktree, so a chat in the main checkout can start any worktree's server. Entries the hook wrote carry `cogyardWorktree` (absolute worktree path) and are swept on the next hook run once that worktree is gone, and removed as cleanup removes the worktree. |

## Per-project config schema

```json
{
  "project_name": "myproject",
  "dev_script": "npm run dev:no-tunnel",
  "launch_name": "dev:no-tunnel",    // name used inside .claude/launch.json
  "port_vars": {                     // env-var-name → allocated side ("backend" | "frontend")
    "PORT": "backend",
    "FRONTEND_PORT": "frontend"
  },
  "preview_port_var": "FRONTEND_PORT",   // which var holds the port the preview pane iframes
  "env_files": [
    { "source": ".env.development", "target": ".env.development" },
    { "source": ".env.production",  "target": ".env.production" }
  ]
}
```

**No `dev_script` = no dev server.** A project that reserves ports but has
nothing to serve — an app built in Xcode, firmware flashed from PlatformIO —
omits `dev_script` (and `launch_name` / `preview_port_var`). The hook then
registers no preview entry (dropping any old one for that worktree), briefs
"No dev server", and the Stop-hook server check leaves it alone. A missing
`dev_script` used to mean `npm run dev` silently — a command such a project
does not have. A kind declares this with `devScript: null` (see
[`PROJECT-INIT.md`](PROJECT-INIT.md#kinds)).

A `kind` key may still sit in older configs (`"kind": "single"`). The hook no
longer reads it: its only other value, `planet`, served the multi-clone layout
retired in 2026-10, and the scaffold no longer writes it. It is harmless to
leave or delete.

`env_files`: each entry's `target` in the worktree becomes a **link** to its
`source`, resolved relative to the project root. A missing source is skipped (many
projects have no local `.env.production`). Every worktree reads the same file, so
an edit in one is an edit in all of them and in the main checkout. Where that file
really lives is the project's business — it may itself be a link to a folder
outside the repo; the hook neither knows nor cares.

**There is no copy option.** `strategy: "copy"` and `strategy: "merge"` (a real
file written into each worktree) were removed, for two reasons:

- A copy is one more place a secret sits, and copies drift. A worktree's copy is
  frozen at session start; nothing refreshes or deletes it.
- Writing a copy (temp file + rename) **replaced whatever was at the target,
  including a link** — so a project that kept its env files outside the repo had
  them duplicated back into every worktree at each session start, silently.

A config that still names either is refused, and the hook's failure notice says
which entry and that the fix is deleting its `"strategy"` key. `"strategy":
"symlink"` is still accepted, and means the same as no key.

**No env file carries a port — `ports.json` is the only place one exists.**
`merge` used to append the `port_vars` assignments to `.env.worktree`, and that
copy rotted: in one observed case a worktree's `.env.worktree` said 30000/31000
while its actual allocation was 30045/31046, so its dev server bound the wrong
ports and the portal's link to it was dead, with nobody noticing. Dev
scripts ask `cogyard env ports` (next section) instead. A dev script that still
reads `$PORT` out of an env file gets nothing from it, and inside a worktree must
not fall back to a default — that is the collision this replaced.

## `cogyard env ports` — how a dev script learns which ports to bind

The sanctioned way, for any project, with no new file in its repo:

```sh
# In a dev script:
ports=$(cogyard env ports --shell) || exit 1
eval "$ports"

# Inline, in an npm "scripts" entry:
eval "$(cogyard env ports --shell || echo 'exit 1')" && vite
```

`--shell` prints `export NAME=value` for each port, under the names **this
project declares** in its `.cogyard/worktree.json` `port_vars` — `PORT` /
`FRONTEND_PORT` here, `BACKEND_PORT` / `FRONTEND_PORT` elsewhere, a single
`PLANET_PORT` in a project that has one port. A project declaring one port gets
one line. `export` rather than a bare assignment because the server runs as a
child process, which never sees a plain shell variable. Without `--shell` it
prints the same answer for a human to read.

**Mind the `|| echo 'exit 1'` in the inline form.** `eval "$(cmd)"` reports the
status of the *eval*, not of `cmd` — so a failed lookup would eval an empty
string and the script would sail on with whatever ports were lying around,
which is the exact failure this command exists to prevent. Capturing into a
variable first (the dev-script form above) has the same effect and reads better
where there is room for two lines.

**It never guesses — neither the number nor the name.** Inside a worktree, an
allocation it cannot read is a hard error: non-zero exit, nothing on stdout, and
a stderr message naming `cogyard hook session-start .`. A default in a
worktree is how two of them land on one port. The names get the same treatment:
if the project declares no `port_vars`, it refuses rather than picking names,
because an assignment under a name the project does not read binds nothing while
looking like it worked. Outside a worktree there is nothing to collide with, so
it prints no assignment at all and the repo's own defaults stand.

The rule lives in `core/ports.mjs`, and `cli/env.mjs` only prints it. cogyard's
own `scripts/dev.sh` calls its in-repo `cli/env.mjs` rather than `cogyard` on
PATH, because the installed binary is a symlink to the main checkout and a
worktree asking it would be answered by main's code.

### When cogyard is not installed — and the shim for repos with several dev entries

The command answers "no allocation" (fail) and "not a worktree" (silence) by
itself, so no caller needs its own worktree detection. The one case it cannot
answer is **cogyard not being on PATH at all** — a missing binary cannot be
asked to tolerate its own absence, and the inline forms above turn that into a
dead dev script (`command not found` → non-zero → `exit 1`). A plain clone on a
machine without cogyard should still run on the repo's own defaults, because
with no cogyard there are no worktrees and nothing to collide with.

That check belongs to the caller's shell. A project with one dev entry can
in-line it; a project with several — one onboarded project has seven npm scripts
that each need the ports — should put it in **one `scripts/dev-ports.sh` per repo**
so the policy is stated once per project rather than seven times. **Copy these
lines verbatim** rather than writing a variant, so the six repos that need it do
not drift apart:

```sh
#!/bin/sh
# Print `export NAME=value` for the ports a dev server in THIS checkout must
# bind, asking cogyard — which owns ~/.cogyard/ports.json, the one place a
# worktree's allocation exists. Never reads a copy; copies rot, and a rotted
# copy is how two worktrees silently land on one port.
#
# Two failure modes, deliberately different:
#   cogyard NOT INSTALLED -> warn, print nothing, exit 0; the repo's own
#     defaults stand (no cogyard means no worktree, so nothing can collide).
#   cogyard installed but the lookup FAILS -> fatal, print nothing. Inside a
#     worktree that means the allocation could not be read, and defaulting there
#     is the collision this replaces. cogyard's stderr names the fix.
if ! command -v cogyard >/dev/null 2>&1; then
  echo "cogyard not on PATH — no port allocation requested; this repo's defaults stand." >&2
  exit 0
fi
cogyard env ports --shell || exit 1
```

Called from an npm script — the `|| echo 'exit 1'` is load-bearing for the
reason given above:

```
eval "$(sh scripts/dev-ports.sh || echo 'exit 1')" && <the existing dev command>
```

The shape that works in practice: one shim, every dev entry prefixed with the
line above, and a `//DEV-PORTS-HELP` note in the project's `package.json`
explaining the trap to the next reader — so nobody "simplifies" the prefix back
into the naive `eval "$(…)"` form.

This repo is the exception that needs no shim: `scripts/dev.sh` calls its
in-repo `cli/env.mjs`, which is present by definition.

### Projects currently opted in

| Project | Path prefix | Env files linked | Dev script | Port vars |
|---|---|---|---|---|
| `projectA` | `~/projects/projectA/` | `.env.development`, `.env.production` | `npm run dev:no-tunnel` | `PORT`, `FRONTEND_PORT` |
| `projectB` | `~/projects/projectB/` | none | `npm run dev` | `BACKEND_PORT`, `FRONTEND_PORT` |

## Runtime flow on a new worktree session

1. Claude Code opens a session. SessionStart hook fires.
2. `worktree-session-start.sh` (shim) execs `worktree-session.mjs`, which runs:
   1. **Worktree-path check.** The target is found as below (see "How the hook finds its worktree"), resolved to an absolute path (relative is fine; `.` is the usual manual form), then must match the driver's worktree layout, `<repo>/.claude/worktrees/<name>`. Else `exit 0`, having written nothing. Whether it *says* so depends on who asked: an explicit path argument prints `cogyard: nothing to wire`, naming both the path given and what it resolved to; the automatic form stays silent, because it fires on every session and most of those are ordinary checkouts.
   2. **Allocate — always.** Every worktree gets a reserved pair before any config is consulted.
   3. **Config walk.** Walks up parents to find the project root containing `.cogyard/worktree.json`. Not found → print a reserved-ports briefing (so the session knows its ports), write nothing, no notification, `exit 0`. Found → continue to full wiring below.
   4. `node worktree-ports.mjs allocate <worktree path>` → returns JSON `{ backend, frontend, parent_planet, worktree_name, hostname }` (`parent_planet` is the parent project's name — an old key name kept because every `ports.json` row carries it). Idempotent (same path → same entry). Runs `gc` first to recycle dead worktrees. Liveness-checks via `lsof` so allocated ports are actually free.
   5. The hook writes the per-config files: a link for each `env_files` entry, and the worktree's entry in both the worktree's own `.claude/launch.json` and the main checkout's.
   6. Sends macOS notification: title `Worktree ready: <worktree-name>`, body `Frontend: http://localhost:<P>\nBackend: :<B>`.
   7. Prints a multi-line briefing to stdout (becomes new session's context).
3. User (or Claude in the spawned session, per the worktree carve-out in the project's `CLAUDE.md`) runs `dev_script`, which asks `cogyard env ports` for the allocation. Servers bind to the allocated ports.

### How the hook finds its worktree, for each kind of chat

`hooks/worktree-session.mjs` takes the first of these that applies:

1. **A path given as an argument** (`cogyard hook session-start .`). Always wins.
2. **The chat's folder from Claude Code's startup details.** When Claude Code runs the hook on its own, it writes a small JSON block to the hook's stdin whose `cwd` is the chat's folder. If that folder is inside a worktree, the hook uses the worktree's own folder (a chat started in a subfolder wires the whole worktree). Read only when no argument was given; a terminal on stdin is never read, and an open stdin that stays silent is given up after one second, so a hand run cannot hang.
3. **`$CLAUDE_PROJECT_DIR`**, as before.

| Kind of chat | What wires it | Tested |
|---|---|---|
| Started in the main checkout | nothing: every source names the main checkout, so the hook stays silent | 2026-11-09 |
| Started by the desktop app inside its own worktree (a side session with its own worktree, or the worktree checkbox) | the stdin `cwd` (item 2), automatically at start | 2026-11-09 probe, with the startup details replayed through the fixed hook |
| Started in the main checkout, then moved into a worktree with EnterWorktree (every `pickup-task` pickup) | nothing automatic: SessionStart does not re-fire on EnterWorktree, so `pickup-task` runs `cogyard hook session-start .` by hand (item 1) | unchanged |
| Started with the `claude` CLI from inside a worktree | the stdin `cwd`, or `$CLAUDE_PROJECT_DIR` if that is the worktree | not re-tested |

Why item 2 exists: in a chat the desktop app (4.23118.1) starts inside a worktree, both `$CLAUDE_PROJECT_DIR` and the hook's own working directory are the MAIN checkout. Only the stdin `cwd` names the worktree (probed 2026-11-09). Before this, such chats logged `not a worktree, nothing wired: <main checkout>` and got no ports, no task-store link, no worktree `launch.json` and no briefing. The stdin JSON's shape is Claude Code's; the hook reads it directly, as the PreToolUse hooks do, next to its `$CLAUDE_PROJECT_DIR` read.
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
  backend  port = 30000
  frontend port = 31000

# Dev server
  preview_start name="wt-<worktree-name>"   (written by the hook to the
  worktree's own launch.json and the main checkout's — see the caveats section)
  When the work has something to look at, start it and leave it running until
  the branch merges; stop it after the merge. Nothing restarts a server that dies.

# Direct URLs
  Frontend : http://localhost:31000
  Backend  : http://localhost:30000
...
```

## Onboarding a new project

Ports are reserved for every worktree automatically — "onboarding" only means enabling full env-file wiring:

1. Write `<repo>/.cogyard/worktree.json` per the schema above (`cogyard init` / `cogyard onboard` write one for you).
2. Add `.claude/launch.json` to the project's `.gitignore`.
3. **Commit `.cogyard/worktree.json` and the gitignore change to main.** Without this, worktrees branched from main won't find the config when the hook walks up. (Real bug we hit during initial setup.)

## Operating and debugging

| Need | Command |
|---|---|
| What's allocated? | `node ~/gitroot/cogyard/hooks/worktree-ports.mjs list` |
| Free a stale entry | `node ~/gitroot/cogyard/hooks/worktree-ports.mjs release <abs-path>` |
| Free all dead worktrees | `node ~/gitroot/cogyard/hooks/worktree-ports.mjs gc` |
| Hook recent activity | `tail -f ~/.cogyard/logs/worktree-hook.log` |
| Run hook manually (e.g. to see briefing) | `cogyard hook session-start .`, from inside the worktree |
| Same, for another worktree | `cogyard hook session-start <path>` — relative or absolute |
| Stale lockfile (>30s) | Auto-recovered on next allocate. Manual: `rm ~/.cogyard/ports.json.lock` |

## The main checkout is where the default branch lives, and only that

A project's main checkout — the first entry of `git worktree list`, the directory
the project is registered at — is the permanent home of its default branch. It is
never used to work on a feature branch. Every branch gets a worktree instead.

**Why the rule exists.** Sessions are isolated from each other in every way except
the filesystem. Two sessions rooted at the same directory share ONE working copy,
and a branch is not a per-process property — it is one file, `.git/HEAD`. Whichever
session runs `git checkout` rewrites it for all of them at once, silently, along
with the files on disk. A session that read its branch a minute earlier is now
somewhere else and does not know it. That is how a merge lands on another session's
branch. Linked worktrees do not have this problem: each has its own `HEAD`, and git
refuses to check the same branch out twice (`fatal: 'X' is already checked out at
…`). The main checkout was the one place left without that protection.

**What is enforced.** A `PreToolUse(Bash)` hook (`cogyard hook guard-branch-switch`,
implemented in `hooks/pretooluse-guard-branch-switch.mjs`) refuses any command that
would move HEAD in a registered project's main working tree, unless it moves HEAD to
the default branch:

| In a registered project's MAIN checkout | |
|---|---|
| `git checkout <other-branch>` · `git checkout -b …` · `git switch …` · `--detach` · `git checkout -` | refused |
| `git checkout <default-branch>` | allowed — the merge sequence re-asserts it on every run, and it is idempotent |
| `git checkout -- <path>` · `git checkout <ref> -- <path>` · `git checkout -p` | allowed — restoring files does not move HEAD |
| anything in a linked worktree, or in a repo cogyard does not have registered | allowed — not this hook's business |

**What is NOT enforced, deliberately.** The hook only sees the agent's shell. A human
terminal, an editor, or any other process can still switch the branch, and no git
mechanism can prevent it: git has no `pre-checkout` hook, and a `reference-transaction`
hook — which can abort ref updates — does not fire on a branch switch at all (tested;
it fires on `git branch`, so the negative result is not a wiring mistake). This is a
seatbelt against the accident that actually happens, and the human escape hatch is
the same mechanism.

**Working on a branch,** then, is always: make a worktree (`git worktree add`, or the
agent's own worktree tool), or address another one with `git -C <that worktree>`.

## Known limitations / caveats

- **The hook fires for every Claude session on the machine.** The worktree-path + config-existence gates are fast (a few stats), but they do run every time. Cost: negligible.
- **The worktree config MUST be on main**, not just on a feature branch. The hook walks up to the parent repo's working tree (which is checked out on main).
- **`Claude_Preview` MCP returns stale "reused" handles** across sessions even when the underlying npm process has died. If `preview_start` reports a reused handle but nothing is listening, run `preview_stop` then `preview_start` again.
- **Preview MCP permissions** must be in `~/.claude/settings.json` `permissions.allow`. The 13 entries there are `mcp__Claude_Preview__*`, and the tool that actually ships is `mcp__Claude_Browser__*` — so those 13 grant nothing. Not yet cleaned up; they are inert, not harmful.
- **Nothing enforces that a worktree's dev server is up — the briefing asks for it.**
  The owner looks at a worktree AFTER the work by clicking its port in the
  Worktrees tab, so a session that started a server for its own verification and
  then killed it leaves them nothing to look at. The session-start briefing tells
  the session the rule: if the work has something to see, leave the server
  running until the branch merges, and stop it after the merge. An earlier `Stop`
  hook that blocked the session whenever the port was down was removed: it could
  not tell work with something to see from work with nothing to see (docs, hooks,
  an iOS app), so it fired in nearly every worktree session, and as shipped it
  fired on every reply. A supervisor that restarts servers was considered earlier
  and explicitly rejected.
- **`preview_start` reads only `<chat's current folder>/.claude/launch.json`** (tested 2026-10-17 to 2026-10-19). Inside a worktree that is the worktree's own file, which is why the hook writes the entry there as well as in the main checkout. Before 2026-10-19 the hook deleted the worktree's file, so every chat inside a worktree, whether it moved in with EnterWorktree or the app started it there, failed with "No .claude/launch.json found". **If the briefed name is not found from inside a worktree, the hook has not run for it:** it does not re-fire after EnterWorktree. (A chat the app starts in a worktree is wired automatically from the stdin `cwd` since 2026-11-09; see "How the hook finds its worktree".) Run `cogyard hook session-start .` from inside the worktree and retry. The earlier rule here ("resolves the MAIN CHECKOUT's file, never the worktree's") came from an August test. **Never hand-write an entry.** Seventeen sessions hand-wrote one instead of reporting the failure, and a worktree session is isolation-guarded out of the main checkout anyway, so hand-writing now fails outright. The hook owns that write precisely because it runs before the guard applies.
- **No Cloudflare tunnel for worktrees.** Tunnels are pre-provisioned per top-level project. Worktree dev servers are localhost-only.
- **Cookie collisions** between two simultaneously running worktrees on `localhost:*`: they share the cookie jar because cookies ignore port. Workaround: separate browser profiles.
- **No process-level isolation.** Two worktrees can run their own dev servers on distinct ports, but they share the same database (per the parent project's env file) by default.
