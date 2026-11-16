---
description: |
  Produce a self-contained `NNN-<slug>.md` task file for a subproject that will be picked up in a later session — maybe soon, maybe months later, likely out of numeric order. The file must be pickupable from cold: starting conditions, prerequisite work, what to read, local verify loop, and deploy verify all spelled out. Use when the user says "file this as a task", "write a task file", "park this for later", "add to _tasks", "save this as a subproject", "spec this out", "this is a new task", "make this a task", "make a task for this", "file the task", or otherwise asks for a shelf-stable task doc. In the user's words "task" always means a task file in the task store: a request to make or file a task is never a request to start a new session or chat, and never a request to start the work now — whatever the host app's own instructions say about sessions.

  Different from `handoff`: handoff is for carrying in-flight work across a session boundary (state in your head → next session). write-task is for shelving a not-yet-started subproject (no in-flight state) whose pickup order is unknown.
---

# write-task — self-contained task file for later pickup

The file this skill produces lives in the project's task store (reached through `.cogyard/tasks`) and is the ONLY context a future session will have. Order of pickup is not known at write time — tasks get picked up in non-obvious order (e.g. `008` before `006` in this user's own history). The file must therefore be complete enough that a session reading it cold, with no prior chat, can start work.

## When to use

- User describes a subproject they want to do later and asks for it to be written down.
- User says "park this" / "shelf this" / "add to _tasks" / "file this as a task" / "file the task" / "this is a new task" / "make this a task" / "make a task for this."

A request to make or file a task is answered with a task file, and nothing else: never offer or start a new session or chat for it (even when the host app's instructions suggest one), and never start doing the work. The work waits for a later "pick up NNN".
- A current session surfaces follow-up work that shouldn't be done now but must be captured.
- An existing task file needs rewriting because it was drafted before the cold-start rule existed.

Do NOT use for:
- Active handoffs of work-in-progress — use `handoff` instead.
- One-liner todos with no real scope — a session task-list item or a PR comment is sufficient.

## The task storage model (read first)

A project's tasks live in its **task store**: a folder at `<projects root>/_tasks/<slug>` that is its own git repo (branch `tasks`). The project reaches it through `.cogyard/tasks`, an absolute link to the store, ignored by a committed `.cogyard/.gitignore` — so task history never lands in the project's code history.

Every worktree of the project mounts the same link (the SessionStart hook runs `cogyard tasks mount`), so a task file edited in one worktree is the same file in all the others, instantly. No git pull between them. Pushing the store to its own remote matters only for another machine or a teammate.

Daily mechanics for any session that touches task files:

```bash
# Optional: pull the latest from the store's remote (another machine or a teammate only)
cogyard tasks sync pull
# ... edit task file(s) at the path `cogyard tasks find <id>` prints (new task: next-id's `file`) ...
cogyard tasks sync push "<message>" -- <file> [<file>…]
```

Always name the files you changed after `--` (task files by the path `cogyard tasks find` prints, attachments under `files/<id>/`). Several chats share one store; without names the push has to guess which pending files are this chat's, and it leaves uncommitted anything it can't tell is yours — another chat's claimed task, or an unclaimed file you didn't reserve.

`cogyard tasks sync push` runs git in the store (the link's target), never in the project repo. `git add .cogyard/tasks` in the project does nothing: the link is ignored there.

**What a store holds:** task files, `axes.json`, `switches.json`, and each task's attachments — a mockup, a script, an audit, any file type — under `files/<task id>/` (e.g. `files/179/mockup.html`), linked from the task body by that path. Nothing else: no notes, handoffs or idea lists at the store root. The Edit/Write hook and `sync push` refuse anything else, and the portal's store view flags it.

If this checkout has no task directory yet, the project isn't set up: `cogyard onboard --kind <kind>` once, from the repo, creates the project's store, links `.cogyard/tasks` to it, and registers the project. On a project that is already set up it changes nothing.

## Procedure

### 1. Confirm location + sync

- Current project's task directory (`.cogyard/tasks`). If it doesn't exist, the project isn't set up on this machine: tell the user, and offer to run `cogyard onboard` (it asks for the project's `--kind`).
- **Sync first:** `cogyard tasks sync pull` to pick up any new tasks or claims pushed from other machines.
- Next number: run `cogyard tasks next-id <slug>` once you have the slug locked in. It atomically reserves the next free id across every checkout of the store (uses an O_EXCL sentinel in the store's canonical dir) and creates the empty placeholder file at the path it returns in JSON. Write the task body at that exact `file` path — never at `<repo>/.cogyard/tasks/NNN-…`, even though it names the same file. Where that is a link to a shared store, the `file` path is the store's real location; a Write or Edit through the link resolves outside the working directory, which Claude Code answers with a permission prompt (or, in a worktree, a refusal). **Do not** scan with `ls` and pick the highest yourself — parallel sessions racing on the same store will collide on the id. If the user wants a specific number (e.g. re-filing an existing stub), skip `next-id` and create the file directly — in the store's real directory (`realpath .cogyard/tasks`), for the same reason. Numbering is identity only, not ordering — gaps and `b/c` suffixes are acceptable.

### 2. Read the project's durable docs to extract pointers

The cold-start preamble references project docs by name. Before writing, verify they exist so the references are accurate.

- `CLAUDE.md` at project root — always auto-loaded by a future session; skim for the project's conventions and critical rules so the preamble can point there ("see CLAUDE.md → Critical rules").
- `_docs/*.md` — list them; identify which are relevant to this task's area (e.g. `_docs/PROJECT.md` for architecture context, `_docs/DECISIONS.md` for durable rules that constrain the work).
- The store's `*.md` files — list recent tasks; the new task may depend on one, or explicitly follow another. If the new task is a follow-up, cite the precursor.
- `db/migrations/` or equivalent — note the current head migration; if the task depends on a migration, spell out which number.

Do NOT paste contents of these docs into the task file. Reference them by path and section. The future session reads them itself.

### 3. Gather enough to fill the template

- **Staleness gate:** task bodies containing counts, file inventories, or
  "as of commit X" claims must be counted against the current default branch —
  run `cogyard tasks staleness` first (it resolves
  main/master itself and fetches + compares against `origin/<base>`, so a push
  from another worktree counts even before you pull; exits 1 when behind). An
  inventory from a stale worktree poisons the task for every future pickup.

Ask the user only for what's not inferable from context. Specifically, these must be answered before writing:

- **Title + slug.** Short noun phrase ("Automated DB backups", "Admin UI polish").
- **Status.** One of: `OPEN` (active backlog), `PARKED` (deliberately shelved — a hold on something external or on a human decision), `DONE` (historical record), `ENOUGH` (shipped enough; leftovers recorded in the body), `OBSOLETE` (superseded). NOTE: there is no `PARTIAL` status — partial completion is tracked via the body's `[x]` / `[ ]` checkbox count, not a status field. There is also no "blocked" status (the former `BLOCKED_ON` is retired): **blocked on another task → list it in `depends_on:` and stay `OPEN`** (the portal derives "waiting on #N" and self-clears it when the dep closes); **blocked on anything external → `PARKED`**.
- **Type + labels.** `type` is **required** and a **closed enum** — one of `feature | maintenance | bug | docs` (feature = new user-facing capability · maintenance = internal work, no new behavior: restructures/renames/releases/deps/ops · bug = something broken · docs = non-code documentation/copy). It's the *user's* call, not the agent's, so **collect it with `AskUserQuestion`**: a single-select listing all four values with your best guess first, labelled "(Recommended)". The 4 values fit the tool's 4-option cap exactly — no "Other" overflow. (Was `category` in older files, which still carry `category:`, aliased to `type` on read — but author new files with `type:`.) `labels` are **optional and reuse-or-none** — pick them from the registry (below) as a multi-select of *existing* labels, never a free-text field. Bias low: a label exists only to group this task with others, so **one accurate registered label beats three, and no label beats a freshly-minted one** — a label used once groups nothing, and that lone tag IS the proliferation this step prevents. Skip the type question only when the user already stated the type explicitly in their request. The frontmatter validator (`cogyard tasks validate`, also enforced by the plugin's PreToolUse hook) rejects a missing/invalid `type`, so this is not optional to fill.

  **Labels are picked from the registry, not written — the registry is a closed menu until you deliberately extend it.** First run **`cogyard tasks labels`** (add `--json` for machine-readable) in the project — it prints the resolved label axes (shared `$COGYARD_HOME/axes.json` + the project's `axes.json` in its task store) with a per-label task count, then the in-use-but-unregistered labels. Propose labels **only** from that output, using the exact registered spelling (the registry holds `frontend`, so UI/portal/angular/responsive work all take `frontend` — never coin `ui`, `portal`, or `ux`).

  Minting a **new** label is a separate, deliberate act, and all three gates must hold: **(1)** no registered label fits the concept, not even loosely; **(2)** the concept will **recur** across future tasks — if it's a one-off, take the closest registered label or *none*, because a singleton label is the exact thing we're preventing; **(3)** the user **explicitly approves that specific new label in the confirm step** — "new label `foo`, not in the registry — not a synonym of `bar` because …; ok?". A new label the user didn't sign off on is a bug, not a convenience. New labels do **not** auto-join `axes.json`: they land in Ungrouped until the owner curates them into an axis, and that friction is the point — it's what keeps the axis vocabulary closed and the board legible. If no registry exists yet (`cogyard tasks labels` shows "No axis map"), fall back to the union of labels already used across the project's tasks.
- **"What this is" content.** The single most important section for future readers. Decide which mode applies:
  - If an existing durable doc covers the system this task builds on/extends, **verify the doc exists and is current** (read it; if stale, either update it first or use mode-b). Then write a 2–4 sentence summary + bold pointer.
  - If no durable doc exists, the task file IS the doc. Gather enough up front to write the inline architecture: problem statement, file layout (which files, what they do), config schemas, runtime flow, onboarding, debugging. If the task will *create* a new system worth documenting beyond this task's lifetime, consider also producing a durable doc at the end and having the task file point at it.
- **Steps only the owner can do — partway through the work, and nothing else.** An owner step is something the agent cannot get past without the owner while it is building: `decision` (a choice the task can't settle, e.g. pick a look from a reference sheet), `credential` (a login, token or secret only they hold), `purchase` (money must be spent). Mark that checkbox at the start of its text: `- [ ] (you: decision) Choose the badge look from the reference sheet`; several kinds allowed, comma-separated. Mark the STEP, never the task, and put it where it really falls in the order (a login usually first; a choice before the build that depends on it). List the marked steps in the confirm step so the owner can correct them. Reference: `docs/TASK-STATUS-VOCABULARY.md`.
- **No box for the owner looking at the work.** The owner always looks at the work (on their phone, in the browser, in the worktree's portal) before saying "merge it", and that "merge it" is their review and sign-off. So never write "the owner looks at it", "the owner tries it on their phone", "the owner lives with it for a few days" or "the owner confirms it" as a box. `merge-to-main` ticks any such box from an older task as reviewed.
- **No box for anything after a deploy.** Deploying is the owner's. "Confirmed on the phone against production", "watch it after the deploy" and the like are not part of the task; a problem found in production is a new bug task.
- **No check the owner didn't ask for.** Write the checks the work needs, not a generic list: no VoiceOver, accessibility, dark-mode, light-and-dark or "test on two phones" box unless the owner asked for it.
- **Every other check box is the agent's to do.** Read each verification box as the session that will do it: can it run this check by itself and see the result? If not, rewrite it as something it can observe (run the app on the simulator, feed the event through the hook, read the record, call the endpoint). Never write a check that needs the owner to close, restart or archive their own chat (or any of their sessions).
- **Checks that can only run once the work is on main.** Start the box with `(after merge)`: `- [ ] (after merge) The Plan card reads "idle" on the real portal`. It is the agent's own work: `merge-to-main` runs it right after the merge, ticks it with what was seen, and then closes. `cogyard tasks close` keeps refusing until it is ticked, and its refusal tells the agent to run it rather than asking the owner. Use it for a check that needs main's code live: the always-on local server, or hooks that run the main checkout's code. Never for something that needs a production deploy (see above). A check the worktree can already run is a normal box. Reference: `docs/TASK-STATUS-VOCABULARY.md`.
- **Boxes settled without being done.** When editing an existing task and a box is decided rather than done, leave it `[ ]` and start its text with one word: `(dropped: <why>)`, `(moved: <id>)` (another project: `<slug>#<id>`; write that task first), or `(optional)` (left behind — a leftover: the task then closes as `ENOUGH`, because DONE means nothing is left). Still wanted? Write that task and mark the box `(moved: <its id>)` — there is no "wanted, nobody holds it" marker (`(deferred)` is retired). Never prose like "→ MOVED to the follow-up task" or "Deferred (owner's call)" — `cogyard tasks close` can't read it and treats the box as unfinished. Never delete the box. Reference: `docs/TASK-STATUS-VOCABULARY.md`.
- **touches_paths — files, not folders.** List the files the task will edit, or a narrow folder it owns (`frontend/src/app/plan/`). **Refuse a whole top-level folder** (`docs/`, `core/`, `cli/`, `server/`, `frontend/src/app/`): the Plan tab works out which tasks can run side by side from these entries, and a top-level folder tells it nothing, so the task shows as "files unknown". If you genuinely can't name the files yet, name the likeliest ones and say so in the body.
- **Blocked on another project's task** → `depends_on: [<slug>#<id>]` (e.g. a task in another project waiting on cogyard 166 writes `cogyard#166`). Never leave a cross-project wait only in prose — prose is invisible to the Plan tab.
- **Order vs running at the same time — two questions, three lists.** Each list is about this task only; never name another task it might collide with. *Can it start yet?* → `depends_on` (the only thing that makes a task wait). *Can it run beside another task?* → `touches_paths` plus `resources`: what it uses that isn't a file — a production database, a deployed function, DNS, a device, an App Store submission — as short names (`prod-db`, `dns`, `app-store-submission`; lowercase words joined by `-`). Leave `resources: []` when it touches nothing live. Two tasks sharing a file or a resource never wait on each other; autopilot just won't run them at once. Advice on how to edit alongside another in-flight task goes in **Branch strategy**, not the frontmatter.
- **commit_policy.** `per-phase` (default: at least one commit per Scope heading) or `per-acceptance` (one commit per ticked box). Either way, the working session commits each change on the branch as soon as it works (see the loop at the top of pickup-task). Don't use `end`; it is obsolete.
- **out_of_scope.** Categories of change Claude must NOT silently do without escalation. Examples: "no migrations," "no API contract changes," "no new dependencies." This is a guard rail; the more explicit it is, the less likely a session silently expands scope.
- **Starting condition.** What must be true before the session begins. List migrations applied, tenants onboarded, infrastructure provisioned, secrets rotated, other tasks completed. If none, say "Standalone — no prerequisites beyond a clean checkout."
- **Scope.** The actual work, as checkboxed sub-items if it's a list, or as numbered sub-tasks if they're meant to be done sequentially.
- **Acceptance.** How the session knows it's done. Per-sub-task if granular, or a single list if monolithic. **For migrations:** acceptance is "applied successfully against a real Postgres instance," NOT "build green." Surface the SQL to the user and wait for confirmation.

### 4. Write the file using this shape

The frontmatter block is **required** and machine-parsed by `cogyard`. Keep field order and casing exactly. Populate `created_at_commit`, `last_reviewed_at_commit`, and `last_touched_commit` with the current short SHA from `git rev-parse --short HEAD` *in the project worktree* (not the tasks-branch worktree).

**Stamp `created_by_session`** with THIS session's id, so `cogyard sessions chats <id>` can later point back to the chat that authored the task. Source it from the newest transcript in the current dir's flattened transcript folder — the session actively being written is this one:

```bash
ls -t ~/.claude/projects/"$(pwd | sed 's/[/.]/-/g')"/*.jsonl 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null | sed 's/\.jsonl$//'
```

If that yields nothing (unusual layout, no transcript), set `created_by_session: null` and move on — the lookup falls back to a best-effort git-time inference for un-stamped tasks; it never blocks task creation.

```markdown
---
id: NNN
slug: <slug>
title: <title>
status: OPEN
type: <feature|maintenance|bug|docs>       # required; collected via AskUserQuestion — see step 3
labels: []              # optional; reuse-or-none — pick from `cogyard tasks labels`, omit if nothing fits
created: YYYY-MM-DD
created_by_session: <session id | null>    # the authoring session — for `cogyard sessions chats`; source it per the note below
created_at_commit: <short SHA>
last_reviewed_at_commit: <short SHA>
last_touched_commit: <short SHA>
done_date: null
depends_on: []          # task ids that must be DONE first; another project's task is `<slug>#<id>` (e.g. cogyard#166)
related: []             # soft links, not blockers
touches_paths:          # the FILES the task edits (relative to repo root) — never a whole top-level folder like docs/ or core/
  - <path>
commit_policy: per-phase
out_of_scope:
  - <category of change Claude must escalate before doing>
resources: []           # live things it uses that aren't files (prod-db, dns, a device) — tasks sharing one don't run at once
env:                    # the shared claim; `cogyard env claim` fills it. The worktree and the chat id are this machine's (~/.cogyard/claims.json) — never in the file
  branch: null
  claimed_at: null
  claimed_by: null
---

# NNN: <title>

> **Status: <OPEN | PARKED | DONE | ENOUGH | OBSOLETE>.** <One sentence explaining what the status means in this context.>

## What this is

**Required section. Goes here, right after the Status line. Never bury it.** A human or future AI session must be able to read this section and understand what the task builds, what problem it solves, and how the pieces fit together — without reading the Scope checkboxes to reverse-engineer it.

Two modes; pick one per subsection:

- **(a) Linkable external doc exists and is current.** Write 2–4 sentences summarizing the project + a bold pointer to the durable doc (e.g., `**See `_docs/foo.md`** for architecture, file layout, schemas, runtime flow.`). Do this when the underlying system is documented in `_docs/`, a `docs/*.md`, a Notion page, etc., AND that doc is up to date. If you cite a doc, that doc must already exist and reflect current reality — never link to a doc that hasn't been written or is known stale.

- **(b) No durable doc exists.** Put the architecture in this section, inline. Include:
  - **The problem it solves** — one paragraph, plain English.
  - **How it works at a glance** — 3–5 numbered steps from input to output.
  - **File layout** — table(s) of the files/dirs the system reads or writes, with one-line "what it does" per row. Group by scope (user-level, per-project, per-instance) when relevant.
  - **Schemas** — any config-file shapes the system reads. Annotate fields inline.
  - **Runtime flow** — numbered steps for what happens when the system runs.
  - **Onboarding** — how a new consumer (project / user / caller) opts in.
  - **Operating + debugging** — table of "I want to X" → command.
  - **Known limitations / caveats** — bulleted list.

Sizing rule: if a human cold-reader (no context, no transcript) cannot answer "what does this thing do and how do the parts fit together?" from this section alone, it's incomplete.

## For a cold-start session

A session picking this up has only this file and the project's auto-loaded docs. Read in this order:

1. <path/to/doc> — <why>.
2. <path/to/doc> — <why>.
3. <any task dependencies> — <why>.

**Relevant conventions** (from the project's decision/architecture docs and `CLAUDE.md`):
- <durable rule that governs the change area>
- <another>

**Local verify loop:** <how to run the thing locally, port numbers, credentials location>.

**Deploy verify:** <platform-specific — e.g. poll the deployed `/health` for a commit SHA matching HEAD>.

**Branch strategy:** <branch name suggestion; how to edit alongside other in-flight branches that touch the same files, if any>.

## Pickup checklist

Run these in order before reading anything else.

1. **Sync (optional, cross-machine only).** `cogyard tasks sync pull` — pulls from the canonical's git remote. For a symlinked shared store on the same machine, no sync is needed (same files on disk).
2. **If this file lacks frontmatter, generate it first** — edit it at the path `cogyard tasks find NNN` prints, never `<repo>/.cogyard/tasks/…` (through a shared-store link that edit prompts, or is refused in a worktree). Infer status from prose context, depends_on from prose mentions of other task numbers, touches_paths from file paths in the body. Confirm with user before bumping the HEAD anchors. Then `cogyard tasks sync push "backfill frontmatter for NNN" -- <path from cogyard tasks find NNN>`.
3. **Detect environment.** `cogyard env detect` — reports worktree / branch / ports / hostname for `env:`.
4. **Check claim.** `cogyard env where <path from cogyard tasks find NNN>` prints the claim with this machine's session. If `claimed_at` is set and `session` is not this session's id, STOP. Tell user: "Task N is claimed by <env.claimed_by, else session X> in worktree Z since DATE. Continue (re-claim), pick a different task, or coordinate with the other session?" (`claimed_by` is the human holder — on team stores it may be a teammate, not another of your own sessions.)
5. **Verify dev servers match the worktree.** For each port `cogyard env detect` reports: `cogyard env port-owner <port>`. If `matches: false`, surface to user: "backend on <port> is from worktree X, not this one — smoke-test results may not reflect your code."
6. **Drift check.** `cogyard tasks drift <task-id-or-file>` — resolves the default branch (main/master), fetches it, and lists commits on `origin/<base>` that touched `touches_paths` since `last_reviewed_at_commit` (against origin, never the checkout's own HEAD, so a teammate's push counts before you pull). Read each commit message + diff over those paths.
7. **Verify assumptions.** Walk through the body and confirm each stated assumption still holds.
8. **For UI work:** write a 1-sentence sketch of where the page/component will appear (sidebar group, route path, parent component) and ask the user to confirm placement BEFORE implementing. UI placement decisions are the highest-risk class — catch the disagreement at minute 5, not minute 90.
9. **Claim the task.** `cogyard env claim <path from cogyard tasks find NNN> <session-id>`, which commits the claim itself; then bump `last_reviewed_at_commit` to current HEAD (editing the file at the path `cogyard tasks find NNN` prints, as in step 2) and commit that with `cogyard tasks sync push "bump review point NNN" -- <path from cogyard tasks find NNN>`.
10. **Claim lifecycle.** Claims persist until MERGE — `merge-to-main` closes the task (DONE + done_date) and releases. Finishing work does NOT release; keep the claim while awaiting merge. Release only when returning the task to the pool (switch/abandon): `cogyard env release <path from cogyard tasks find NNN>`, which commits itself.

## Starting condition

<What must already be true. "Standalone — no prerequisites" if none. Otherwise enumerate: migration NNN applied, task NNN done, infra provisioned, etc.>

## Context

<Why this task exists in its situational context (what business problem / what change in the world prompted it). Keep brief — the "what does this build" goes in "What this is" above, not here. If "What this is" already covers the why, you may omit this section.>

## Scope

<Checkboxed items, grouped by theme if many. Each item terse but unambiguous. Pointer to specific file(s) where known.>

- [ ] <item> — <file path if known>
- [ ] <item>

## Acceptance

<How the session knows each item is done. Per-item if granular; single list if monolithic. For migrations: include "applied against a real Postgres instance" as a required acceptance step.>

## Out of scope

<What looks in-scope but isn't. Why. Where to park spillover.>
```

Every section is required except "Out of scope" body section (include only when genuinely clarifying). The frontmatter `out_of_scope:` array is always required (use `[]` if truly nothing).

### 5. Confirm with the user before saving

Show the user the section headings you'll use and ask: "Anything missing? Anything I should cut?" Then write the file.

### 6. Push the new task

After saving the file: `cogyard tasks sync push "add task NNN: <title>" -- <the file next-id printed> [files/NNN/…]` — the new task file, plus any attachment you wrote for it. It commits (and pushes, when the store has a remote) in the store's own git repo.

Every worktree sees the new file immediately through the link — no git pull needed.

## Pickup behavior is in `pickup-task`

Rules around what to do *while executing* a task — continuous execution, scope discipline, commit policy, migration acceptance, end-of-session ritual — live in the `pickup-task` skill, not here. This skill (`write-task`) is for AUTHORING a task file. Once written, picking it up later triggers `pickup-task` with its own procedure and rules.

## Anti-patterns

- **Thin or missing "What this is".** If a future reader has to piece the project together from the Scope checkboxes, the section is broken. Either inline enough architecture to understand the system, or link to a durable doc that does. NEVER omit the section.
- **Pointing at a doc that doesn't exist yet or is stale.** Mode-(a) (link to durable doc) only works if the doc is real and current. Verify before citing. If the doc is the output of THIS task, you're in mode-(b) until that doc exists — the task file carries the architecture.
- **Inlining doc contents when a durable doc exists.** If `_docs/foo.md` is current and covers the system, write 2–4 sentences + bold pointer. Don't paste the doc into the task file — it'll drift.
- **Assuming session memory.** Every "we just did X" phrase is a leak. Future session has no "we."
- **Status without date.** `DONE` without a `done_date` in frontmatter is near-useless for figuring out when the work actually shipped.
- **Mixed active/done items.** If a file has both completed and pending sub-items, that's fine — but the index uses `[x] / [ ]` count to compute progress, so be consistent: tick completed boxes, leave the rest unticked.
- **Scope creep.** If the task sprouts three big new themes while writing, that's three tasks, not one. Split them before saving.
- **Skipping "Starting condition".** The most common reason a session stalls in the first 10 minutes is "wait, does this need X first?" Always answer that up front.
- **Skipping the Pickup checklist when picking up.** If you skip step 1 (sync), you may work against stale state. If you skip step 4 (claim check), you may collide with another session. The checklist exists because both failure modes have happened.
- **Manually editing claim fields.** Use `cogyard env claim` and `cogyard env release` — they're atomic, the file edit is not. Two sessions racing to manually edit could corrupt the frontmatter.

## Backfill paths for pre-frontmatter task files

Older task files (written before this v2 spec) have no YAML frontmatter. They show up in the index's "Unknown" bucket. Three sanctioned paths to migrate them:

1. **On-pickup (primary).** When Claude picks up an older task, the Pickup checklist's first step backfills frontmatter inferred from the body. This handles every active task naturally; the dead tail stays unmigrated indefinitely with no cost.
2. **Heuristic bulk.** `cogyard tasks analyze` classifies unknown-frontmatter tasks (dry-run by default; `--apply` writes the inferred frontmatter).
3. **CLI bulk.** `cogyard tasks --backfill` walks unknown files in `$EDITOR`. Optional power-user path; not required.

Do NOT write a one-shot bulk-migration script that touches all old files at once. Files without frontmatter are valid; let them migrate as you touch them.

## See also

- `cogyard tasks` — index/viewer/sync/init script. Run with `--help` for subcommand list.
- `cogyard env` — environment detection + per-task claim helpers.
- `/cogyard` — slash command that shows usage / opens the portal (ships with this plugin).
- `handoff` — for in-flight work crossing a session boundary, not for shelving a not-yet-started subproject.

## Worked examples (for reference)

Good task files to study are whichever existing `NNN-*.md` task files in the current project score well against the template: a filled "What this is", explicit starting conditions, checkboxed scope, runnable acceptance. Read one or two recent ones before writing, if any exist.
