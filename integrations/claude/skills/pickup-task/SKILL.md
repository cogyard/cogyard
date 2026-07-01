---
name: pickup-task
description: |
  Pick up an existing `_tasks/NNN-*.md` file and work it. Trigger when the user says "do task NNN", "pick up task X", "work on task Y", "show me task Z", "continue task NNN", "resume task X", or otherwise references an existing task file by id. The skill handles the full pickup ritual: sync, env detection, claim check, worktree (CONTINUATION — reuse the task's existing worktree+branch if one is recorded, asking before rebasing onto main; otherwise create a task-named worktree, or say "no worktree" / "on main" to work directly on main), drift check, claim, work, release.

  Different from `write-task`: write-task creates a NEW task file from a description. pickup-task reads, claims, and executes an EXISTING task. They share storage assumptions documented in `~/.claude/CLAUDE.md`.
---

# pickup-task — pick up and execute an existing task file

When the user wants to start (or resume) a task that's already been written, this skill runs the pickup ritual: synchronize state, detect environment, check for claim collisions, identify code drift, lock the task to this session, and execute. It also enforces the rules around what counts as "stop" vs "keep going" vs "spawn a follow-up."

The task file at `_tasks/NNN-*.md` is the source of truth — it has the full spec, scope, acceptance criteria, and (if it's v2 frontmatter'd) machine-readable status. This skill is the wrapper around reading and acting on it.

## When to use

Trigger phrases:
- "do task 037" / "do 011"
- "pick up task X" / "pick up X"
- "work on task Y" / "work on the recording bugs" (if a task ID maps to that description)
- "continue task NNN" / "resume X"
- "start NNN"
- "show me task Z" (read-only — present the task without claiming)

Do NOT use for:
- Authoring a new task — use `write-task` instead.
- Browsing the task list — point user at `/cogyard` slash command.
- Quick TodoWrite-style in-session todos — use the TodoWrite tool, not the file system.

## The Pickup Procedure

Run these steps in order. Steps that require shell commands are listed with the exact command (no chained commands; one operation per Bash call).

### 0. Staleness gate (blocking)

`cogyard tasks staleness` — exits 1 and prints the gap
when this checkout is behind the repo's default branch (it resolves main/master
itself — never hardcode the branch name — and fetches + compares against
`origin/<base>`, so a push from another worktree counts even before you pull;
falls back to the local branch only when there's no remote or it's offline). If
it exits non-zero, STOP and report:
"Worktree is N commits behind <base>. Fresh worktree from <base> (default), or
proceed stale?" Don't claim, audit, or edit anything until answered. The Step 7
drift check is invalid while this is unresolved.

**Exception — continuation:** if the task frontmatter has `env.worktree`/`env.branch`
set (a prior session already has a worktree for it), this is a continuation, not a
new pickup. Do NOT offer a fresh worktree — the whole point is to reuse the existing
one (Step 5). The "is it behind main" concern is handled there by the rebase
question, so note the staleness and carry on to Step 5 rather than stopping here.

### 1. Sync the task state (cross-machine only)

If the task system uses a symlinked `_tasks/` shared between sibling clones (planet system), the file system already gives you the latest state from your machine — no sync needed. If you suspect changes from another machine:

```
cogyard tasks sync pull
```

Skip if working on a single machine with no remote sync.

### 2. Locate and read the task file

Find the file by ID. The dashboard or `_tasks/INDEX.md` lists them. For ID `037`, the file is typically `_tasks/037-<slug>.md`.

Read the entire body. Note:
- The frontmatter (especially `status`, `depends_on`, `claimed_at`, `touches_paths`)
- The "For a cold-start session" preamble — what to read first, what conventions apply
- The Scope checklist — what's done (`[x]`) vs pending (`[ ]`)
- Acceptance criteria
- Out of scope clauses

### 3. Detect environment

```
cogyard env detect
```

Returns the planet, ports, hostname, worktree, branch. The task's own `env:` block (if populated from a previous session) tells you which planet it expected to run on. If the current planet differs, decide whether to switch worktrees or proceed (sometimes fine, sometimes not — depends on the task).

### 4. Check claim — STOP if held by another session

If `frontmatter.env.claimed_at` is set and `frontmatter.env.claimed_by_session` is NOT this session, STOP. Tell the user:

> "Task NNN is claimed by session X on planet Y, worktree Z since DATE. Continue (re-claim — will displace the other session), pick a different task, or coordinate with the other session?"

Wait for direction. Don't claim over another session without confirmation.

### 5. Reuse the task's existing worktree (continuation) — else create one

**Continuation comes FIRST. A task has at most ONE worktree+branch — reuse it; never spawn a second.** Read `env.worktree` and `env.branch` from the task frontmatter (Step 2). If BOTH are set, a prior session already started this task in that worktree on that branch. Picking it up again (after you left or merged half-way) MUST continue on the *same* worktree and branch — creating a fresh `task-NNN-*` worktree for a task that already has one is the multi-worktree bug (it strands disk, breaks the worktree→task association, and splits the work across branches). Only when `env.worktree`/`env.branch` are empty (genuine first-time pickup) do you create one — jump to "First-time pickup" below.

**To continue on the existing worktree:**

1. **Are you already in it?** If `cogyard env detect` shows the current worktree == `env.worktree`, you're already there — skip to step 4 (rebase question).
2. **Resolve the path:** `<main-checkout>/.claude/worktrees/<env.worktree>` (main checkout = first entry of `git worktree list`).
3. **Switch into it** based on `git worktree list`:
   - **Worktree still registered** → call **EnterWorktree** with `path=<that path>` (switches the session in; does NOT create anything).
   - **Branch exists but the worktree dir was removed** (chat archived) → recreate it on the SAME branch: `git worktree add <path> <env.branch>`, then **EnterWorktree** with `path=<that path>`.
   - **Neither exists** (fully gone) → recreate from scratch but REUSE the recorded names: EnterWorktree with `name=<env.worktree>` (so the branch/worktree identity stays stable across sessions). If the branch name doesn't match `env.worktree`'s default, create the worktree on `env.branch` via `git worktree add` first.
   - Then run `cogyard hook session-start "$PWD"` (port/_tasks wiring — mandatory after EnterWorktree).
4. **Rebase onto main? — ASK, never assume.** The branch is likely behind main. Call the **AskUserQuestion** tool (the user explicitly wants this as a question — sometimes they don't want a rebase, e.g. mid-refactor or to keep a clean diff). Header "Rebase", one question, two options:
   - **Rebase onto main (Recommended)** — "Replays `<env.branch>` on top of current main so the continuation builds on the latest."
   - **Continue as-is (no rebase)** — "Keep the branch where it is; don't pull main in yet."
   On **Rebase**: `git fetch origin` then `git rebase main` (one op at a time; on conflict, stop and resolve with the user — NEVER `git merge main` into the worktree). On **Continue as-is**: proceed unchanged.
5. `cogyard env detect` to confirm the worktree + ports, then continue at Step 6. (The drift check in Step 7 now runs against the rebased — or deliberately-not-rebased — branch.)

---

**First-time pickup (no recorded `env.worktree`/`env.branch`):** create a task-named worktree (default) — or work directly on main.

**Default: with worktree.** When the session is in the project's main checkout (path does NOT contain `/.claude/worktrees/`) and the task involves code changes, create a task-named worktree per the steps below.

**Without worktree (work directly on main):** some tasks legitimately belong on main (a hotfix, a tiny doc edit, a task whose whole point is a direct-on-main change). When working on main, say so ("Working directly on main, no worktree") and go straight to Step 6. The patch-version bump policy then applies if this lands on main outside a branch.

**MANDATORY confirmation — do NOT skip the worktree by accident.** When the choice is live (in the main checkout, task involves code) you MUST resolve it explicitly, never silently. Two paths:

- The user already stated intent in the pickup phrasing → honor it without asking. "with worktree" / (nothing) → worktree; "no worktree" / "on main" / "directly on main" / "in place" / "don't branch" → main.
- Otherwise → **call the `AskUserQuestion` tool** before doing anything else. One question, header "Worktree", two options:
  - **With worktree (Recommended)** — "Creates `task-NNN-<slug>` worktree + branch; isolates the work, shows the task name in the portal."
  - **Work directly on main** — "No worktree. Commits land on main (patch bump applies). For hotfixes / tiny edits / tasks that must be on main."

  Do not proceed past this step until the tool returns an answer. Never default-and-continue without either explicit phrasing or a dialog answer — that silent skip is exactly the accident this guards against.

**Always skip the question entirely** (no worktree, no dialog) when:
- The session is already inside a worktree (e.g. the desktop Worktree checkbox was checked) — the name is fixed at session start and CANNOT be renamed; `git worktree move` mid-session breaks the session cwd and orphans the port allocation keyed by path in `~/.cogyard/ports.json`. Say you're keeping the existing worktree.
- The pickup is read-only ("show me task Z") or a pure task-file edit — no code, no worktree.

To create the worktree:

1. Derive the name `task-NNN-<slug>` from the task file (e.g. `task-042-worktree-port-management`). Allowed chars: letters, digits, dots, underscores, dashes; max 64 chars total — truncate the slug if needed.
2. Call the **EnterWorktree** tool with that `name`. It creates `<repo>/.claude/worktrees/task-NNN-<slug>` on a new branch and switches the session into it.
3. **SessionStart hooks do NOT re-fire on EnterWorktree**, so the port/wiring hook must be run manually — this is mandatory, not optional:

```
cogyard hook session-start "$PWD"
```

This mounts the `_tasks` symlink, reserves the worktree's port pair in `~/.cogyard/ports.json` (idempotent — re-runs return the same pair), writes `.planet` / env files / `.claude/launch.json` when the project has a committed `.claude/worktree-config.json`, and prints the ports briefing. Read the briefing; any dev server started in this worktree binds those ports.

4. Re-run `cogyard env detect` to confirm the new worktree and ports are picked up before claiming.

If EnterWorktree fails or is unavailable, report it and only continue in the main checkout with the user's explicit OK.

### 6. Verify dev servers match this worktree

If the task involves running the app (UI work, integration tests), check whether dev servers on the project's ports are from THIS worktree:

```
cogyard env port-owner <port>
```

If `matches: false`, tell the user: "Backend on port X is from worktree Y, not this one. Smoke-test results may not reflect your code." Decide together whether to kill the other server.

### 7. Drift check — has the world moved since this task was reviewed?

Run:

```
cogyard tasks drift <task-id-or-file>
```

It reads the task's `last_reviewed_at_commit` + `touches_paths`, resolves the
default branch (main/master) itself, fetches it, and exits 1 listing any commits
on `origin/<base>` that touched those paths since the review point (exit 0 / "no
drift" when clean or when the fields aren't populated). Comparing against origin
means a teammate's push counts before you pull. If commits are listed, read each
one's message + diff. Form a verdict:
- **No drift** — proceed.
- **Cosmetic drift** (renames, refactors) — update file references in the task body, bump `last_reviewed_at_commit` to current HEAD, proceed.
- **Substantive drift** (assumption invalidated, work already done by another commit, scope obsoleted) — STOP. Tell the user what changed, propose updating the task or marking it OBSOLETE.

### 8. UI placement check (UI work only)

For tasks that build new UI components/pages: BEFORE coding, write a 1-sentence sketch of where the new thing will appear (sidebar group, route path, parent component) and ask the user to confirm placement. UI placement decisions are the highest-risk class — catching disagreement at minute 5 saves 90 minutes.

### 9. Claim the task

```
cogyard env claim <task-file-path> <session-id>
```

This atomically sets `claimed_at` (now, ISO timestamp) and `claimed_by_session`. Refuses with exit code 2 if already claimed by another session — handle that case per Step 4.

Then push the claim so other sessions see it:

```
cogyard tasks sync push "claim NNN from <planet>/<worktree>"
```

### 10. Work the task

Execute scope items in order (or any sensible grouping). Honor the rules below.

**Tick the box the moment an item ships — not at the end.** Each `- [ ]` Scope item becomes `- [x]` as soon as the work that satisfies it is complete and verified. This is a hard rule, not a footnote. The dashboard's "Sub" column reads these checkboxes directly; if you finish 30 items but only tick at the end (or never), the dashboard shows `0/30` while the work is done — a real bug we hit on task 037. **Do not** batch up a "tick at the end" pass. **Do not** claim status DONE while any unticked-but-shipped boxes remain. The right rhythm:

1. Edit the box from `- [ ]` to `- [x]` in the task file as part of the same change set as the work itself.
2. `cogyard tasks sync push "[#NN] <type>(<scope>): <subject>"` — the same commit that ships the work also ticks the box.

Use `[x]` (lowercase). The parser also accepts `X`, `✓`, `✔`, `✅`, `☑`, `done`, etc., but `[x]` is the convention — don't drift.

### 11. Release on done or task switch

When done with the task (acceptance met) OR switching to a different task:

```
cogyard env release <task-file-path>
cogyard tasks sync push "release NNN"
```

If switching tasks, re-run the Pickup Procedure for the new task starting at Step 1.

## Behavior during execution — hard rules

These rules apply throughout Step 10. Don't violate.

### Continuous execution — don't stop at logical batch boundaries

See `~/.claude/projects/.../memory/feedback_continuous_execution.md` if it exists. Keep working through the task's full scope unless you hit a real boundary:

**Real boundaries that warrant a pause:**
- Scope expansion beyond the task file's Scope section.
- Sign-off needed (migrations, destructive ops, force-push, anything in the task's `out_of_scope:` list).
- Build break Claude can't resolve.
- Ambiguous spec that needs the user's call.
- All checkboxes ticked.

**NOT boundaries (don't pause for these):**
- Finished a logical group of items.
- Wrote a summary-worthy chunk.
- Hit a natural commit point (commit and keep going per `commit_policy`).
- Completed a sub-phase.

### Scope discipline — never silently expand

If the work goes beyond the file's Scope section, STOP. Choose ONE:
- **(a) Append to Scope and commit the file edit as its own commit, then continue.** Use when the new item is clearly part of the same task, just missed in original spec.
- **(b) Call `mcp__ccd_session__spawn_task` to file as a new task.** Use when the new work is large enough to deserve its own pickup brief.
- **(c) Get explicit user approval to expand silently.** Use sparingly, only for tiny adjacent fixes.

Never silently add 7 commits' worth of unspecified work. (This was a real failure mode in the past.)

### "What this is" stays in sync — refresh when shape changes

The task file's `## What this is` section (immediately after Status) is the project description a cold reader sees. **When the shape of the work changes, update that section in the same commit as the change.** Specifically:

- Added a new phase / sub-system / file the original spec didn't mention → update "What this is" file layout, runtime flow, or schema.
- Rejected an alternative or chose a different architecture mid-task → update "What this is" to describe the chosen design.
- Built a new system worth documenting beyond this task → at the end of the task, write a durable doc (e.g. `_docs/foo.md` or `docs/FOO.md`) and shrink "What this is" to 2–4 sentences + bold pointer to it.

Ticking boxes ≠ keeping the description current. Boxes record what was done; "What this is" records what exists now. Both must move forward together. If at the end of the task a cold reader can't tell what was built from "What this is" alone, the section is stale — fix it before declaring done.

### Commit policy — honor frontmatter

- `commit_policy: per-phase` — commit at section boundaries with descriptive messages. Default for multi-section work.
- `commit_policy: per-acceptance` — commit per ticked checkbox item.
- `commit_policy: end` — one commit at completion.

Never write 30+ files without committing.

### Migration acceptance — build-green is NOT acceptance

If the task includes a database migration, surface the SQL to the user and wait for explicit confirmation that it ran cleanly against a real Postgres instance. Build-green is necessary but not sufficient.

### End-of-session ritual

If the session ends with unticked checkboxes in Scope, offer the user three options:
- **(a) Keep tracked in this task** (default). Task stays OPEN; `[x]/[ ]` ratio reflects partial completion in the dashboard.
- **(b) Spin remainder into a new `_tasks/NNN-*.md`** via `mcp__ccd_session__spawn_task` or by writing a fresh task file via `write-task`.
- **(c) Mark current task DONE and obsolete the unticked items.** Use when the remaining work no longer makes sense or has been overtaken by other changes.

Always offer; do not silently leave it ambiguous. Then `release` the claim and `sync push`.

## Anti-patterns

- **Skipping Step 4 (claim check).** May collide with another parallel session. The whole reason for the claim mechanism is to detect this.
- **Skipping Step 7 (drift check).** Working against stale assumptions wastes time and may produce code that conflicts with what's already shipped.
- **Manually editing claim fields.** Use `cogyard env claim` and `cogyard env release` — they're atomic, hand-edits are not. Two sessions racing to manually edit could corrupt the frontmatter.
- **`git add _tasks/` in the project's main repo when `_tasks/` is a symlink.** The symlink is gitignored; the add does nothing. Use `cogyard tasks sync push` instead, which commits in the canonical dir's git repo.
- **Marking DONE without ticking checkboxes.** If the dashboard shows `5/30` but status is DONE, that's a smell — either tick the boxes that are actually done or leave status OPEN.
- **Forgetting to release on session end.** The next session that wants this task will get blocked by the stale claim. Always release.

## See also

- `~/.claude/CLAUDE.md` — the user-level overview of the task system (auto-loaded).
- `write-task` — author a new task file (don't use this skill for that).
- `handoff` — produce a hand-off prompt for the next session (different from a task; for cross-session in-flight work).
- `cogyard tasks` — index/viewer/sync. Run with `--help` for subcommands.
- `cogyard env` — environment detection + claim helpers.
- `~/.claude/commands/cogyard.md` — the `/cogyard` slash command (boots the dashboard).
