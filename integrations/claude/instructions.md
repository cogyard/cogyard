# cogyard — operating rules (Claude Code)

cogyard is a markdown-task + claims + worktree-ports engine. These are the rules a
Claude Code session needs to drive it correctly. (This file is the canonical,
shippable copy; `cogyard claude install --rules` writes it into a user's CLAUDE.md
so the rules are present every session — a plugin cannot inject always-on context
on its own.)

## What cogyard is

- **Task files** live at `_tasks/NNN-<slug>.md` per project — YAML frontmatter
  (`id`, `slug`, `status`, `depends_on`, `touches_paths`, an `env:` claim block, …)
  plus a markdown body (scope checklist, acceptance, out-of-scope).
- **The engine** is reached through the `cogyard` CLI (on PATH via `npm i -g
  @cogyard/cli`, or `npm link` in a clone). `cogyard` is the agent-agnostic public
  contract — skills, hooks, and humans all call it; never reach into the repo by path.
- **Config + state** live under `~/.cogyard/` (`projects.json`, `ports.json`, …).

## Skills (auto-trigger on phrasing)

They trigger on what the user *says*, not just the slash name. Names are bare here
(`pickup-task`); under a `/plugin` marketplace install they're namespaced
(`cogyard:pickup-task`).

- `pickup-task` — "do task NNN", "pick up X", "work on Y". Runs the full pickup
  ritual: staleness gate → sync → env detect → claim check → task-named worktree →
  drift check → claim → work → release.
- `write-task` — "file this as a task", "park for later", "spec this out". Authors a
  new shelf-stable `_tasks/NNN-*.md`.
- `handoff` — carry in-flight work across a session boundary.
- `commit` — commits following project convention; auto-prepends the active cogyard
  task id (`[#NN]`) so `git log` cross-links commits → tasks.
- `debt-cleanup` — structured codebase cleanup that produces a `_tasks/` doc.

## Hooks (this plugin installs)

- **SessionStart** (`cogyard hook session-start`) → reserves a unique port pair for
  every Claude worktree and auto-mounts shared `_tasks` symlinks. SessionStart does
  NOT re-fire for worktrees created mid-session (e.g. via EnterWorktree) — after
  creating one, run the wiring manually: `cogyard hook session-start "$PWD"`.
- **PreToolUse (Edit|Write|MultiEdit)** (`cogyard hook validate-frontmatter`) →
  blocks writes that introduce task-frontmatter errors.
- **UserPromptSubmit** → nudges "write/file a task"-style prompts toward `write-task`.

## Hard rules — do not violate

- **Never hand-edit `claimed_at` / `claimed_by_session`.** Use `cogyard env claim` /
  `cogyard env release` — they're atomic. *(hook-enforced)*
- **Never `git add _tasks/` when it's a symlink** (a gitignored shared store) — the
  add silently does nothing. Commit task edits with `cogyard tasks sync push "<msg>"`.
- **Don't run `cogyard tasks init` on a project that already has `_tasks/`** without
  checking `cogyard tasks projects list` first.
- **Don't bypass the pickup ritual** — parallel sessions can collide; the claim
  mechanism is what prevents that.
- **Tick a scope checkbox the moment the item ships**, in the same commit as the
  work — the portal reads `[x]`/`[ ]` directly.
- **Worktree staleness gate:** in a worktree, first run `cogyard tasks staleness` —
  if behind the base branch, stop and report rather than working stale. Never
  `git merge main` into a Claude worktree; the remedy is a fresh worktree.
- **Versioning:** minor bump on every branch/worktree merge to main; patch for
  direct-on-main changes; never major without explicit instruction.

## When the user mentions a task

- "do task NNN" / "pick up X" / "work on Y" → the **pickup-task** skill (don't just
  open the file and start).
- "file this" / "park as a task" / "spec X" → the **write-task** skill.
- "mark X done" / "tick item Y" → edit the file directly (NOT via `cogyard env`),
  then `cogyard tasks sync push "<msg>"`.

## CLI quick reference

```
cogyard tasks sync pull|push "<msg>"   # pull / commit task-store edits
cogyard tasks projects list            # registered projects
cogyard tasks doctor                   # audit task-storage health
cogyard tasks staleness                # is this checkout behind the base branch?
cogyard tasks drift <id>               # commits touching the task's paths since review
cogyard env detect                     # planet, ports, worktree, branch
cogyard env claim <task-file> <session-id>   /   cogyard env release <task-file>
cogyard env port-owner <port>          # which worktree owns a TCP port
cogyard serve [--port N]               # run the portal (API + SPA)
```

The full portal is the live cross-project view — run `cogyard serve`.
