// Task bucketing for the Tasks list and the task chips. The categorization
// itself ("which group does this task fall into") is a domain fact computed once
// server-side (core/status.mjs bucketOf) and served as `task.bucket` on
// /api/tasks — the SPA does NOT re-derive it. This file is pure presentation:
// each canonical bucket key's display word, and the status word a chip shows.
// (buildBuckets, the column grouping, went with the Board tab — task 179.)
//
// Four buckets, four questions (task 091): Ready (can I grab it), Claimed
// (who's on it — the Who column), Waiting (why not — the derived `waitingWhy`
// wire field), Done (how did it end — sub-grouped ENOUGH · DONE · OBSOLETE,
// visually separated from the active buckets above it).

// Canonical bucket keys, in display order. Mirrors core/status.mjs BUCKET_KEYS.
const BUCKET_KEY_ORDER = ['ready', 'claimed', 'waiting', 'done'];

// The DISPLAYED word. The `ready` key stays (it is the wire value); the word
// shown for it is "Idle" (task 154) — "Ready" read as "ready to clean up".
export const BUCKET_TITLES: Record<string, string> = {
  ready: 'Idle',
  claimed: 'Claimed',
  waiting: 'Waiting',
  done: 'Done',
};

// Pre-091 bucket keys, folded to their nearest new bucket — tolerance for stale
// data (e.g. a demo export produced before the rework), NOT a re-derivation:
// current servers only ever send the four keys above.
const LEGACY_KEY_FOLD: Record<string, string> = {
  inProgress: 'ready', stale: 'ready',
  blocked: 'waiting', parked: 'waiting', unknown: 'waiting',
  enough: 'done', obsolete: 'done',
};

// Bucket filter (replaces the old status filter — status only meaningfully
// split Done's sub-groups once the buckets became the grouping).
export const BUCKET_FILTERS = ['', ...BUCKET_KEY_ORDER];

// Task types — mirrors core/status.mjs TYPES (the wire contract:
// feature | maintenance | bug | docs). The icons are pure presentation — there
// is no icon font in this portal, so each type shows a glyph. (Was `category`
// until task 096; the wire `fm.type` is aliased from a legacy `category:` key
// server-side, so the SPA only ever reads `type`.)
export const TYPES = ['feature', 'maintenance', 'bug', 'docs'];
export const TYPE_ICONS: Record<string, string> = {
  feature: '⭐', maintenance: '🔧', bug: '🐞', docs: '📖',
};

export function bucketKeyOf(t: any): string {
  const b = t.bucket || 'waiting';
  return LEGACY_KEY_FOLD[b] || b;
}

// The SIX-way state a status WORD shows (task 155): the four buckets, with the
// closed bucket split back into the status that closed it. The #NN chip shows
// only the four buckets (one done grey); the word — app-task-chip show="status"
// on the Tasks tab — tells DONE, ENOUGH and OBSOLETE apart.
export type TaskState = 'ready' | 'claimed' | 'waiting' | 'done' | 'enough' | 'obsolete';
export function taskStateOf(t: any): TaskState {
  const b = bucketKeyOf(t);
  if (b !== 'done') return b as TaskState;
  const s = String(t.status || '').toLowerCase();
  return s === 'enough' || s === 'obsolete' ? s : 'done';
}
// The displayed word for a state (shown uppercase). `ready` shows as Idle.
export function taskStateWord(s: TaskState): string {
  return BUCKET_TITLES[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
}
