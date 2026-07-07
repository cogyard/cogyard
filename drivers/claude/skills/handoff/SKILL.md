---
name: handoff
description: |
  Produce a paste-ready handoff prompt for a fresh Claude Code session to continue or follow on from work happening in the current session. Built for cogyard-initialized projects (a `_tasks/` dir exists): the handoff is saved to `_tasks/` so it's durable in the project's repo. In a repo without `_tasks/`, still usable — ask the user where to save the brief (default: `HANDOFF.md` at repo root) instead of assuming `_tasks/`. Use when the user says "write a handoff", "prepare for next session", "brief the next claude", "this is going long, prep for handoff", "handoff for the next task", "stop here and prep handoff", or otherwise indicates that the work needs to cross a session boundary. Trigger preemptively when the user mentions stopping for the day, switching machines, or starting a new related task — the handoff is cheap to produce and expensive to skip.

  Different from `/compact`: this produces an external, hand-curated brief for a NEW session (full token budget, fresh context, no transcript baggage). `/compact` keeps the same session alive with a smaller context. Use this for cross-session continuity; use `/compact` for in-session breathing room.
---

# handoff — paste-ready brief for a fresh session

Produces a self-contained prompt the user can paste into a brand-new Claude Code session to continue a long-running task or kick off a follow-on task. The brief lives in `_tasks/` so it's preserved in the project's repo history.

## When to use

- Current session is long and the user wants to break across days or machines.
- Current task is wrapping; a successor task is starting that benefits from carrying state forward.
- User wants to hand off the work to themselves later, or to a different operator.

Do NOT use for one-shot questions, single-file fixes, or short sessions that fit in context.

## Two handoff flavors

The skill produces the same shape either way; only the framing differs.

- **Continuation** — same task, next session. Heading: `Continuing <task> at session N`. Cite work done so far (commits, current session task-list state).
- **Successor** — new task that follows from this one. Heading: `Starting <new task>, following from <previous task>`. Cite the artifacts the previous task produced.

If unclear which, ask the user once: "Continuation of <X>, or a new task that follows from it?"

## Procedure

### 1. Locate the project + the task

Identify the project root (current cwd unless told otherwise). If the project has a `_tasks/` directory, look at the last few entries — the most recent numbered task is probably what's being handed off. Otherwise ask the user which task this is.

### 2. Gather durable state to reference (don't inline it)

Run these reads but **don't paste their contents into the brief**. The next session will read them itself; the brief just says where to look.

- `cat <project>/CLAUDE.md` — confirm path + skim for project-specific rules to call out.
- `ls <project>/_docs/ <project>/docs/` — note which docs exist (whichever dir the project uses); the brief will reference them by name.
- `ls <project>/_tasks/` — note recent task docs.
- The project's auto-memory directory, if the session has one (its exact path is stated in your system prompt's memory section; it's keyed to the repo root, so all worktrees share it — do NOT derive it from `$PWD`). List its `*.md` files; the brief should point at them by name. Skip if auto-memory is absent.
- `git -C <project> log --oneline -15` — to summarize what's been done.
- `git -C <project> status --short` — flag uncommitted work in the brief if non-empty.
- Active session task list — to reflect in-flight items.

### 3. Determine scope

Read the relevant `_tasks/NNN-*.md` if one exists for this work. If the handoff is mid-task, scope = "remaining items in <task>." If successor, scope = the next task's stated objective. If neither, ask the user for one paragraph of scope and one bullet list of acceptance.

### 4. Identify non-negotiables to surface

Pull from:
- `<project>/CLAUDE.md` — its critical-rules / don't-do sections, whatever they're called.
- The auto-memory file capturing the project's architecture rules, if one exists.
- The user's cross-project rules from their `~/.claude/CLAUDE.md` (auto-loaded) and memory files.

Keep only the ones that bite if the next session forgets them. A 4–8 bullet list, not a copy-paste of CLAUDE.md.

### 5. Identify live state worth carrying

Things the next session will burn time re-discovering:
- Deployed URL(s) and current commit SHA.
- Working API keys / passwords — by **reference to the memory file** that holds them, not inline. (Inline secrets become a leak vector when the brief is committed to `_tasks/`.)
- Project ids / canonical test data ids.
- Existing test contacts / aliases that work without re-creating.

If the user wants secrets inline anyway (e.g. for a brand-new project where there's no memory file yet), do it but warn: "Brief will be committed to `_tasks/`; consider whether secrets in repo history are acceptable."

### 6. Write the brief using the template below

### 7. Save to `_tasks/`

**No `_tasks/` in this project?** The project isn't cogyard-initialized. Don't create `_tasks/` for this; ask the user where to save the brief (suggest `HANDOFF.md` at repo root, or a docs dir the project already has) and skip the numbered-filename rules below.

Filename:
- Continuation: `_tasks/<NNN>-handoff-<slug>.md` (e.g. `_tasks/008-handoff-angular-admin.md`).
- Successor for an existing numbered task line: continue numbering — if the prior was `005-backend-cleanup.md`, the next is `006-<slug>.md`.
- Successor at a new "session" line: `<NNN>-<slug>.md`.

Don't auto-commit. Tell the user the file is staged in their repo and they can review + commit before the new session starts.

### 8. Print the prompt

Output the brief in a fenced code block so the user can triple-click + copy. Above the block, give a one-line summary like "Handoff written to `_tasks/008-handoff-angular-admin.md`. Paste the block below into a new session."

## Output template

Use this skeleton. Omit sections that don't apply (e.g. "Uncommitted work" if the tree is clean).

```
<Continuing|Starting> <task title> at <project name> (<absolute project path>).

<one-paragraph framing — what this is, what's been done so far if continuation,
or what artifact this follows on from if successor>

READ FIRST, in order:
1. CLAUDE.md (repo root) — <one-line of what specifically matters here>
2. <the project's architecture/status doc, wherever it lives — _docs/, docs/, README> — <which section>
3. <the project's decisions/conventions doc, if it keeps one> — <recent entries that bear on this work>
4. _tasks/<NNN>-<slug>.md — <the task being executed>
5. <the project's auto-memory files, by name — path from the system prompt's memory section> — <which memory>

LIVE STATE (don't recreate):
- Deployed: <url> — currently on commit <sha> per /health.
- Working API key / admin password: see <the memory file that holds them>.
- Project ids: <listed by name + uuid>.
- <any other test fixtures / canonical aliases>.

UNCOMMITTED WORK (only if git status non-empty):
- <list>
- The next session should resolve these before starting new work.

SCOPE:
<numbered list of concrete deliverables the next session is responsible for.
If continuing, list remaining items. If successor, list new task's objectives.>

NON-NEGOTIABLES:
<4–8 bullets pulled from CLAUDE.md, project architecture-rules memory,
cross-project preferences. The ones that bite if forgotten.>

OUT OF SCOPE for this session:
- <explicit list — what NOT to touch>
- <future-phase work>

ACCEPTANCE:
<concrete, runnable criteria — same shape as the task doc's acceptance section.
The next session knows it's done when these pass.>

CLOSING:
- Commit + push (auto-deploys if applicable).
- Verify deploy via /health commit SHA matching HEAD.
- Update the project's status/implementation doc, if it keeps one.
- Update the project's decisions doc if anything material was decided.
- Run handoff again if this work also needs to cross another session.
```

## Notes on the brief

- **Self-containment.** The brief cannot say "as we discussed" — the next session has no transcript. Every statement must stand alone.
- **Reference, don't inline.** Point at files (memory files, the project's docs) for content that already lives somewhere durable. Inlining duplicates content that will drift.
- **Acceptance is non-optional.** Every brief includes acceptance criteria the next session can run. Without them, "is it done?" is unanswerable.
- **Length.** A good brief is ~80–200 lines. Shorter and the next session lacks state; longer and it becomes a doc to skim instead of a brief to execute.

## Examples (when to use which flavor)

**Continuation, same numbered task:**
A backend-cleanup ran across two days. Day 1 completed Tier A; Day 2 needs to do Tier B. Filename: `_tasks/005-handoff-backend-cleanup.md`. Heading: "Continuing the 005 backend cleanup at session 2." Live state: which Tier A items committed (with SHAs), what's in `git status`, which task-list items are pending.

**Successor, new task line:**
The 005 cleanup finished. The next task is the Angular admin (006). Filename: `_tasks/006-angular-admin.md`. Heading: "Starting the Angular admin (006), following from the 005 cleanup." Live state: artifacts the cleanup left behind that the admin builds on (the typed `AuthenticatedRequest`, the central error handler, the `/v1/admin/_internal/send` route to keep).

**Cross-day pause, no task doc yet:**
Mid-feature, no `_tasks/` entry exists for this work yet. Skill creates one: `_tasks/<NNN>-<slug>.md` containing both the brief and the work-so-far summary. The brief written at the bottom of that doc, the rest is task definition.
