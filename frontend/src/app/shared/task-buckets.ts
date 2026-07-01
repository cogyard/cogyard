// Task bucketing for the Tasks list and the Board view. The categorization
// itself ("which group does this task fall into") is a domain fact computed once
// server-side (core/status.mjs bucketOf) and served as `task.bucket` on
// /api/tasks — the SPA does NOT re-derive it (task 47). This file is pure
// presentation: it maps each canonical bucket key to a display title and a
// column order, so the list and board can't diverge from each other or from the
// server's grouping.

// Canonical bucket keys, in display order. Mirrors core/status.mjs BUCKET_KEYS;
// the keys are the wire contract, the titles below are ours to render.
const BUCKET_KEY_ORDER = [
  'ready', 'claimed', 'inProgress', 'blocked', 'parked', 'stale', 'enough', 'done', 'obsolete', 'unknown',
];

const BUCKET_TITLES: Record<string, string> = {
  ready: 'Ready to pick',
  claimed: 'Claimed (on another worktree)',
  inProgress: 'In progress',
  blocked: 'Blocked',
  parked: 'Parked',
  stale: 'Stale review needed',
  enough: 'Enough',
  done: 'Done',
  obsolete: 'Obsolete',
  unknown: 'Unknown / pre-frontmatter',
};

export const STATUSES = ['', 'OPEN', 'PARKED', 'BLOCKED_ON', 'ENOUGH', 'DONE', 'OBSOLETE', 'UNKNOWN'];

// Task categories (task 39) — mirrors core/status.mjs CATEGORIES (the wire
// contract: feature | maintenance | bug | docs). The icons are pure presentation
// — there is no icon font in this portal, so each category shows a glyph.
export const CATEGORIES = ['feature', 'maintenance', 'bug', 'docs'];
export const CATEGORY_ICONS: Record<string, string> = {
  feature: '✨', maintenance: '🔧', bug: '🐞', docs: '📖',
};

export interface Bucket { title: string; list: any[]; }

// Group tasks by their server-computed `bucket` key, in BUCKET_KEY_ORDER, each
// list sorted by id (numeric).
export function buildBuckets(tasks: any[]): Bucket[] {
  const map = new Map<string, any[]>();
  for (const t of tasks) { const b = t.bucket || 'unknown'; if (!map.has(b)) map.set(b, []); map.get(b)!.push(t); }
  return BUCKET_KEY_ORDER.filter((b) => map.has(b)).map((b) => ({
    title: BUCKET_TITLES[b] || b,
    list: map.get(b)!.sort((a, c) => String(a.id ?? '').localeCompare(String(c.id ?? ''), undefined, { numeric: true })),
  }));
}
