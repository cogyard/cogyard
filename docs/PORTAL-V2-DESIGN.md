# Portal v2 — Design & Direction

**Status:** design agreed. Phase 0 (worktree view) BUILT + verified live, awaiting commit + user sign-off.
**Date:** 2026-06-05.
**Owner:** Ben.
**Scope:** the cogyard portal (`tasks.mjs --serve` + `viewer/`) and where it goes next.

> **RETIRED / SHIPPED (2026-06-08):** This design is now realised. The Angular portal
> reached parity and the cogyard host cut over to it (`http://cogyard/`). The old
> `tasks.mjs --serve` HTTP server + `viewer/` were then **deleted** (commit `dae2d32`):
> `tasks.mjs` is now a pure data + CLI layer with **no HTML**, and the Angular portal is the
> sole presentation layer (the `.claude ↔ portal` boundary is data-only). The text
> below predates that cull and is preserved as the historical design record — wherever
> it says `--serve`/`viewer/` "keeps running" or describes the static `tasks-all.html`,
> read that as done/superseded by the live portal + its `/api/overview`.

This doc is the durable record of a design discussion. It is the spec, not a task file
(task files deferred by choice). When build starts, lift phases out of here.

---

## 1. The goal, in one sentence

**One portal where tasks and git are visible together, in sync, across all projects —
with Claude as the primary operator, optimised for smoothness of working with ideas.**

Everything below is downstream of that.

## 2. What Ben actually values (the decisive constraint)

> "I want Claude to have primacy in operation and smoothness of working with my ideas.
> Hosted or not is not as big an issue. I kept things in md files and local because I
> thought Claude will have an easier time with that rather than being behind an API or MCP."

This is correct, and it's the load-bearing decision. Local markdown is genuinely
lower-friction for Claude than a hosted API/MCP, for concrete reasons:

- Zero auth, zero rate limits, zero network — reads/writes are `Read`/`Edit`.
- `grep` across all projects' tasks in one call; no per-query API round-trips.
- Edits are reviewable diffs; the store version-controls itself (the `tasks` branch).

Local-md is only worse at: (a) real-time human collaboration, (b) notification/assignment
/triage workflows, (c) a polished UI you didn't build. Of these, only (a) matters here,
and only "occasionally" (Ben is solo + occasional collaborators).

## 3. Decisions taken

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Markdown stays the source of truth.** Do NOT move the store to GitHub/Jira/Linear. | Claude-primacy. GitHub would make the #1 pain (context-switching) *worse* short-term — one more place behind an API with more friction. |
| D2 | **The portal becomes the single pane of glass** — tasks + git + cross-project, all in one UI. | Directly kills the SmartGit ↔ tasks-page round-trip, which is the biggest daily friction. |
| D3 | **Git view is READ-ONLY, and its headline is WORKTREE VISIBILITY.** No staging/commit/branch/merge UI. | Ben's worst SmartGit pain is worktree visibility — SmartGit makes him hand-add each worktree, and he runs many parallel Claude-Code worktrees. `git worktree list` auto-enumerates them for free. He keeps SmartGit for everything risky. When a merge breaks he tells Claude to "abandon and redo" — he will NOT drive merges from the portal. |
| D4 | **GitHub is deferred, optional, one-way.** Only when "occasional others" becomes "regular others": a "publish task → GitHub issue" button. Markdown stays canonical. | Don't pay GitHub's Claude-friction tax for a collaboration need that isn't here yet. |
| D5 | **Rebuild the portal in Angular + PrimeNG** (Ben's standard stack; `bd-scaffold-fullstack` + `bd-scaffold-angular`). | The current portal is a 969-line god-file (6 concerns fused). Adding git-view + dashboard + board + search + graph to it deepens code Ben already distrusts. Rebuild *before* piling on, not after. |
| D6 | **Sequencing: relief now, rebuild next.** Phase 0 = half-day read-only git view on the existing JS to kill the daily pain immediately. Then the Angular rebuild as a proper project. | Throwaway Phase-0 code is small; relief this week is worth it. |
| D7 | **The CLI (`tasks.mjs claim/sync/analyze/next-id/current`) stays.** Skills depend on it; it works; it's not the painful part. | Rebuild touches presentation, not the CLI surface. |
| D8 | **Planets collapse is a SEPARATE cleanup**, not part of the portal work. | See §7. Worktree port-management superseded the reason planets existed. |

## 4. Current architecture (why the rebuild is justified)

`tasks.mjs` — **969 lines doing six jobs:** CLI dispatch, HTTP server, HTML rendering,
frontmatter parsing, registry resolution, git calls. `viewer/viewer.js` (338) + `index.html`
(193) + `viewer.css` (137). Total system ~1,879 lines.

The **valuable, correct, stable** logic is ~300–400 lines: frontmatter parse, registry
resolution, planet-collapse, the `git log … last_reviewed_at_commit` review-counting
(`tasks.mjs:202`). It's fused to the HTTP server + HTML rendering — that fusion is the
"terrible to manage" part. A rebuild **lifts the data core and rebuilds only the
presentation** — it is not from zero.

## 5. Target architecture (Ben's routes → services → DAL monorepo standard)

```
cogyard/
  core/        shared, typed DAL — parse / registry / planet-collapse / git helpers.
               Imported by BOTH the CLI and the API. One definition of "how a task is read."
  server/      Express, read-mostly API over core/. Markdown stays source of truth.
  frontend/    Angular 21 + PrimeNG (per bd-scaffold-angular). The portal UI.
  tasks.mjs    CLI stays; imports core/ instead of defining everything inline.
```

The **old `tasks.mjs --serve` keeps running** until the Angular portal reaches parity,
then retire only the serve/render code. Nothing breaks mid-flight.

### API surface (sketch — read-mostly)

- `GET /api/projects` — registry + per-project summary.
- `GET /api/projects/:slug/tasks` — parsed tasks + frontmatter.
- `GET /api/projects/:slug/commits` — `git log` (read-only), with `[#NN]` task tags parsed out.
- `GET /api/projects/:slug/status` — working-tree dirty/ahead-behind (read-only, lightweight).
- `GET /api/overview` — live cross-project aggregate (replaces the stale static `tasks-all.html`).
- Writes (status toggle, etc.) go through to the markdown files + existing sync path.

## 6. Feature scope ("tasks feel primitive" → enrich, don't replace)

All buildable over local markdown, no store change:

- **Worktree command center (THE headline — Ben's worst SmartGit pain).** Auto-enumerate
  every worktree per project via `git worktree list` (no manual adding — the thing SmartGit
  won't do). Per worktree, READ-ONLY, show:
  - branch + short commit
  - **ahead/behind `main`** (`git rev-list --left-right --count main...branch`)
  - dirty/clean (`git status --porcelain`)
  - **staleness flag** — heuristics: not-ahead-of-main, or clean-and-not-ahead, or
    duplicate-commit with another worktree. (Evidence this matters: `earth` has ~28
    worktrees, commit `8b1ba27` shared by four of them — a clear graveyard.)
  - optional: its allocated ports from `worktree-ports.json`, so stale worktree = visible
    leaked port allocation.
  - **Scope is deliberately small:** ahead/behind + staleness ONLY. NOT live in-progress
    rebase/merge detection, NOT predictive trial-merge conflict warnings — Ben explicitly
    deprioritised both. No actions in the view (prune is a deferred task — see §8).
- **Git panel per project**, commits cross-linked to tasks via the `[#NN]` tags the
  `/commit` skill already stamps. (This is the unique win SmartGit can't do.) Secondary to
  the worktree view.
- **Live cross-project dashboard** — every project's open/in-flight tasks *and* recent
  commits / dirty state side by side. Replaces the stale Apr-27 static file.
- **Labels/tags** — add to frontmatter, filter in the portal.
- **Full-text search** across all tasks (trivial server-side over local files).
- **Board view** (kanban by status) — pure frontend over existing data.
- **Dependency graph** — render existing `depends_on` / `related` frontmatter as links/graph.

## 7. Separate cleanup: collapse the planets (not part of portal work)

The "planets" model (multiple clones sharing `_tasks` via symlink to a canonical git
repo) was the pre-worktree solution to running parallel clones with distinct ports.
**Worktree port-management now does that**, so planets are "not really needed." Collapsing
the symlink-shared `_tasks` back to a normal directory is a structural change deserving its
own careful task — file separately, do not entangle with the portal rebuild. Not yet
authorised to execute.

## 8. Explicitly NOT doing

- Not moving the task store to GitHub / Jira / Linear (D1).
- Not building portal-driven git writes — SmartGit stays for staging/commit (D3).
- **Not driving merges/rebases from the portal — ever.** When a merge breaks, Ben tells
  Claude to abandon and redo. The portal only *shows* worktree drift; it never acts on it.
- **Not pruning worktrees yet** — view-only now. A "remove dead worktree + free its ports"
  action is a DEFERRED task, to be filed when a graveyard becomes a real problem in practice
  (the `earth` ~28-worktree pile is the canary).
- Not live in-progress rebase/merge detection or predictive conflict warnings (deprioritised).
- Not collapsing planets as part of this work (D8/§7).
- Not splitting this into task files yet (Ben chose: design doc only).

## 9. Open questions to resolve before/within the rebuild

1. **Planet representation in the unified git view** — show the clones as separate
   repos, or collapsed as one? (Likely moot if §7 collapse happens first.)
2. **"Primitive" = views or capabilities?** The §6 list is all *views* over existing data
   (cheap). If Ben wants new *capabilities* (time tracking, recurring tasks, new states),
   that's schema work worth a separate discussion.
3. **Repo home for the rebuild** — its own `cogyard/` repo.

## 10. Immediate next step

**Phase 0 — read-only WORKTREE view on the existing JS, when Ben says go.**
Reordered: worktree view is the headline (Ben's worst pain), commit log is secondary.
- `GET /worktrees?slug=X` → `git worktree list --porcelain` in `proj.path`, plus per worktree:
  ahead/behind `main` (`git rev-list --left-right --count`), dirty (`git status --porcelain`),
  staleness flag, and ports joined from `worktree-ports.json`.
- A panel in `viewer.js` rendering the worktree table with the staleness flags highlighted.
- (Then, secondary) `GET /commits?slug=X` → `git log`, with `[#NN]` parsed → commit↔task links.

Scope confirmed small by Ben: ahead/behind + staleness only, view-only, no actions.

### Phase 0 — BUILT (2026-06-05), verified live, not yet committed

Implemented on the existing JS portal (no rebuild yet):
- `tasks.mjs`: `WORKTREE_PORTS_PATH` const; helpers `loadPortAllocations`, `gitWorktrees`
  (porcelain parse), `computeWorktrees` (ahead/behind via `git rev-list --left-right
  --count base...branch`, dirty via per-worktree `git status --porcelain`, staleness +
  reasons, ports join), `worktreesForProject` (spans planet clones); `GET /worktrees?p=slug`
  endpoint.
- `viewer/index.html`: Tasks | Worktrees tab nav.
- `viewer/viewer.css`: `.view-tabs`, `.wt-table` + badge styles.
- `viewer/viewer.js`: `setView`, `renderWorktrees`, `buildWtTable`, `wtRow`,
  `refreshCurrentView`; refresh/focus/project-switch now respect the active view.

Verified live (puppeteer, port 7437 LaunchAgent restarted to load the endpoint):
- a sample project: 5 worktrees, 3 stale; `modest-kepler` (↑2 real work) correctly
  NOT flagged; `main` shows dirty ●3.
- a multi-clone project: 30 worktrees grouped across clones, 21 stale, ports shown,
  duplicate-commit detection fired (8b1ba27 pair).
- Tasks view unregressed (7 buckets, 77 rows, filters toggle correctly).

Committed to `main` as `c0cfe85` (per user: commit each phase, straight to main —
the `/merge-to-main` skill referenced in CLAUDE.md is not installed on this machine).

### Phase 0b — Commits panel (the documented secondary git view) — BUILT (2026-06-05)

The §6 "Git panel per project" item, cross-linked to tasks by `[#NN]`:
- `tasks.mjs`: `gitCommits` helper (unit-separator `git log`, parses `[#NN]` task tags);
  `GET /commits?p=slug&limit=N` endpoint (reads the primary clone's history).
- `viewer`: third tab `Commits`; `renderCommits` table (hash / subject with tags stripped
  / clickable `#id` task badges / author / relative date). Clicking a `#id` jumps to the
  Tasks view filtered to that id.
- Verified live (puppeteer): a multi-clone project shows 50 commits, 37 task-linked; clicking
  `#70` lands on task #70 in the Tasks view. (Fixed one bug mid-build: the jump searched
  `#70` but task search matches the bare id — corrected to search `70`.)
- Caveat logged: for planet projects the commit log reads only the primary clone's history.

### Phase 0c — Live cross-project dashboard — BUILT (2026-06-05)

Replaces the stale static `tasks-all.html` (last generated Apr 27) with a live view —
addresses pain #2 ("no cross-project view"):
- `tasks.mjs`: `lightWorktreeStats` (git-light: worktree count + stale via rev-list, NO
  per-worktree `status`), `projectOverview` (task counts + worktrees + dirty + latest
  commit), `GET /overview` (aggregates all registered projects).
- `viewer`: fourth tab `All Projects` (right-aligned); `renderOverview` table —
  Project (link → that project's Tasks) / Tasks (total · N ready · N claimed) /
  Worktrees (count + stale badge) / Dirty / Latest commit. Summary line aggregates
  ready tasks + stale worktrees across all repos.
- Verified live (puppeteer): 7 projects; surfaced a SECOND graveyard
  (one project: 10 worktrees, 9 stale); project-link jump works (another project → its
  Tasks view).
- **Perf:** first pass was 10s (sequential git + per-task `computeDerived` staleness).

### Phase 0d — Performance pass (2026-06-05)

User flagged: "if the page is super slow it won't be useful." Measured + fixed:
- Added async `gitP` (execFile, no shell) so per-repo/per-worktree git fans out via
  `Promise.all` instead of running sequentially.
- `/overview` no longer calls `loadProject` (which runs `computeDerived` → a `git log`
  PER TASK for the staleness check — the real culprit). Counts now come from frontmatter
  only via `taskCountsFromFrontmatter`. All projects scanned concurrently.
- `computeWorktrees` / `lightWorktreeStats` parallelized; `/worktrees` + `/overview`
  handlers are async.
- Result: `/overview` 10.0s → ~0.3s (34×); `/worktrees` planets 2.76s → ~0.38s (7×).
  Counts verified identical to the slow version.

### Phase 0e — Tasks page perf (pre-existing 5.3s) — FIXED (2026-06-05)

The main Tasks page ran a `git log` per task (computeDerived staleness) sequentially.
- `computeDerived` now accepts an optional precomputed `staleOverride`; with no override
  it keeps the original synchronous git path (CLI behavior byte-identical).
- New `computeStaleMap` prefetches every task's staleness in parallel; new
  `loadProjectAsync` feeds it into computeDerived. Server `/` and `/refresh` use it.
- Sync `loadProject` left untouched for the CLI (INDEX gen, analyze). Verified `analyze`
  still exits 0.
- Result: Tasks page 5.3s → ~1.2-1.8s. Stale count identical (49/77 on planets), all
  buckets render correctly.

### Out of scope (decided): git commit-graph / topology view

A SmartGit-style commit DAG (branch/merge lane rendering) is explicitly NOT planned. It's
the most expensive thing to build and is exactly where SmartGit (which Ben keeps) already
excels. The portal competes only where SmartGit is weak. A cheap `git log --graph` ASCII
dump in the Commits tab remains an option if ever wanted (~30 min), but is not planned.

### Three old-JS phases now shipped (0, 0b, 0c). Per D6, the next move is the Angular
rebuild — NOT more features on this portal. Open questions in §9 still need answers first.
