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

// Task type — a required, closed enum orthogonal to status. Status
// is lifecycle ("is it finished"); type is kind ("what sort of work"). A bug
// is `type: bug` regardless of size — size is not the axis, kind is.
// (Was `category` until task 096 — renamed to free `category` up as the word for
// the axis-grouping story; the legacy `category:` key still parses, aliased to
// `type` at the frontmatter parse boundary in core/frontmatter.mjs.)
//   feature     — new capability / view / user-facing behavior
//   maintenance — internal work, no new user-facing behavior: restructures, renames,
//                 releases, dependency bumps, ops/infra housekeeping (the former
//                 `refactor` + `chore`, merged — the line between them was pure
//                 boundary debate and earned nothing as a task filter)
//   bug         — something is broken
//   docs        — documentation, marketing, launch copy — non-code work
// Deliberately tight (4 values — also fits the write-task AskUserQuestion 4-option
// cap exactly). Do NOT add values without owner sign-off; finer grain (e.g. perf,
// deps, a specific refactor) is a `label`, the open axis — not a new type.
export const TYPES = ['feature', 'maintenance', 'bug', 'docs'];
export const isValidType = (t) => TYPES.includes(t);

// Owner steps (task 179) — a checkbox only the OWNER can do is marked at the
// start of its text: `- [ ] (you: credential) Log in to …`. The need lives on
// the step, so it clears when the box is ticked (core/frontmatter.mjs
// checkboxSteps). A task with no marked box needs nothing from the owner but the
// usual sign-off at merge — which is why there is no `review` kind: every task
// has that, and a "built, waiting on your look" task is its own Plan group.
// The kinds are the steps an autopilot run stops before (the autopilot skill's
// eligibility rule):
//   decision   — choose something the task can't settle
//   credential — a login, token, account or secret only the owner holds
//   purchase   — money must be spent
// `device` (a check on real hardware) is still READ, so older files validate
// unchanged, but no longer offered (task 236): it was written as "the owner
// looks at it on their phone" at the end of nearly every task, and the owner's
// "merge it" already is that look — `/merge-to-main` ticks any open owner box
// as reviewed. New files get only the three kinds above.
// (Replaced a task-level `needs_owner` field before it shipped: a field goes
// stale once the step is done, and is right for the whole task or not at all.)
export const OWNER_STEP_KINDS = ['decision', 'credential', 'purchase'];
const LEGACY_OWNER_STEP_KINDS = ['device'];
export const isOwnerStepKind = (v) => OWNER_STEP_KINDS.includes(v) || LEGACY_OWNER_STEP_KINDS.includes(v);

// Settled boxes (task 171) — an unticked box that was decided rather than done
// carries a marker at the start of its text, the same shape as an owner step:
//   - [ ] (dropped: push not now) Watchers inside the portal process
//   - [ ] (moved: 050) Create the fresh repo         (another project: slug#id)
//   - [ ] (optional) Icons in the hidden-tabs list
// A box whose text opens with ~~strikethrough~~ reads as `dropped` with no reason.
// `blocksDone` is what `cogyard tasks close` asks: dropped/moved are settled, so
// they don't stop a plain close; optional is a leftover — the task closes as
// ENOUGH ("shipped enough, leftovers recorded"), not DONE. DONE means there is
// nothing left to see in the task (owner, 2026-10-21, task 238).
// (Before this, 136 of 508 DONE tasks across every store had unticked boxes,
// most settled in prose four different ways — "→ MOVED to task 050",
// "Deferred (owner's call)", "OBSOLETE (…)", "Optional:" — none machine-readable.)
export const SETTLED_KINDS = {
  dropped:  { blocksDone: false },
  moved:    { blocksDone: false, needsTarget: true },
  optional: { blocksDone: true },
};
export const SETTLED_KIND_NAMES = Object.keys(SETTLED_KINDS);

// Retired marker words, and what to write instead (validate warns on each).
// `deferred` — "still wanted, no task holds it" — was retired by the owner in
// task 238: a box still wanted gets a task and is (moved: <id>); one that isn't
// is (optional), left behind in an ENOUGH task. No file used it at retirement.
export const RETIRED_SETTLED_KINDS = {
  deferred: 'write (optional) to leave it behind (the task closes as ENOUGH), or file a task and write (moved: <id>)',
};

// After-merge checks (task 232) — a box the AGENT does, but only once the
// branch is on main (cogyard's own hooks, for one, run the main checkout's
// code, so a change to them can't be seen live from a worktree):
//   - [ ] (after merge) The card reads "idle" on the real portal
// Neither an owner step nor settled: it still blocks a close until ticked.
// `/merge-to-main` runs these between pushing main and closing, and `close`
// lists them apart from other open boxes, so its refusal says "run these" and
// not "the owner must choose". The words are fixed; a near-miss is a validator
// error (task 238).
export const AFTER_MERGE_MARK_RE = /^\(after merge\)\s*/i;
export const AFTER_MERGE_NEAR_RE = /^\((?:after|post)[\s_-]*merge[sd]?\)/i;
export const isSettledKind = (v) => Object.prototype.hasOwnProperty.call(SETTLED_KINDS, v);

// What counts as a ticked box. Agents tick with many marks; anything plausibly
// "checked" counts, and unchecked is strictly `[ ]`. The one copy — the
// dashboard count, the box list and analyze's backfill all read this.
export const CHECKED_MARK_RE = /^(?:[xX]|✓|✔|✅|☑|☒|🗸|✗|✘|done|y|Y|yes|YES)$/;

// Blank every line inside a fenced code block (``` or ~~~), keeping the line
// count. A box shown as an EXAMPLE in a code block is not a box — every reader
// of boxes (checkboxSteps, the validator's marker checks) runs on this first.
export function blankCodeBlocks(text) {
  let fence = null;
  return String(text || '').split('\n').map((line) => {
    const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return '';
    }
    if (m) { fence = m[1]; return ''; }
    return line;
  }).join('\n');
}

export const isValidStatus = (s) => Object.prototype.hasOwnProperty.call(STATUS, s);
export const isClosed = (s) => !!(STATUS[s] && !STATUS[s].open);
export const isOpen = (s) => !!(STATUS[s] && STATUS[s].open);
export const satisfiesDeps = (s) => !!(STATUS[s] && STATUS[s].satisfiesDeps);
export const hasDoneDate = (s) => !!(STATUS[s] && STATUS[s].doneDate);

// Bucketing — the single source of truth for "which group does this task fall
// into" (the Tasks list groups and the task chips' colours). Was duplicated in
// core/project.mjs (the INDEX.md generator, removed by task 190) and the SPA
// (frontend task-buckets.ts); the SPA now derives from this one function so a chip
// colour and a list bucket with the same title can never disagree about a task
// (boundary correctness). The canonical KEYS live here; each consumer
// maps a key to its own display title + ordering (that part is presentation).
//
// Four buckets, four questions (task 091):
//   ready   — can I grab it?   OPEN, unclaimed, deps met. Progress (3/7) and
//             staleness are row-level signals inside Ready, not piles.
//   claimed — who's on it?     open + claim held (incl. finished-awaiting-merge).
//   waiting — why not?         PARKED · unmet deps · unknown status ·
//             pre-frontmatter. The "why" is waitingWhyOf() below.
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
  return 'waiting';                               // PARKED · unmet deps · unknown status
}

// The Waiting bucket's "why" — DERIVED, never stored, so it can't go stale:
// `waiting on #N` self-clears the moment task N closes; `parked` and
// `needs frontmatter` wait on a human. Null for every other bucket.
export function waitingWhyOf(d, hasFrontmatter) {
  if (bucketOf(d, hasFrontmatter) !== 'waiting') return null;
  if (!hasFrontmatter) return 'needs frontmatter';
  const s = d?.status;
  if (s === 'PARKED') return 'parked';
  // A cross-project dep already reads `<slug>#<id>`; a local one gets its `#`.
  if (d?.unmetDeps?.length) return 'waiting on ' + d.unmetDeps.map((n) => (String(n).includes('#') ? String(n) : `#${n}`)).join(', ');
  return 'needs frontmatter';                     // unknown/invalid status — a human must fix the file
}
