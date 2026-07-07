---
name: debt-cleanup
description: |
  Structured multi-phase cleanup of a codebase that has grown feature-by-feature without refactoring.
  Produces a numbered task doc in `_tasks/NNN-*.md` with Tier A/B/C grading, then executes it via
  per-phase subagents with grep-able acceptance checks and a commit after each phase.
  Built for cogyard-initialized projects (a `_tasks/` dir exists); in a repo without `_tasks/`, ask
  the user where to put the task doc (e.g. `docs/` or repo root) instead of creating `_tasks/`.
  Use when the user asks to "clean up", "refactor", "fix software engineering issues", or references
  a healthier reference project they want their current one to match.
---

# Debt cleanup — planning + phased execution

A codebase that has grown feature-by-feature accumulates route handlers that do too much, missing security middleware, inline SQL, console.log logging, magic strings, and god functions. This skill is the playbook for cleaning it up without rewriting it.

## When to use

- User says "this project needs cleanup", "refactor this", "fix engineering issues".
- User points at a reference project (a healthier sibling codebase) and wants the current one to match its structure.
- Cleanup is large enough to span multiple commits but self-contained (not a ground-up rewrite).

**Don't use** for single-file fixes, bug investigations, or greenfield work.

## Process — three stages

### Stage 1 — Scope and compare (one session, no code changes)

Goal: produce a task doc that a future session (or you, in the same session) can execute against.

1. **Read project conventions.** `CLAUDE.md` at project root. Look for: shell-command rules, git hygiene rules, deployment invariants, no-leakage / compliance rules, "don't do X" lists. Treat these as non-negotiable.

2. **Map the current surface.** List files in `src/` tree. Count lines of the biggest god-functions. Note what directories exist (`routes/`, `services/`, `dal/`, `middleware/`?).

3. **If a reference project is named, inspect its layering.** Look at *its* `routes → services → dal` structure, middleware setup, logger, error handling. Also note anti-patterns in the reference that should NOT be copied (per-route `try/catch`, non-null assertions, magic error codes). Take the structure, leave the implementation smells.

4. **Write the task doc** at `_tasks/NNN-<slug>.md` using the Tier A/B/C template below. If the project has no `_tasks/` dir (not cogyard-initialized), don't create one for this — ask the user where the doc should live (e.g. `docs/` or repo root) and use that path throughout.

### Stage 2 — The task doc

Use this skeleton. The user will often revise it — that's expected; the doc is where they apply their judgment before any code runs.

```markdown
# NNN: <title>

## Context

<1 paragraph: what the backend grew into, what works today, what's at risk
 if we don't clean up before the next milestone>

Reference: <path to sibling project, if any — note "take structure, leave
 anti-patterns X/Y/Z">

---

## Current surface (post-Session N baseline)

<tree of src/ with one-line annotations pointing at the smells>

---

## Problems, graded by payoff

### Tier A — must do before <next real-traffic milestone>

Correctness / security / operability gaps. Not finishing these means real
traffic can hurt users or expose the service.

**A1. <one-sentence headline>.**
<what's wrong, 1-2 sentences; fix, 1-2 sentences>

**A2. ...**

### Tier B — high payoff, do as part of this task

Structural changes that prevent the next few sessions from worsening the
base.

**B1. ...**

### Tier C — nice-to-have, batch with a future pass

Small wins that are cheap once the tree is settled. NOTE: path aliases
belong here, not in Tier A. Doing aliases before files move means
find/replacing imports twice.

---

## What's deliberately NOT in this task

- Tests (if the project lacks a harness, say so)
- Any feature work
- Anti-pattern fixes in the reference project
- <anything else you're tempted to scope-creep>

---

## Proposed target layout

<tree of the settled state; route -> service -> dal, config/, middleware/,
 constants/, lib/, templates/>

---

## Execution plan

Each step leaves the build green AND the existing smoke scripts passing.
Don't move on until both hold.

1. **Tier A first.** In order: A1, A2, ... These are the gaps that matter.
2. **Logger early.** So later refactors can use req.log.
3. **DAL extraction.** One table at a time.
4. **Services layer.** Send first (biggest win).
5. **Atomic-write / migration work.** (If any.)
6. **HTML extraction.** (If any.)
7. **Constants.**
8. **Path aliases — LAST.** Single pass on the settled tree.
9. **Trivial extractions** (health route, etc.)

---

## Acceptance — grep-able + script-able

**Build / static checks**
- `<typecheck command>` clean.
- `grep -rn '\.from("' src/routes src/services` -> empty.
- `grep -rn 'console\.' src` -> empty.
- `grep -rn 'req\.<userField>!' src` -> empty (no non-null assertions on auth).
- `grep -rEn "'23505'|'23503'|'PGRST116'" src` -> empty.
- No file in src/routes/ exceeds 80 lines.

**Runtime / behavior**
- `curl -I <host>/health` shows helmet headers.
- Rate-limit kicks in after N requests.
- SIGTERM drains in-flight + exits clean within 10-15s.
- Structured log lines in the log drain (Better Stack, Logtail, etc.).

**End-to-end smoke**
- <list the existing smoke scripts the project already has — re-run after each phase>

---

## Anti-patterns from <reference project> to NOT carry over

- Per-route try/catch returning generic 500.
- Non-null assertions on auth fields.
- Magic Postgres error codes inline.
- Loose `Record<string, any>` update payloads.
- Silent log-and-continue error recovery.
```

### Stage 3 — Phased execution

One agent per phase. Commit after each. Verify acceptance before moving on.

Main-agent loop per phase:

1. **Update the session task list** (TaskCreate/TaskUpdate, or TodoWrite in older Claude Code versions) — mark previous phase completed, current phase in_progress.
2. **Dispatch an agent** with the brief template below. Use `subagent_type: general-purpose`. Foreground (you need its report to decide whether to commit).
3. **Verify agent claims.** Don't trust the summary — run the acceptance greps yourself, run the typecheck. Agents' "done" ≠ actually done.
4. **Stage specific files only** — never `git add -A`. Read `git status` first, stage what you recognize from the agent's report.
5. **Commit with a structured message** — reference the phase + tier + the acceptance greps that now pass.

## Agent brief template

Every brief includes these sections. Omit any and agents will either exceed scope or miss something.

```
You are executing Phase N (<tier letter><number>) of <task doc path>.
READ that file first — especially the <specific bullet> and the acceptance
grep section. Also READ <project CLAUDE.md path>.

Phases 1..N-1 are done: <one-line each>. Do NOT regress any of those.

Project root: <absolute path>. Bash tool cwd is already repo root.

## Your scope (Phase N only)

<Specific deliverables. Name files, function signatures, behavior. Don't
 say "refactor X" — say "extract the 6 inline queries in X to Y, exporting
 A, B, C with these signatures">

## Constraints (match the project's CLAUDE.md conventions)

- One command per Bash call. No &&, ||, ;, |, &, newlines, `cd`, or `-C`.
  Run npm as `npm run --prefix <dir> <script>`.
- Don't commit. Parent commits.
- No `git add -A` / `git add .`.
- Don't touch: <explicit list of things owned by later phases>.
- If a dependency is missing, STOP and report — don't `npm install`
  speculatively. (Unless you're the parent and decide to install.)
- After edits, <typecheck command> must be clean.
- These greps from prior phases MUST still pass: <list>.
- New greps that MUST pass after this phase: <list>.
- No emojis. Terse comments only where WHY isn't obvious.

## Report back (under 250 words)

(a) Files created.
(b) Files edited (1 line each).
(c) Typecheck result.
(d) All grep results.
(e) Anything you deferred or couldn't do.
Do NOT paste code.
```

## Pitfalls — known failure modes

Include mitigations for these in every brief.

1. **Scope-missed directories.** Agent scoped to `routes + core` left inline SQL in `jobs/`. **Fix**: list *every* directory in the constraint block, not just the obvious ones. "Routes, services, jobs, middleware, lib" — enumerate.

2. **Workspace lockfile.** `npm install --prefix <pkg>` creates a per-package `package-lock.json`, breaking npm workspaces. **Fix**: always `npm install --workspace <pkg>` from root, OR plain `npm install` from root after editing `package.json`. Check for a spurious `<pkg>/package-lock.json` in `git status` after every phase that touches deps; delete + re-sync if it appears.

3. **Missing deps.** Agent pauses waiting for parent to install. **Fix**: acceptable — instruct agents to STOP and report rather than run `npm install`. Parent installs, then sends the "resume" agent.

4. **Spec deviation.** Agents sometimes justify deviations (template path, file layout). **Fix**: read the report, check the actual files before committing. If the deviation is functionally fine, keep it; if it violates project conventions (e.g., CLAUDE.md no-leakage rules), reject and re-dispatch.

5. **Ordering gotcha — path aliases.** Tempting to do first (biggest find/replace). WRONG — every subsequent phase that moves files forces a second find/replace. Always LAST, after the tree has settled.

6. **Runtime resolution with path aliases.** TypeScript's `"module": "NodeNext"` does NOT rewrite import specifiers in emitted JS. Installing `paths` in tsconfig is NOT enough — prod `dist/` will fail at runtime. Need `tsc-alias` in a postbuild hook, AND a check that dev runtime (tsx, ts-node) honors paths natively before converting.

7. **Central error handler + async routes.** Express 4 doesn't forward promise rejections to error middleware. Need an `asyncHandler(fn)` wrapper OR Express 5. Don't promise a central handler without this.

8. **DAL error-mode decision.** Discriminated union vs. thrown typed errors. **Pick thrown typed errors** — composes with the central error handler; avoids re-introducing per-route try/catch. Record the decision somewhere durable.

9. **Provider abstraction leaks.** A route importing a provider-specific helper is the tell. Fix by enriching the normalized-event interface (add fields like `bounceType: 'hard' | 'soft' | null`) and computing in the provider.

10. **Migrations and DDL.** Per typical project CLAUDE.md, Claude does NOT run DDL. Write the SQL file, tell the user what to paste into which editor. Tests that depend on the migration should note the manual step.

## Honest post-task review

After the last commit, do an honest review covering:
- Issues encountered mid-execution (and how you fixed them).
- Explicit TODOs still in the code.
- Things "explicitly out of scope" per the task doc.
- Smoke-tests NOT run (be specific about what you did and didn't exercise).
- Items the user should close before the next milestone (e.g., "CORS on `/v1/broadcasts` before the admin SPA lands").

Skipping this review erodes trust. Users can read a diff; they can't read what you didn't do.

## Meta — when the skill applies vs. doesn't

Applies:
- Multi-tenant service grown to 5-20 routes, no layering.
- Routes doing DB + validation + business logic + rendering inline.
- No logger, no rate limits, no central error handling.
- User has a clear payoff milestone ahead (real traffic, admin UI, second tenant).

Doesn't apply:
- Greenfield — use normal scaffolding patterns.
- Tiny (1-3 route) services — overengineering.
- Projects without a test harness AND without smoke scripts — no way to verify phases don't regress. Build a smoke harness first, then apply this skill.
