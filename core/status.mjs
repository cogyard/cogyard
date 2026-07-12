// core/status.mjs — single source of truth for task status semantics. Pure leaf
// (imports nothing from core/), so every consumer can import it without cycles.
//
// Before this module, "which statuses are closed" / "which satisfy deps" /
// "which carry a done_date" were written out by hand in frontmatter.mjs,
// project.mjs, overview.mjs, and analyze.mjs — and they drifted. Now those facts
// live here once; the GitHub bridge (CLI/add-on) builds its projection on top of
// these neutral predicates (core stays service-agnostic — no GitHub here).
//
// Each status declares only what differs from the default (open, non-satisfying,
// no done_date):
//   open          — active backlog; not yet closed.
//   satisfiesDeps — a dependent task may proceed once this one reaches the state.
//   doneDate      — this state represents finished work, so it carries done_date.
export const STATUS = {
  OPEN:       { open: true },
  PARKED:     { open: true },
  DONE:       { open: false, satisfiesDeps: true, doneDate: true },
  ENOUGH:     { open: false, satisfiesDeps: true, doneDate: true }, // shipped enough value; leftovers don't block dependents
  OBSOLETE:   { open: false },                                       // closed but abandoned — does NOT satisfy deps, no done_date
};

// The valid status vocabulary.
export const STATUSES = Object.keys(STATUS);

// Deprecation shim (task 091): `BLOCKED_ON` is retired — it hand-copied what the
// dep graph already derives. Blocked on a task → `depends_on` + stay OPEN
// (derived, self-clears when the dep closes). Blocked on something external →
// `PARKED` (a deliberate hold, whatever the reason). Legacy files still parse:
// the validator warns (never errors) and bucketOf lands them in `waiting`.
export const LEGACY_STATUSES = ['BLOCKED_ON'];
export const isLegacyStatus = (s) => LEGACY_STATUSES.includes(s);

// Task category — a required, closed enum orthogonal to status. Status
// is lifecycle ("is it finished"); category is kind ("what sort of work"). A bug
// is `category: bug` regardless of size — size is not the axis, kind is.
//   feature     — new capability / view / user-facing behavior
//   maintenance — internal work, no new user-facing behavior: restructures, renames,
//                 releases, dependency bumps, ops/infra housekeeping (the former
//                 `refactor` + `chore`, merged — the line between them was pure
//                 boundary debate and earned nothing as a task filter)
//   bug         — something is broken
//   docs        — documentation, marketing, launch copy — non-code work
// Deliberately tight (4 values — also fits the write-task AskUserQuestion 4-option
// cap exactly). Do NOT add values without owner sign-off; finer grain (e.g. perf,
// deps, a specific refactor) is a `label`, the open axis — not a new category.
export const CATEGORIES = ['feature', 'maintenance', 'bug', 'docs'];
export const isValidCategory = (c) => CATEGORIES.includes(c);

export const isValidStatus = (s) => Object.prototype.hasOwnProperty.call(STATUS, s);
export const isClosed = (s) => !!(STATUS[s] && !STATUS[s].open);
export const isOpen = (s) => !!(STATUS[s] && STATUS[s].open);
export const satisfiesDeps = (s) => !!(STATUS[s] && STATUS[s].satisfiesDeps);
export const hasDoneDate = (s) => !!(STATUS[s] && STATUS[s].doneDate);

// Bucketing — the single source of truth for "which group does this task fall
// into" (the dashboard board columns, the Tasks list groups, and INDEX.md
// sections). Was duplicated in core/project.mjs (generateIndexMd) and the SPA
// (frontend task-buckets.ts); both now derive from this one function so a board
// column and a list bucket with the same title can never hold different tasks
// (boundary correctness). The canonical KEYS live here; each consumer
// maps a key to its own display title + ordering (that part is presentation).
//
// Four buckets, four questions (task 091):
//   ready   — can I grab it?   OPEN, unclaimed, deps met. Progress (3/7) and
//             staleness are row-level signals inside Ready, not piles.
//   claimed — who's on it?     open + claim held (incl. finished-awaiting-merge).
//   waiting — why not?         PARKED · unmet deps · unknown/pre-frontmatter/
//             legacy status. The "why" is waitingWhyOf() below.
//   done    — how did it end?  closed lifecycle (DONE | ENOUGH | OBSOLETE);
//             consumers sub-group by the status the row carries.
export const BUCKET_KEYS = ['ready', 'claimed', 'waiting', 'done'];

// `d` is a task's computeDerived() result (status, claimed, depsMet, ready,
// checkedCount, totalCount, stale). `hasFrontmatter` is the task-level flag.
// Order of the checks is significant — the first match wins.
export function bucketOf(d, hasFrontmatter) {
  if (!hasFrontmatter) return 'waiting';          // pre-frontmatter — needs a human before it's grabbable
  const s = d?.status;
  if (isClosed(s)) return 'done';                 // done-family; status rides along for sub-grouping
  if (d.claimed) return 'claimed';
  if (s === 'OPEN' && d.depsMet) return 'ready';
  return 'waiting';                               // PARKED · unmet deps · unknown/legacy status
}

// The Waiting bucket's "why" — DERIVED, never stored, so it can't go stale:
// `waiting on #N` self-clears the moment task N closes; `parked` and
// `needs frontmatter` wait on a human. Null for every other bucket.
export function waitingWhyOf(d, hasFrontmatter) {
  if (bucketOf(d, hasFrontmatter) !== 'waiting') return null;
  if (!hasFrontmatter) return 'needs frontmatter';
  const s = d?.status;
  if (s === 'PARKED') return 'parked';
  if (d?.unmetDeps?.length) return 'waiting on ' + d.unmetDeps.map((n) => `#${n}`).join(', ');
  if (isLegacyStatus(s)) return 'parked';         // legacy BLOCKED_ON with no unmet dep = a deliberate hold
  return 'needs frontmatter';                     // unknown/invalid status — a human must fix the file
}
