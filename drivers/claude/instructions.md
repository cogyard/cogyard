# cogyard — operating rules (Claude Code)

cogyard is a markdown-task + claims + worktree-ports engine. These are the rules a
Claude Code session needs to drive it correctly. (This file is the canonical,
shippable copy; `cogyard claude install --rules` writes it into a user's CLAUDE.md
so the rules are present every session — a plugin cannot inject always-on context
on its own.)

## What cogyard is

- **Task files** live at `.cogyard/tasks/NNN-<slug>.md` per project — YAML frontmatter
  (`id`, `slug`, `status`, `depends_on`, `touches_paths`, an `env:` claim block, …)
  plus a markdown body (scope checklist, acceptance, out-of-scope).
- **The engine** is reached through the `cogyard` CLI (on PATH via `npm i -g
  cogyard`, or `npm link` in a clone). `cogyard` is the agent-agnostic public
  contract — skills, hooks, and humans all call it; never reach into the repo by path.
- **Config + state** live under `~/.cogyard/` (`projects.json`, `ports.json`, …).

## Skills (auto-trigger on phrasing)

They trigger on what the user *says*, not just the slash name. Names are bare here
(`pickup-task`); installed with `cogyard claude install` they're `cogyard-pickup-task`
(the `/cogyard` command keeps its name), and under a `/plugin` marketplace install
they're namespaced (`cogyard:pickup-task`) — either way never someone else's name.
When this file says to use a skill, use cogyard's, under whichever name your skill
list shows it.

- `pickup-task` — "do task NNN", "pick up X", "work on Y". Runs the full pickup
  ritual: staleness gate → sync → env detect → claim check → task-named worktree →
  drift check → claim → work → release.
- `write-task` — "file this as a task", "park for later", "spec this out", "make this
  a task", "this is a new task". Authors a new shelf-stable `NNN-*.md` task file.
- `merge-to-main` — "merge it", "merge to main". Rebases and bumps as the project's
  switches say, builds, merges, builds on main, pushes, then closes the task.
- `handoff` — carry in-flight work across a session boundary.
- `commit` — commits following project convention; auto-prepends the active cogyard
  task id (`[#NN]`) so `git log` cross-links commits → tasks.
- `debt-cleanup` — structured codebase cleanup that produces a task doc.
- `autopilot` — "run the backlog", "run this unattended". Works many tasks without
  the owner: order from `cogyard tasks plan`, one worker per task in its own
  worktree, every claim verified before merge, stops before `(you: …)` steps.
  Starts only on the owner's "go" for a named set of tasks; project specifics
  come from the project's `CLAUDE.md`.

## Hooks (this plugin installs)

- **SessionStart** (`cogyard hook session-start`) → reserves a unique port pair for
  every Claude worktree and auto-mounts the `.cogyard/tasks` link to the shared store. SessionStart does
  NOT re-fire for worktrees created mid-session (e.g. via EnterWorktree) — after
  creating one, run the wiring manually, from inside the worktree:
  `cogyard hook session-start .` (the worktree-isolation sandbox refuses a `"$PWD"`
  argument as too complex to verify; a bare `.` it accepts).
- **PreToolUse (Edit|Write|MultiEdit)** (`cogyard hook validate-frontmatter`) →
  refuses a write that would put something other than a task file or attachment
  in a task store, add a task-frontmatter or checkbox error, change `status` into or
  out of DONE/ENOUGH or change `done_date` (use `cogyard tasks close` / `reopen`),
  or set, change or clear a claim field (`branch`, `claimed_at`, `claimed_by` — use
  `cogyard env claim` / `release`). It also refuses a hand edit to a linked
  worktree's launch file, which the SessionStart hook rewrites on every run.
- **PreToolUse (Bash)**, four guards:
  - `cogyard hook guard-branch-switch` → in a registered project's MAIN working
    tree, refuses a `git checkout` / `git switch` that would move HEAD anywhere
    except the default branch. That directory is one working copy shared by every
    session and by anything that builds from it, so a branch switch there rewrites
    `.git/HEAD` for all of them at once. Returning to the default branch is always
    allowed (the merge sequence re-asserts it). Linked worktrees are untouched —
    each already has its own HEAD.
  - `cogyard hook guard-dev-server` → in a linked worktree, refuses starting the
    dev server from the shell; start it with the preview tool, which binds the
    worktree's own ports.
  - `cogyard hook guard-task-store` → refuses a git command that writes inside a
    task store (commit, revert, reset, …); change a store only through cogyard's
    commands. Reading it with git is always allowed.
  - the worktree guard (plugin-local; also on EnterWorktree / ExitWorktree) →
    refuses a hand-made `git worktree add -b` (except autopilot's shape, from the
    main checkout), and asks before removing a worktree or entering one the app
    did not name.
- **UserPromptSubmit** → routes "write/file/make a task"-style prompts to `write-task`.
  It adds instructions to the prompt; it cannot block anything.
- **Every chat event** (`cogyard hook live-state`) → records what each chat is
  doing for the portal; never blocks. **SessionEnd** also runs `cogyard usage
  collect --hook`.

Refusing hooks are enforced by Claude Code itself; the model cannot skip them. They
fail open — a hook that can't parse its input, errors or times out lets the call through.

## Hard rules — do not violate

- **Never hand-edit `branch` / `claimed_at` / `claimed_by`** (or `~/.cogyard/claims.json`, where this machine's worktree and session for a claim live). Use
  `cogyard env claim` / `cogyard env release` — they're atomic, and on team
  stores they also pull/push the claim (see `docs/MULTI-USER.md`). *(hook-enforced)*
- **Never hand-edit `status` into or out of DONE/ENOUGH, or `done_date`.** Use
  `cogyard tasks close <id>` / `cogyard tasks reopen <id> --why "…"`. *(hook-enforced)*
- **Never `git add` the task-store link** — `.cogyard/tasks`; it is gitignored,
  so the add does nothing. Commit task edits with
  `cogyard tasks sync push "<msg>" -- <file> [<file>…]`, naming every file you
  changed (a task file by the path `cogyard tasks find` prints; attachments under
  `files/<id>/`). Without names the push guesses which pending files are this
  chat's, and leaves anything it can't tell is yours uncommitted. *(hook-enforced:
  `guard-task-store` refuses the add)*
- **Never `pkill` / `killall`.** The always-on portal runs the same
  `node server/index.mjs` as every worktree's dev server, so a kill by name takes it
  down too. Stop one process by port (`lsof -ti:<port> | xargs kill`; a worktree's
  ports: `cogyard env detect`), by PID, or with `preview_stop`. *(hook-enforced,
  in every folder: `guard-dev-server`)*
- **Don't bypass the pickup ritual** — parallel sessions can collide; the claim
  mechanism is what prevents that.
- **Commit each change as it works, then tick its box.** On a task branch, commit
  each logical change as soon as it works — one change per commit, before starting
  the next. Then tick its scope checkbox — in the file at the path `cogyard tasks
  find` prints — and `cogyard tasks sync push "<msg>" -- <that file>`, then
  the next change. Never hold finished changes or ticks for the end — the portal
  reads `[x]`/`[ ]` directly. Nothing reaches main until the user has seen it and
  said to merge.
- **Worktree staleness gate:** in a worktree, first run `cogyard tasks staleness` —
  if behind the base branch, stop and report rather than working stale; the
  `pickup-task` skill says which remedies exist. Never `git merge main` into a
  Claude worktree.
- **Versioning and rebasing are the project's switches:** `cogyard tasks switches`
  shows them (set on the project's settings page). merge-to-main and pickup-task
  read them; never decide a version bump or a rebase question yourself.

## When the user mentions a task

- "do task NNN" / "pick up X" / "work on Y" → the **pickup-task** skill (don't just
  open the file and start).
- "file this" / "park as a task" / "spec X" / "make this a task" / "this is a new
  task" → the **write-task** skill. "Task" means a task file: never start a new
  session or chat for it, and never start the work now.
- "what's in tasks?" / "what's left?" / "what's claimed?" → `/cogyard`, or
  `cogyard tasks plan` (what's left) / `cogyard tasks current` (what's claimed).
- "tick item Y" → only for work that is done and checked: tick it in the file at
  the path `cogyard tasks find` prints, then `cogyard tasks sync push "<msg>" -- <that file>`.
- "mark X done" → `cogyard tasks close <id>`, never a hand edit.

## CLI quick reference

```
cogyard tasks sync pull                # pull task-store edits (team stores)
cogyard tasks sync push "<msg>" -- <file>...   # commit the task-store files you changed
cogyard tasks projects list            # registered projects
cogyard tasks doctor                   # audit task-storage health
cogyard tasks staleness                # is this checkout behind the base branch?
cogyard tasks drift <id>               # commits touching the task's paths since review
cogyard env detect                     # worktree, branch, ports, hostname
cogyard env claim <task-file> <session-id>   /   cogyard env release <task-file>
cogyard env port-owner <port>          # which worktree owns a TCP port
cogyard serve [--port N]               # run the portal (API + SPA)
```

The full portal is the live cross-project view — run `cogyard serve`.
