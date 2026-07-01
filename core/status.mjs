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
  BLOCKED_ON: { open: true },
  DONE:       { open: false, satisfiesDeps: true, doneDate: true },
  ENOUGH:     { open: false, satisfiesDeps: true, doneDate: true }, // shipped enough value; leftovers don't block dependents
  OBSOLETE:   { open: false },                                       // closed but abandoned — does NOT satisfy deps, no done_date
};

// The valid status vocabulary.
export const STATUSES = Object.keys(STATUS);

// Task category — a required, closed enum orthogonal to status (task 39). Status
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
// (task 47 — boundary correctness). The canonical KEYS live here; each consumer
// maps a key to its own display title + ordering (that part is presentation).
export const BUCKET_KEYS = [
  'ready', 'claimed', 'inProgress', 'blocked', 'parked', 'stale', 'enough', 'done', 'obsolete', 'unknown',
];

// `d` is a task's computeDerived() result (status, claimed, depsMet, ready,
// checkedCount, totalCount, stale). `hasFrontmatter` is the task-level flag.
// Order of the checks is significant — the first match wins.
export function bucketOf(d, hasFrontmatter) {
  if (!hasFrontmatter) return 'unknown';
  const s = d?.status;
  if (s === 'DONE') return 'done';
  if (s === 'ENOUGH') return 'enough';            // closed/done-family — its own group, not active backlog
  if (s === 'OBSOLETE') return 'obsolete';
  if (d.claimed) return 'claimed';
  if (s === 'PARKED') return 'parked';
  if (s === 'BLOCKED_ON' || !d.depsMet) return 'blocked';
  if (d.ready) return 'ready';
  if (d.checkedCount > 0 && d.totalCount > d.checkedCount) return 'inProgress';
  if (d.stale) return 'stale';
  return 'inProgress';
}
