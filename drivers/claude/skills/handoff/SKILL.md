---
description: |
  Produce a paste-ready handoff prompt for a fresh Claude Code session to continue or follow on from work happening in the current session. The brief is printed in chat and NOT saved into the task store — a handoff is orchestration, not a unit of work, and filing it as a task leaves an item that can never be completed. Use when the user says "write a handoff", "prepare for next session", "brief the next claude", "this is going long, prep for handoff", "handoff for the next task", "stop here and prep handoff", or otherwise indicates that the work needs to cross a session boundary. Trigger preemptively when the user mentions stopping for the day, switching machines, or starting a new related task — the handoff is cheap to produce and expensive to skip.

  Different from `/compact`: this produces an external, hand-curated brief for a NEW session (full token budget, fresh context, no transcript baggage). `/compact` keeps the same session alive with a smaller context. Use this for cross-session continuity; use `/compact` for in-session breathing room.
---

# handoff — paste-ready brief for a fresh session

**A project with its own version of this skill** turns this one off in its `.claude/settings.json` (`"skillOverrides": { "cogyard-handoff": "off" }` — its personal name, so a project skill named `handoff` stays on) and gives its own a different name, with `Replaces cogyard's handoff. Last reconciled against it: <date>.` at the top. A project skill that is merely also named `handoff` does not replace this one: this one is `cogyard-handoff` installed with `cogyard claude install` and `cogyard:handoff` under the plugin, so both load and nothing says which applies. `cogyard tasks doctor` flags one that runs beside this one or is out of date. See `drivers/claude/README.md`, "Skipping or replacing a skill in one project".

Produces a self-contained prompt the user can paste into a brand-new Claude Code session to continue a long-running task or kick off a follow-on task. **The brief is chat output only — it is never saved into the task store and never gets a task number** (see step 7).

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

Identify the project root (current cwd unless told otherwise). If the project has a task directory (`.cogyard/tasks`), look at the last few entries — the most recent numbered task is probably what's being handed off. Otherwise ask the user which task this is.

### 2. Gather durable state to reference (don't inline it)

Run these reads but **don't paste their contents into the brief**. The next session will read them itself; the brief just says where to look.

- `cat <project>/CLAUDE.md` — confirm path + skim for project-specific rules to call out.
- `ls <project>/_docs/ <project>/docs/` — note which docs exist (whichever dir the project uses); the brief will reference them by name.
- `ls <project>/.cogyard/tasks/` — note recent task docs.
- The project's auto-memory directory, if the session has one (its exact path is stated in your system prompt's memory section; it's keyed to the repo root, so all worktrees share it — do NOT derive it from `$PWD`). List its `*.md` files; the brief should point at them by name. Skip if auto-memory is absent.
- `git -C <project> log --oneline -15` — to summarize what's been done.
- `git -C <project> status --short` — flag uncommitted work in the brief if non-empty.
- Active session task list — to reflect in-flight items.

### 3. Determine scope

Read the relevant task file if one exists for this work (`cogyard tasks find <id>` prints its path). If the handoff is mid-task, scope = "remaining items in <task>." If successor, scope = the next task's stated objective. If neither, ask the user for one paragraph of scope and one bullet list of acceptance.

### 4. Identify non-negotiables to surface

Pull from:
- `<project>/CLAUDE.md` — its critical-rules / don't-do sections, whatever they're called.
- The auto-memory file capturing the project's architecture rules, if one exists.
- The user's cross-project rules from their `~/.claude/CLAUDE.md` (auto-loaded) and memory files.

Keep only the ones that bite if the next session forgets them. A 4–8 bullet list, not a copy-paste of CLAUDE.md.

### 5. Identify live state worth carrying

Things the next session will burn time re-discovering:
- Deployed URL(s) and current commit SHA.
- Working API keys / passwords — by **reference to the memory file** that holds them, not inline.
- Project ids / canonical test data ids.
- Existing test contacts / aliases that work without re-creating.

If the user wants secrets inline anyway (e.g. for a brand-new project where there's no memory file yet), do it — the brief is not committed anywhere, but remind them it will sit in the chat transcript.

### 6. Write the brief using the template below

### 7. Do NOT save the brief into the task store

**A handoff is orchestration, not work. It never becomes a task file and never gets a task number.**

Ben's rule, stated emphatically 2026-08-18 after this skill put two handoff "tasks" into one
project's store: tasks are pieces of work; an orchestration prompt filed as a task creates a task
about the task, and it then sits OPEN forever because nobody ever completes a prompt. When one task
from an orchestrated run is unfinished, the backlog shows two open items and stops reflecting real
remaining work. His no-companion-files rule (2026-06-19) already named handoffs specifically.

So:

- **Do not write the brief into the task store.** Not as `NNN-handoff-<slug>.md`, not under a real task's
  number, not as a companion file.
- **Do not run `cogyard tasks next-id`** for it. It has no id.
- **Do not commit it anywhere.**
- **The chat message IS the deliverable** — print it (step 8) and stop.
- If the user explicitly asks for it on disk, write it OUTSIDE the repo (the session scratchpad
  directory) and say where it went.

What carries the durable record instead: the task files themselves (each closed with its own evidence
note), and the project's run log if it keeps one (e.g. `docs/AUTOPILOT.md`).

### 8. Print the prompt

Output the brief in a fenced code block so the user can triple-click + copy. Above the block, give a one-line summary like "Paste the block below into a new session." Do not announce a saved file — there isn't one.

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
4. <path `cogyard tasks find <NNN>` prints> — <the task being executed>
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
A backend-cleanup ran across two days. Day 1 completed Tier A; Day 2 needs to do Tier B. Heading: "Continuing the 005 backend cleanup at session 2." Live state: which Tier A items committed (with SHAs), what's in `git status`, which task-list items are pending.

**Successor, new task line:**
The 005 cleanup finished. The next task is the Angular admin (006). Heading: "Starting the Angular admin (006), following from the 005 cleanup." Live state: artifacts the cleanup left behind that the admin builds on (the typed `AuthenticatedRequest`, the central error handler, the `/v1/admin/_internal/send` route to keep).

**Cross-day pause, no task doc yet:**
Mid-feature, no task file exists for this work yet. That is fine — the handoff still produces
no file. If the *work itself* deserves a task, that is a separate `write-task` call for the work, not
for the handoff.
