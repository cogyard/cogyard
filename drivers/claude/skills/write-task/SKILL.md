---
name: write-task
description: |
  Produce a self-contained `_tasks/NNN-<slug>.md` file for a subproject that will be picked up in a later session — maybe soon, maybe months later, likely out of numeric order. The file must be pickupable from cold: starting conditions, prerequisite work, what to read, local verify loop, and deploy verify all spelled out. Use when the user says "file this as a task", "write a task file", "park this for later", "add to _tasks", "save this as a subproject", "spec this out", or otherwise asks for a shelf-stable task doc.

  Different from `handoff`: handoff is for carrying in-flight work across a session boundary (state in your head → next session). write-task is for shelving a not-yet-started subproject (no in-flight state) whose pickup order is unknown.
---

# write-task — self-contained task file for later pickup

The file this skill produces lives in the project's `_tasks/` folder and is the ONLY context a future session will have. Order of pickup is not known at write time — tasks get picked up in non-obvious order (e.g. `008` before `006` in this user's own history). The file must therefore be complete enough that a session reading it cold, with no prior chat, can start work.

## When to use

- User describes a subproject they want to do later and asks for it to be written down.
- User says "park this" / "shelf this" / "add to _tasks" / "file this as a task."
- A current session surfaces follow-up work that shouldn't be done now but must be captured.
- An existing task file needs rewriting because it was drafted before the cold-start rule existed.

Do NOT use for:
- Active handoffs of work-in-progress — use `handoff` instead.
- One-liner todos with no real scope — a session task-list item or a PR comment is sufficient.

## The _tasks/ storage model (read first)

`_tasks/` is one of two shapes per project:

- **Normal directory** — tracked in the project's repo on `main` like any other content. Used for single-clone projects (e.g., a typical app repo).
- **Symlink to a shared canonical directory** — used for multi-clone "planet" projects (e.g., a project with several sibling clones). All clones symlink to the same on-disk location, so changes from any clone are visible to all others instantly via the filesystem. The canonical dir is itself a git repo (typically the project's `tasks` branch on origin) for version history.

Why the symlink case matters: parallel work across clones just works. Edit a task file in one clone → its siblings see the same file (same inode). No git pull between clones needed; reads/writes are filesystem-level. Pushing to the canonical's git remote is only relevant for cross-machine sync.

Daily mechanics for any session that touches `_tasks/`:

```bash
# Optional: pull latest from canonical's git remote (cross-machine sync only)
cogyard tasks sync pull
# ... edit task file(s) ...
cogyard tasks sync push "<message>"
```

For the symlink case, `cogyard tasks sync push` runs git in the canonical dir (the symlink target). Same UX whether `_tasks/` is a normal dir or a symlink.

If `_tasks/` doesn't exist in this clone yet, run `cogyard tasks init` once. It creates an empty `_tasks/` dir and registers the project. For multi-clone projects, you'll need to manually replace it with a symlink to the shared canonical location.

## Procedure

### 1. Confirm location + sync

- Current project's `_tasks/` folder. If it doesn't exist, ask the user if `cogyard tasks init` has been run on this clone. If not, offer to run it.
- **Sync first:** `cogyard tasks sync pull` to pick up any new tasks or claims from other sessions on other clones.
- Next number: run `cogyard tasks next-id <slug>` once you have the slug locked in. It atomically reserves the next free id across all sibling clones (uses an O_EXCL sentinel in the canonical _tasks/ dir) and creates the empty placeholder file at the path it returns in JSON. Write the task body into that file. **Do not** scan with `ls` and pick the highest yourself — parallel sessions racing on the same store will collide on the id. If the user wants a specific number (e.g. re-filing an existing stub), skip `next-id` and create the file directly. Numbering is identity only, not ordering — gaps and `b/c` suffixes are acceptable.

### 2. Read the project's durable docs to extract pointers

The cold-start preamble references project docs by name. Before writing, verify they exist so the references are accurate.

- `CLAUDE.md` at project root — always auto-loaded by a future session; skim for the project's conventions and critical rules so the preamble can point there ("see CLAUDE.md → Critical rules").
- `_docs/*.md` — list them; identify which are relevant to this task's area (e.g. `_docs/PROJECT.md` for architecture context, `_docs/DECISIONS.md` for durable rules that constrain the work).
- `_tasks/*.md` — list recent tasks; the new task may depend on one, or explicitly follow another. If the new task is a follow-up, cite the precursor.
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
- **Category + labels.** `category` is **required** and a **closed enum** — one of `feature | maintenance | bug | docs` (feature = new user-facing capability · maintenance = internal work, no new behavior: restructures/renames/releases/deps/ops · bug = something broken · docs = non-code documentation/copy). It's the *user's* call, not the agent's, so **collect it with `AskUserQuestion`**: a single-select listing all four values with your best guess first, labelled "(Recommended)". The 4 values fit the tool's 4-option cap exactly — no "Other" overflow. `labels` is **optional + open** (free-form tags like `frontend`, `infra`); propose 0–3 you'd suggest and let the user add/remove — a separate multi-select or free-text, or just inline in the same question's notes. Skip the question only when the user already stated the category explicitly in their request. The frontmatter validator (`cogyard tasks validate`, also enforced by the plugin's PreToolUse hook) rejects a missing/invalid `category`, so this is not optional to fill.
- **"What this is" content.** The single most important section for future readers. Decide which mode applies:
  - If an existing durable doc covers the system this task builds on/extends, **verify the doc exists and is current** (read it; if stale, either update it first or use mode-b). Then write a 2–4 sentence summary + bold pointer.
  - If no durable doc exists, the task file IS the doc. Gather enough up front to write the inline architecture: problem statement, file layout (which files, what they do), config schemas, runtime flow, onboarding, debugging. If the task will *create* a new system worth documenting beyond this task's lifetime, consider also producing a durable doc at the end and having the task file point at it.
- **commit_policy.** One of: `per-phase` (commit at section boundaries — default for multi-section work), `per-acceptance` (commit per checkbox item), `end` (one commit at completion). Choose based on coordination needs and review style.
- **out_of_scope.** Categories of change Claude must NOT silently do without escalation. Examples: "no migrations," "no API contract changes," "no new dependencies." This is a guard rail; the more explicit it is, the less likely a session silently expands scope.
- **Starting condition.** What must be true before the session begins. List migrations applied, tenants onboarded, infrastructure provisioned, secrets rotated, other tasks completed. If none, say "Standalone — no prerequisites beyond a clean checkout."
- **Scope.** The actual work, as checkboxed sub-items if it's a list, or as numbered sub-tasks if they're meant to be done sequentially.
- **Acceptance.** How the session knows it's done. Per-sub-task if granular, or a single list if monolithic. **For migrations:** acceptance is "applied successfully against a real Postgres instance," NOT "build green." Surface the SQL to the user and wait for confirmation.

### 4. Write the file using this shape

The frontmatter block is **required** and machine-parsed by `cogyard`. Keep field order and casing exactly. Populate `created_at_commit`, `last_reviewed_at_commit`, and `last_touched_commit` with the current short SHA from `git rev-parse --short HEAD` *in the project worktree* (not the tasks-branch worktree).

```markdown
---
id: NNN
slug: <slug>
title: <title>
status: OPEN
category: <feature|maintenance|bug|docs>   # required; collected via AskUserQuestion — see step 3
labels: []              # optional, open tags (e.g. [frontend, infra]); omit or [] if none
created: YYYY-MM-DD
created_at_commit: <short SHA>
last_reviewed_at_commit: <short SHA>
last_touched_commit: <short SHA>
done_date: null
depends_on: []          # array of other task ids that must be DONE first
related: []             # soft links, not blockers
touches_paths:          # file/dir globs the task affects (relative to repo root)
  - <path>
commit_policy: per-phase
out_of_scope:
  - <category of change Claude must escalate before doing>
parallel_safe: true     # set false if this task can't safely run alongside others
coordination: []        # array of {with: <id>, hazard: <path>, rule: <coordination rule>}
env:
  planet: null          # populated by Pickup checklist via `cogyard env detect`
  ports:
    backend: null
    frontend: null
  hostname: null
  worktree: null
  branch: null
  db: development
  claimed_at: null
  claimed_by: null
  claimed_by_session: null
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
3. <any _tasks/ dependencies> — <why>.

**Relevant conventions** (from the project's decision/architecture docs and `CLAUDE.md`):
- <durable rule that governs the change area>
- <another>

**Local verify loop:** <how to run the thing locally, port numbers, credentials location>.

**Deploy verify:** <platform-specific — e.g. poll the deployed `/health` for a commit SHA matching HEAD>.

**Branch strategy:** <branch name suggestion; coordination hazards with other in-flight branches, if any>.

## Pickup checklist

Run these in order before reading anything else.

1. **Sync (optional, cross-machine only).** `cogyard tasks sync pull` — pulls from the canonical's git remote. For symlinked `_tasks/` shared between sibling clones on the same machine, no sync is needed (same files on disk).
2. **If this file lacks frontmatter, generate it first.** Infer status from prose context, depends_on from prose mentions of other task numbers, touches_paths from file paths in the body. Confirm with user before bumping the HEAD anchors. Then `sync push "backfill frontmatter for NNN"`.
3. **Detect environment.** `cogyard env detect` — populates planet / ports / hostname / worktree / branch in `env:`.
4. **Check claim.** If `env.claimed_at` is set and `env.claimed_by_session` is not this session's id, STOP. Tell user: "Task N is claimed by <env.claimed_by, else session X> on planet Y, worktree Z since DATE. Continue (re-claim), pick a different task, or coordinate with the other session?" (`claimed_by` is the human holder — on team stores it may be a teammate, not another of your own sessions.)
5. **Verify dev servers match the worktree.** For each port in `env.ports`: `cogyard env port-owner <port>`. If `matches: false`, surface to user: "backend on <port> is from worktree X, not this one — smoke-test results may not reflect your code."
6. **Drift check.** `cogyard tasks drift <task-id-or-file>` — resolves the default branch (main/master), fetches it, and lists commits on `origin/<base>` that touched `touches_paths` since `last_reviewed_at_commit` (against origin, never the checkout's own HEAD, so a teammate's push counts before you pull). Read each commit message + diff over those paths.
7. **Verify assumptions.** Walk through the body and confirm each stated assumption still holds.
8. **For UI work:** write a 1-sentence sketch of where the page/component will appear (sidebar group, route path, parent component) and ask the user to confirm placement BEFORE implementing. UI placement decisions are the highest-risk class — catch the disagreement at minute 5, not minute 90.
9. **Claim the task.** `cogyard env claim _tasks/NNN-*.md <session-id>`, bump `last_reviewed_at_commit` to current HEAD, then `cogyard tasks sync push "claim NNN from <planet>/<worktree>"`.
10. **Claim lifecycle.** Claims persist until MERGE — `/merge-to-main` closes the task (DONE + done_date) and releases. Finishing work does NOT release; keep the claim while awaiting merge. Release only when returning the task to the pool (switch/abandon): `cogyard env release _tasks/NNN-*.md` then `cogyard tasks sync push "release NNN — back in the pool"`.

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

After saving the file: `cogyard tasks sync push "add task NNN: <title>"`. For symlinked `_tasks/`, this commits + pushes in the canonical dir. For normal `_tasks/` dirs (single-clone projects), it commits + pushes the project repo's main branch.

For the symlink case, sibling clones (e.g., other planets) see the new file immediately via the filesystem — no git pull between clones needed.

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

Older `_tasks/*.md` files (written before this v2 spec) have no YAML frontmatter. They show up in the index's "Unknown" bucket. Three sanctioned paths to migrate them:

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

Good task files to study are whichever existing `_tasks/NNN-*.md` files in the current project score well against the template: a filled "What this is", explicit starting conditions, checkboxed scope, runnable acceptance. Read one or two recent ones before writing, if any exist.
