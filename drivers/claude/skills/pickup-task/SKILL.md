---
description: |
  Pick up an existing `NNN-*.md` task file and work it. Trigger when the user says "do task NNN", "pick up task X", "work on task Y", "show me task Z", "continue task NNN", "resume task X", or otherwise references an existing task file by id — AND on any continuation-shaped request: naming a task's worktree or branch as the place to work ("get back in the worktree", "fix it in that worktree"), or asking for follow-up work on a task this session already worked ("fix what broke", "one more change"), even after that task merged or was marked DONE — AND any work that clearly belongs to an existing task, from any chat ("put this as part of 156", "this should go back to 156", or plainly part of it without saying so) — AND "tick item Y" / "mark X done" on an existing task (see "Ticking a box, marking a task done"). The word "worktree" alone is never a cue for a bare EnterWorktree call — if the destination is a task's recorded worktree, this skill's continuation flow wraps it. The skill handles the full pickup ritual: sync, env detection, claim check, worktree (CONTINUATION — reuse the task's existing worktree+branch if one is recorded, rebasing onto main as the project's `rebase` switch says; merged/DONE tasks rehydrate the same way and are reopened; otherwise always create a task-named worktree, unless the pickup request says "no worktree" / "on main"), drift check, claim, work, release.

  Different from `write-task`: write-task creates a NEW task file from a description. pickup-task reads, claims, and executes an EXISTING task. They share the cogyard storage model (per-project task directory — the `.cogyard/tasks` link to a shared store) — see the "The task storage model" section in the `write-task` skill.
---

# pickup-task — pick up and execute an existing task file

When the user wants to start (or resume) a task that's already been written, this skill runs the pickup ritual: synchronize state, detect environment, check for claim collisions, identify code drift, lock the task to this session, and execute. It also enforces the rules around what counts as "stop" vs "keep going" vs "spawn a follow-up."

The task file (`NNN-*.md` in the project's task store) is the source of truth — it has the full spec, scope, acceptance criteria, and (if it's v2 frontmatter'd) machine-readable status. This skill is the wrapper around reading and acting on it.

## The loop — every change, while working a task

1. Make one change. When it works, commit it. Run `git status --short` first; if earlier finished work is still uncommitted, commit that before anything else.
   Then run `cogyard tasks conflicts <id>`: a dry-run merge of this branch against every other task branch in progress and main, which changes nothing. Exit 0: go on. Exit 1: it names the task (or main) and the files that would conflict. Stop and ask the user before the next change.
2. Tick its Scope box (`- [ ]` → `- [x]`) in the file at the path `cogyard tasks find` printed (Step 2), then `cogyard tasks sync push "[#NN] <type>(<scope>): <subject>" -- <that file>` (plus any `files/<id>/…` attachment you changed — always name what you commit). A box that gets decided rather than done is not ticked — leave it `[ ]` and start its text with `(dropped: <why>)`, `(moved: <id>)` or `(optional)` (`docs/TASK-STATUS-VOCABULARY.md`).
3. Then the next change.

End every reply sent while working a task with one line: **Committed:** <subjects since the last reply, or "nothing"> · **Ticked:** <boxes, or "nothing">.

This holds on the task branch whatever `commit_policy` says. "Don't commit what I haven't seen" is about what reaches main, not about commits on the branch. Never batch commits or ticks for the end — the dashboard's "Sub" column reads the boxes directly, and a pile of uncommitted changes is one the user can't follow or revert piece by piece.

## When to use

Trigger phrases:
- "do task 037" / "do 011"
- "pick up task X" / "pick up X"
- "work on task Y" / "work on the recording bugs" (if a task ID maps to that description)
- "continue task NNN" / "resume X"
- "start NNN"
- "show me task Z" (read-only — present the task without claiming)
- Any reference to a task's WORKTREE or BRANCH as the place to work — "get back in the worktree", "fix it in that worktree", "on the task-NNN branch". Resolve which task's recorded worktree/branch (`cogyard env where <task-file>`) matches; that task is being resumed.
- Any follow-up work request on a task this session already worked — "fix what broke", "one more change to that", "adjust it" — even without the word "task", and **even after the task merged, was released, or was marked DONE**. Follow-up work on a known task is always a continuation pickup, never ad-hoc.
- Any work that clearly belongs to an existing task, whichever chat it comes up in — "put this as part of 156", "this should go back to 156", "add these to that task", or work that is plainly part of a task even when the user doesn't say so. Name the task you are taking it to in one line and pick it up; a DONE or ENOUGH task is reopened (Step 9).
- "tick item Y" / "mark X done" — see below.

### Ticking a box, marking a task done

These two need no claim and no worktree; neither is a pickup ritual.

- **"tick item Y" (in task X)** — only for work that is done and checked. Tick it (`- [ ]` → `- [x]`) in the file at the path `cogyard tasks find <id>` prints, then `cogyard tasks sync push "<msg>" -- <that file>`. If the work isn't done or you can't check it, say so and leave the box open.
- **"mark X done"** — `cogyard tasks close <id>`, never a hand edit of `status` or `done_date`. A refusal is handled as `merge-to-main` step 10c handles one: ask nothing, and report one line per reason what is left and whose it is. `--enough` / `--force` run only on the user's own words in this chat ("close it as enough" / "close it as done"), passed with `--asked "<their words>"`.

**Classification rule — skill before tool.** The word "worktree" in a request is NOT a cue to call EnterWorktree directly. If the destination is an existing task's recorded worktree, the request is a continuation trigger for THIS skill (whose Step 5 wraps EnterWorktree in the full ritual). EnterWorktree is called bare only when the destination is not tied to any task.

Do NOT use for:
- Authoring a new task — use `write-task` instead.
- Browsing the task list — point user at `/cogyard` slash command.
- Quick in-session todos — use the session task list (TaskCreate/TaskUpdate, or TodoWrite in older Claude Code versions), not the file system.

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

**What this gate cannot see.** It compares with **origin**, so it passes when local
main is AHEAD of origin (commits on main that were never pushed). A worktree made by
EnterWorktree branches from origin, so those commits are missing from it. That case
is caught right after the worktree exists — Step 5, "To create the worktree", step 4.

**Exception — continuation:** if `cogyard env where <task-file>` reports a `worktree`/`branch`
set (a prior session already has a worktree for it), this is a continuation, not a
new pickup. Do NOT offer a fresh worktree — the whole point is to reuse the existing
one (Step 5). The "is it behind main" concern is handled there by the rebase
step, so note the staleness and carry on to Step 5 rather than stopping here.

### 1. Sync the task state (cross-machine only)

If the task directory is a link to a shared store, every checkout and worktree on this machine already sees the latest state through the filesystem — no sync needed. If you suspect changes from another machine:

```
cogyard tasks sync pull
```

Skip if working on a single machine with no remote sync.

### 2. Locate and read the task file

Resolve the ID to a path with:

```
cogyard tasks find <id-or-slug>
```

This is the authoritative lookup — it matches frontmatter `id`, filename stem, or `slug` (the same rule `drift`/`claim`/`release` resolve by internally), so it can't diverge from what those commands will actually operate on. Don't glob `.cogyard/tasks/037-<slug>.md` by guessing the slug. The portal and `cogyard tasks plan` are fine for *browsing* ("what tasks exist"), never for resolving a specific ID to a file.

Read, edit and tick the task file only at the path `find` prints — never at `<repo>/.cogyard/tasks/NNN-…`, even though it names the same file. That is a link to the store; `find` prints the store's real location; a Write or Edit through the link resolves outside the working directory, which Claude Code answers with a permission prompt (or, in a worktree, a refusal).

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

Returns the worktree, branch, ports and hostname. The task's own `env:` block (if populated from a previous session) records the worktree and branch it was worked in — Step 5 uses those to continue in the same place.

### 4. Check claim — STOP if held by another session

Run `cogyard env where <task-file>` — it prints the claim from the task file (`claimed_at`, `claimed_by`, `branch`) with this machine's `worktree` and `session` (kept in `~/.cogyard/claims.json`, not the task file). If `claimed_at` is set and `session` is NOT this session, STOP. Tell the user (prefer the human holder from `env.claimed_by` when present — on team stores it may be a teammate, not another of the user's own sessions):

> "Task NNN is claimed by <claimed_by, else session X> in worktree Z since DATE. Continue (re-claim — will displace the other session), pick a different task, or coordinate with the other session?"

Wait for direction. Don't claim over another session without confirmation — and be extra reluctant when `claimed_by` names someone other than the current user.

**Expected case, not an anomaly:** claims persist until merge (Step 11), so a CONTINUATION of the user's own task normally finds the claim held by a dead prior session of the same user (`claimed_by` = this user, and `cogyard env where` shows the recorded worktree). Confirm briefly and re-claim with `--force` — that's the designed hand-over, not a collision.

### 5. Reuse the task's existing worktree (continuation) — else create one

**The task's worktree is `task-<id>-<slug>` and nothing else.** Once this skill runs, the work happens in the worktree named `task-<id>-…` for THIS task's id (ids compare as `cogyard tasks find` compares them: a zero-padded and an unpadded id name the same task; an id with a letter or dotted suffix is a different task from its bare number), or directly on main when the user says so. A worktree with any other name — recorded in the claim, or the one this chat is sitting in — is NOT the task's, whatever the task file or the claim record says: go to "A worktree made outside the process" below. `cogyard env claim` enforces this (exit 3, `wrong_worktree`), so a claim from the wrong worktree fails rather than sticking.

**Continuation comes FIRST. A task has at most ONE worktree+branch — reuse it; never spawn a second.** Read `worktree` and `branch` from `cogyard env where <task-file>` (the branch is in the task file; the worktree is this machine's record, `~/.cogyard/claims.json`). If BOTH are set AND the worktree is `task-<id>-…` for this task, a prior session already started this task in that worktree on that branch. (Set but named anything else → "A worktree made outside the process".) Picking it up again (after you left or merged half-way) MUST continue on the *same* worktree and branch — creating a fresh `task-NNN-*` worktree for a task that already has one is the multi-worktree bug (it strands disk, breaks the worktree→task association, and splits the work across branches). Only when both are empty (genuine first-time pickup) do you create one — jump to "First-time pickup" below.

**Merged / DONE tasks reopen the same way.** A task whose branch already merged (status DONE, claim released) that gets follow-up work — a bug in what it shipped, a tweak, a revert — is STILL a continuation, not a fresh start and not direct-on-main work. Rehydrate: reuse the recorded worktree+branch (steps 1–3 below), the rebase step (step 4 — after a merge, rebasing onto the base branch typically fast-forwards the branch to current base), **reopen the task**, then re-claim (both in Step 9 — a claim is refused on a task that isn't OPEN), then work. The file must say OPEN while follow-up work is in flight: a DONE file with open boxes says the work is finished when it isn't, and the next merge's `close` refuses an already-closed task. The user asking for the follow-up is the reason to reopen — never ask first.

**To continue on the existing worktree:**

1. **Are you already in it?** If `cogyard env detect` shows the current worktree == the recorded `worktree`, you're already there — skip to step 4 (rebase).
2. **Resolve the path:** `<main-checkout>/.claude/worktrees/<worktree>` (main checkout = first entry of `git worktree list`).
3. **Switch into it** based on `git worktree list`:
   - **Worktree still registered** → call **EnterWorktree** with `path=<that path>` (switches the session in; does NOT create anything).
   - **Branch exists but the worktree dir was removed** (chat archived) → recreate it on the SAME branch: `git worktree add <path> <branch>` (no `-b`: the branch already exists), then **EnterWorktree** with `path=<that path>`. When the recorded branch is not `worktree-<name>` (an older task), the plugin's worktree guard asks before that EnterWorktree; this is the case it asks about, so say it is the task's recorded worktree.
   - **Neither exists** (fully gone) → recreate it with EnterWorktree `name=<worktree>`, reusing the recorded worktree name so the worktree identity stays stable across sessions. The branch comes out as EnterWorktree names it (`worktree-<worktree>`), and the claim records it. Nothing was left on the old branch to keep, so never recreate the old branch name by hand with `git worktree add -b` — the plugin's worktree guard refuses it. (EnterWorktree branches from origin, so the new branch may lack unpushed commits on local main; the rebase in step 4 below covers that.)
   - Then run `cogyard hook session-start .` from inside it (port and task-store link wiring — mandatory after EnterWorktree).
4. **Rebase onto main — as the project's `rebase` switch says.** Check whether the branch is behind: `git log --oneline HEAD..main`. Empty → nothing to do, go to step 5. Otherwise read the switch:

   ```
   cogyard tasks switches --json
   ```

   - **`rebase.value` is `always`** → rebase without asking, and say so in one line ("Branch was N commits behind main; rebased onto it."): `git fetch origin`, then `git rebase main` (one op at a time). On a conflict, stop and resolve it with the user.
   - **`rebase.value` is `ask`** → call the **AskUserQuestion** tool. Header "Rebase", one question, two options:
     - **Rebase onto main (Recommended)** — "Replays `<branch>` on top of current main so the continuation builds on the latest."
     - **Continue as-is (no rebase)** — "Keep the branch where it is; don't pull main in yet."
     On **Rebase**: as for `always`. On **Continue as-is**: proceed unchanged.
   - The owner's own words in the pickup request win over the switch either way ("pick up 37, don't rebase" → no rebase).

   NEVER `git merge main` into the worktree, whatever the switch says.
5. `cogyard env detect` to confirm the worktree + ports, then continue at Step 6. (The drift check in Step 7 now runs against the rebased — or deliberately-not-rebased — branch.)

---

**A worktree made outside the process.** The recorded worktree, or the one this chat is in, is not `task-<id>-…` for this task — e.g. the chat made `new-build-reload` with EnterWorktree before any task existed, then the task was filed from there. That is allowed outside cogyard, but the pickup does not continue there: the work moves into the task's own worktree. Call the other worktree's branch `<other-branch>` (`git branch --show-current` inside it, or the recorded `branch`).

- **This chat entered that worktree with EnterWorktree** (you can see the call earlier in this chat):
  1. Commit anything uncommitted in it first — it is this chat's own work, and only commits carry over.
  2. **ExitWorktree** `action=keep` (keep: it holds the work until it is carried over, and removing worktrees is the user's call).
  3. **EnterWorktree** `name=task-<id>-<slug>` (derived as in "To create the worktree" below), then `cogyard hook session-start .` from inside it, and read the briefing.
  4. List what comes over: `git log --oneline --reverse HEAD..<other-branch>` (the commits the other branch has beyond the new worktree's base). Bring them over in order: `git cherry-pick HEAD..<other-branch>`. On a conflict, stop and resolve it with the user.
  5. Confirm every commit arrived: `git cherry HEAD <other-branch>` must print no line starting with `+` (a `+` is a commit that did not come over — fix that before claiming). Each copied commit shows as `-`; no output at all also means nothing is missing (the copy came out with the same commit id).
  6. Claim (Step 9) — from here, which is now allowed.
  7. Hand the user the leftover (removing it is their call; never run these yourself). `cogyard cleanup worktrees` will NOT offer it: it offers only merged or pushed branches, and the copies have new commit ids, so `<other-branch>` never counts as merged. Give the user these, to run in order from the main checkout, with the real names filled in:
     ```
     git cherry worktree-task-<id>-<slug> <other-branch>
     ```
     ```
     git worktree remove .claude/worktrees/<other-worktree>
     ```
     ```
     git branch -D <other-branch>
     ```
     The first is the check: go on only if no line starts with `+`. `git worktree remove` refuses a worktree with uncommitted files, so nothing unsaved goes with it. `-D` (not `-d`) is needed because git counts the branch as unmerged.
- **This chat was started inside that worktree** (by the app, or the user's worktree checkbox — ExitWorktree reports no worktree session to leave): a chat cannot leave a folder it was started in. **STOP before claiming** and tell the user: "This chat was started inside `<worktree>`, which isn't task <id>'s worktree. Say 'pick up <id>' in a chat started in the main checkout; it will create `task-<id>-<slug>` and bring the commits from `<other-branch>` over."
- **Neither applies** (the recorded worktree is somewhere this chat is not, under a made-up name): treat it as a first-time pickup — create `task-<id>-<slug>` below, then carry `<other-branch>`'s commits over with steps 4–5 above before claiming, and hand the user the leftover's removal commands as in step 7.

Never claim from the made-up worktree to "fix it later", and never pass `--any-worktree`: that flag is the user's, and the CLI refuses it from an agent.

---

**First-time pickup (`cogyard env where` reports no `worktree`/`branch`):** create the task's worktree — no question.

**With worktree, always.** When the session is in the project's main checkout (path does NOT contain `/.claude/worktrees/`) and the task involves code changes, create the task-named worktree per the steps below. Do not ask whether to.

**On main only when the owner's pickup request says so.** "no worktree", "on main", "directly on main", "in place", "don't branch" in the owner's own words → no worktree: say so ("Working directly on main, no worktree") and go straight to Step 6. Nothing else puts the work on main — not the task's size, not your judgment that it is a small fix.

**No new worktree** when:
- The session is already inside THIS task's worktree, `task-<id>-…` — the name is fixed at session start and CANNOT be renamed; `git worktree move` mid-session breaks the session cwd and orphans the port allocation keyed by path in `~/.cogyard/ports.json`. Say you're keeping the existing worktree. Inside a worktree with any other name (the desktop Worktree checkbox's random name, an invented one, another task's), this rule does not apply: go to "A worktree made outside the process" above.
- The pickup is read-only ("show me task Z") or a pure task-file edit — no code, no worktree.

To create the worktree:

1. Derive the name `task-NNN-<slug>` from the task file (e.g. `task-042-worktree-port-management`). Allowed chars: letters, digits, dots, underscores, dashes; max 64 chars total — truncate the slug if needed.
2. Call the **EnterWorktree** tool with that `name`. It creates `<repo>/.claude/worktrees/task-NNN-<slug>` on a new branch and switches the session into it.
3. **SessionStart hooks do NOT re-fire on EnterWorktree**, so the port/wiring hook must be run manually — this is mandatory, not optional:

```
cogyard hook session-start .
```

Run it from inside the new worktree — the `.` is the worktree. **Do not substitute `"$PWD"`:** the worktree-isolation sandbox refuses that argument as "too complex to verify", and a session that works around the refusal by improvising is exactly how a worktree ends up believing it is wired when it is not.

This mounts the `.cogyard/tasks` link to the task store, reserves the worktree's port pair in `~/.cogyard/ports.json` (idempotent — re-runs return the same pair), writes env files and the worktree's dev entry when the project has a committed worktree config (`.cogyard/worktree.json`), and prints the ports briefing. Read the briefing; any dev server started in this worktree binds those ports. The entry goes into the worktree's own `.claude/launch.json`, because `preview_start` reads only the chat's current folder's file, so the briefed `preview_start` works from inside the worktree once this has run. Before it has run, the name is not found.

**You must see that briefing.** It is the only proof the wiring happened. If instead you get `cogyard: nothing to wire`, you are not in a worktree — fix that rather than proceeding.

4. **Is the new worktree behind local main? Check before anything else.** EnterWorktree branches from `origin/<base>` (Claude Code's default `worktree.baseRef: fresh`), not from local `<base>`, so commits on local `<base>` that were never pushed are missing from the new worktree — and Step 0 passed, because it compares with origin. From inside the worktree, with `<base>` the default branch:

```
git log --oneline HEAD..<base>
```

   If it prints anything: report the count and the subjects, say why (EnterWorktree branched from origin; those commits are on local `<base>` only), and **STOP** — no drift check, no claim, no edits. The remedy is the user's to choose: for example, rebase this still-empty branch onto local `<base>` (`git rebase <base>`), or push `<base>` first. Never offer "a fresh worktree from local main": EnterWorktree cannot make one. Never replace the worktree — no ExitWorktree `remove` followed by a hand-made `git worktree add -b` and EnterWorktree `path=` (see Anti-patterns). If it prints nothing, carry on.

5. Re-run `cogyard env detect` to confirm the new worktree and ports are picked up before claiming.

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

**A DONE or ENOUGH task is reopened first**, before the claim and before any work — the user asking for more work on it is the reason, so don't ask:

```
cogyard tasks reopen <id> --why "<what the user asked for, in their words>"
```

It sets the status back to OPEN, clears `done_date`, and commits with the reason and this chat's id. New Scope boxes for the follow-up go into the file after that. A claim is valid only on an OPEN task: `claim` refuses any other status with exit code 4 (`not_open`, nothing written). A PARKED task is the user's hold — ask before setting it back to OPEN.

```
cogyard env claim <task-file-path> <session-id>
```

This atomically sets `claimed_at` (now, ISO timestamp), `claimed_by` (the human holder: `$COGYARD_USER`, else `git config user.name`, else `$USER`) and `branch` in the task file, and records this machine's worktree and session in `~/.cogyard/claims.json`. Refuses with exit code 2 if already claimed by another session — handle that case per Step 4; the refusal JSON names the holder in `claimed_by`. Refuses with exit code 3 (`wrong_worktree`, nothing written) when run inside a worktree that is not `task-<id>-…` for this task; the JSON's `expected_worktree` is the name to use — go back to Step 5's "A worktree made outside the process". The main checkout is always allowed.

**The claim commits itself.** `claim` commits just the task file in the store, so nothing is left pending after it — on every store, and on every route here, the continuation and the reopen of a DONE task included. On a remote-backed team store (origin + `tasks` branch) it also pulls first and pushes the commit — teammates see it immediately, and a lost race comes back as the normal already-claimed refusal, never a rebase conflict. See `docs/MULTI-USER.md`. `env release` does the same. There is no separate "claim push" step; an edit you make to the task file afterwards (bumping `last_reviewed_at_commit`, a box) is committed the usual way, `cogyard tasks sync push "<msg>" -- <task-file-path>`.

### 10. Work the task

Execute scope items in order (or any sensible grouping), running **the loop at the top of this skill** for every change: commit it, tick its box, then the next. Honor the rules below.

A file that belongs with the task rather than the code — a mockup, a check script, an audit — goes in the store at `files/<task id>/` (`$(dirname "$(cogyard tasks find <id>)")/files/<id>/`), never at the store root; the Edit/Write hook and `sync push` refuse anything else in a store.

Use `[x]` (lowercase) for ticks. The parser also accepts `X`, `✓`, `✔`, `✅`, `☑`, `done`, etc., but `[x]` is the convention — don't drift.

### 11. Claim lifecycle — claims persist until MERGE

A claim means "owned — not available." An unmerged task is not done, so
**finishing the work does NOT release the claim.** Ending a session with
acceptance met but the branch unmerged: KEEP the claim — the task shows as
claimed-by-you (in review), which is the truth. Only two events release:

- **Merge.** On the user's "merge it", `merge-to-main` runs the task's
  `(after merge)` checks and ticks them, ticks every open owner box
  `(you: …)` as reviewed (the user looked at the work before saying "merge
  it", and that is their review), then closes the task as DONE with
  `cogyard tasks close <id>` (claim released, committed) — nothing to do at
  session end. If the close still refuses (a check of yours failed, your
  own work is unfinished), the task stays OPEN and the report says what's
  left; nobody is asked anything. `--enough` and `--force` are the user's
  call: never offer them, and run one only when the user's own message in
  this chat says so — "close it as enough" for `--enough`, "close it as
  done" for `--force` — passing their exact words: `cogyard tasks close <id>
  --enough --asked "<their words>"`. The CLI checks the words against what
  the user typed and refuses anything else. `cogyard tasks reopen <id>
  --why "…"` (undoing a close) is yours to run whenever more work belongs to
  a closed task. Never hand-edit `status:` or `done_date:`, and never run git
  that writes inside the task store: hooks refuse both.
- **Returning the task to the pool** (switching away, wrong pickup, work
  discarded — the task should be available to others again):

```
cogyard env release <task-file-path>
```

The release commits itself, as the claim does (Step 9).

If switching tasks, re-run the Pickup Procedure for the new task starting at Step 1. A later continuation session re-claims over your own stale session id via the Step 4 flow.

## Behavior during execution — hard rules

These rules apply throughout Step 10. Don't violate.

### Continuous execution — don't stop at logical batch boundaries

Keep working through the task's full scope unless you hit a real boundary:

**Real boundaries that warrant a pause:**
- Scope expansion beyond the task file's Scope section.
- Sign-off needed (migrations, destructive ops, force-push, anything in the task's `out_of_scope:` list).
- Build break Claude can't resolve.
- Ambiguous spec that needs the user's call.
- All checkboxes ticked, except `(after merge)` ones: those wait for the merge.

**NOT boundaries (don't pause for these):**
- Finished a logical group of items.
- Wrote a summary-worthy chunk.
- Finished a change (commit it per the loop at the top and keep going).
- Completed a sub-phase.
- A check you can run yourself. Run it; never ask the user for a "go" first.

### Checks that need the merge — mark them, name them, run them

- **Mark it as soon as you find it.** When a box turns out to be checkable only once the work is on main (it needs the always-on server, a deploy, or hooks that run the main checkout's code), start its text with `(after merge)` in the task file and commit that edit. Older tasks don't carry the marker, so this is on you.
- **Name them before the merge.** When you report the work as ready to merge, list every `(after merge)` box and say you will run each one right after the merge, and list every open owner box `(you: …)` that the user's "merge it" will tick as reviewed. Then "merge it" covers all of them, and nothing comes as a surprise.
- **Run them in the merge, without asking.** `merge-to-main` step 10 runs them before closing. No "say go", no list of options, and never "close this chat so I can check": a check that seems to need the user's own chat closed or restarted gets a way you can observe yourself (feed the event through the hook, read the record).
- **Never add a look-at-it or after-deploy box yourself.** The user's "merge it" is their look; a production deploy is theirs and not part of the task (write-task's box rules).

### Scope discipline — never silently expand

If the work goes beyond the file's Scope section, STOP. Choose ONE:
- **(a) Append to Scope and commit the file edit as its own commit, then continue.** Use when the new item is clearly part of the same task, just missed in original spec.
- **(b) File it as a new task** via the `write-task` skill (or the host app's spawn-task feature, if one is available in this session). Use when the new work is large enough to deserve its own pickup brief.
- **(c) Get explicit user approval to expand silently.** Use sparingly, only for tiny adjacent fixes.

Never silently add 7 commits' worth of unspecified work. (This was a real failure mode in the past.)

### Files outside the task's list — add them before editing

The task's `touches_paths` is what autopilot and the Plan tab use to decide which tasks may run at the same time, so it must name every code file the work edits. Before editing a file the list doesn't cover (a shared index, a manifest, a test you didn't expect to touch), run:

```
cogyard tasks touches <id> --add <path>…
```

It adds the paths and commits the task file, then carries on. If a task in progress also lists one of them, it says so for information only: two tasks editing one file usually merge cleanly, and `cogyard tasks conflicts <id>` after your next commit (the loop at the top) is what says whether they actually collide. Markdown files don't need adding: a shared doc merges easily.

### Other tasks — go through the user, never edit their files

While working this task you may decide or learn something that belongs to a DIFFERENT existing task. Do not edit that task's file — its chat may be working on it right now, and a chat never re-reads its task file on its own, so it would not know.

- **Creating a new task is fine** — use `write-task` as usual.
- **Changing an existing task** (scope, a decision, a box, a note): tell the user in chat which task, what should change, and why. The user decides and handles it.
- **If that task is claimed by another chat** (`cogyard tasks find <id>` gives its file; `cogyard env where <file>` shows a `session` that is not this one): also give the user a paste-ready prompt for that chat — self-contained, naming the task, the change, and the reason — so the user can carry it over.

Communication between chats goes through the user for now.

### "What this is" stays in sync — refresh when shape changes

The task file's `## What this is` section (immediately after Status) is the project description a cold reader sees. **When the shape of the work changes, update that section in the same commit as the change.** Specifically:

- Added a new phase / sub-system / file the original spec didn't mention → update "What this is" file layout, runtime flow, or schema.
- Rejected an alternative or chose a different architecture mid-task → update "What this is" to describe the chosen design.
- Built a new system worth documenting beyond this task → at the end of the task, write a durable doc (e.g. `_docs/foo.md` or `docs/FOO.md`) and shrink "What this is" to 2–4 sentences + bold pointer to it.

Ticking boxes ≠ keeping the description current. Boxes record what was done; "What this is" records what exists now. Both must move forward together. If at the end of the task a cold reader can't tell what was built from "What this is" alone, the section is stale — fix it before declaring done.

### Commit policy — the loop is the rule

The loop at the top of this skill is the rule: commit each logical change on the branch as soon as it works, before starting the next; `git status --short` before each new change. The frontmatter's `commit_policy` only adds a minimum on top of it:

- `per-phase` (default) — also at least one commit per Scope heading.
- `per-acceptance` — also one commit per ticked Scope box.
- `end` and `single` — obsolete (`end` read as "one commit at completion", the exact failure the loop stops). Treat both as `per-phase`.

Failure this replaces (2026-09-25): a session held 12 files across seven changes uncommitted until the owner demanded commits, under an older wording ("commit at section boundaries", "never write 30+ files without committing") that never made it commit.

### Database changes — migrations, and SQL that fixes data

- **Check the live schema before writing a migration.** Not from the migration files: production drifts (manual fixes, failed migrations, hot patches). Ask the user to run the schema query in the project's admin tool (Supabase SQL Editor, `psql`) and paste the result, then write against that.
- **Structural SQL is a migration file, never run by hand.** Any CREATE / ALTER / DROP on tables, columns, indexes, constraints, enums, functions, triggers or policies goes in a migration file in the repo's pipeline.
- **SQL that fixes data is not a migration and never runs unseen.** An UPDATE / DELETE / INSERT that repairs rows, backfills or cleans orphans: show the user the SQL, say what it touches, and let them decide where and when it runs.
- **Migration acceptance — build-green is NOT acceptance.** If the task includes a database migration, surface the SQL to the user and wait for explicit confirmation that it ran cleanly against a real Postgres instance. Build-green is necessary but not sufficient.

### End-of-session ritual

If the session ends with unticked checkboxes in Scope, offer the user three options:
- **(a) Keep tracked in this task** (default). Task stays OPEN; `[x]/[ ]` ratio reflects partial completion in the dashboard.
- **(b) Spin remainder into a new task file** by writing a fresh task file via `write-task` (or the host app's spawn-task feature, if available).
- **(c) Settle the unticked items and close.** Mark each `(dropped: <why>)`, `(moved: <id>)` (after option (b) wrote that task) or `(optional)`; then the close happens at merge, or — with nothing to merge — you run `cogyard tasks close <id>` (with `(optional)` leftovers it needs `--enough`, which you run only when the user's own words say "close it as enough": `--asked "<their words>"`). Use when the remaining work no longer makes sense or has been overtaken by other changes. Never set `status` by hand. Settle only the boxes the user settled, with the reason in the user's own words; an owner step `(you: …)` is the user's to settle, never yours (the one exception: the user's own "merge it" ticks them as reviewed, in `merge-to-main`), and never settle a box just so a close stops refusing.

Always offer; do not silently leave it ambiguous. Then apply Step 11's claim lifecycle: work awaiting merge KEEPS the claim (in review); release only if the task goes back to the pool.

## Anti-patterns

- **Skipping Step 4 (claim check).** May collide with another parallel session. The whole reason for the claim mechanism is to detect this.
- **Skipping Step 7 (drift check).** Working against stale assumptions wastes time and may produce code that conflicts with what's already shipped.
- **Manually editing claim fields.** Use `cogyard env claim` and `cogyard env release` — they're atomic, hand-edits are not. Two sessions racing to manually edit could corrupt the frontmatter.
- **`git add` on the task-store link (`.cogyard/tasks`) in the project's repo.** The link is gitignored; the add does nothing. Use `cogyard tasks sync push "<msg>" -- <file>…` instead, which commits the files you name in the canonical dir's git repo.
- **Marking DONE without ticking checkboxes.** If the dashboard shows `5/30` but status is DONE, that's a smell — either tick the boxes that are actually done or leave status OPEN.
- **Settling a box for the user.** Writing `(dropped: the owner closed the task without it)` on the owner's phone check, unasked, to get a refused close through. Settling is a decision; only the user makes it, and the reason is theirs.
- **Undoing a close by hand.** Editing `status:` back, or `git revert` in the task store. A wrong close, or a closed task that gets more work, is reopened with `cogyard tasks reopen <id> --why "…"` — yours to run.
- **Leaving a task DONE while you add work to it.** A DONE file with new open boxes tells every reader the work is finished, and the next merge's `close` refuses it as already closed. Reopen it at pickup (Step 9).
- **Quoting words the user didn't type.** `--asked` is the user's exact words from this chat, never a paraphrase, a summary, or text you wrote yourself — the CLI refuses those, and trying is exactly the agent-decides-for-the-owner failure the owner-only check exists to stop.
- **Settling a box in prose.** "→ MOVED to the follow-up task", "OBSOLETE (owner decision)", "Deferred (owner's call)" on an unticked box reads as unfinished work to `cogyard tasks close`. Use the marker word: `(moved: 050)`, `(dropped: owner decision)`, `(optional)`.
- **Claim state that lies about ownership.** Two failure modes: releasing a finished-but-UNMERGED task (it looks available while it's actually in review — the gap this rule closes), and leaving an ABANDONED task claimed (blocks the next session for nothing). The invariant: merged → closed+released by `merge-to-main`; awaiting merge → claimed; back in the pool → released.
- **Replacing a worktree that came out behind main.** A real failure (2026-10-11): a first-time pickup's new worktree was behind local main, which held unpushed commits. Step 0 had passed (it compares with origin), and the chat claimed before checking. It then offered "a fresh worktree from local main" — something EnterWorktree cannot make — and on a yes removed the app's worktree with ExitWorktree `remove`, made a replacement by hand with `git worktree add -b`, and entered it with EnterWorktree `path=`. The chat moved to a different heading in the desktop sidebar, and undoing it took a dozen hand steps across the worktree, the branch, the claim, the task store, the port allocation and the launch file. A worktree that is behind main is reported and stopped on before the claim (Step 5, "To create the worktree", step 4); the remedy is the user's. The plugin's worktree guard refuses `git worktree add -b` (except one shape, from the main checkout only: a task worktree cut from another task's unmerged branch, `git worktree add .claude/worktrees/task-<id>-<slug> -b worktree-task-<id>-<slug> <other task's branch>`) and asks before ExitWorktree `remove`.
- **Bare EnterWorktree into a task's recorded worktree.** "Get back in the worktree" is a continuation trigger for this skill, not a navigation command — entering ad-hoc skips the staleness gate, the rebase step, and the claim. If the target worktree matches any task's recorded worktree (`cogyard env where`), run the Step 5 continuation flow instead.
- **Continuing a task in a worktree it wasn't picked up in.** A real failure: a chat invented a worktree name before the task existed, filed the task from inside it, and the later pickup reused and claimed that worktree instead of making `task-<id>-<slug>`; the owner had to have the commits moved by hand. Only `task-<id>-…` is the task's worktree — Step 5, "A worktree made outside the process".
- **Treating a merged/DONE task's follow-up as ad-hoc work.** Fixes to something a task shipped go through the same continuation ritual in that task's worktree — never directly on the base branch, never in an unclaimed checkout.

## See also

- The user's `~/.claude/CLAUDE.md` (auto-loaded) — per-user task-system conventions and hard rules typically live there; honor them when present.
- `write-task` skill, "The task storage model" section — the storage model reference (ships with this plugin).
- `write-task` — author a new task file (don't use this skill for that).
- `handoff` — produce a hand-off prompt for the next session (different from a task; for cross-session in-flight work).
- `cogyard tasks` — index/viewer/sync. Run with `--help` for subcommands.
- `cogyard env` — environment detection + claim helpers.
- `/cogyard` — slash command that boots the dashboard (ships with this plugin).
