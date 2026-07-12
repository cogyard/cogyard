// Task bucketing for the Tasks list and the Board view. The categorization
// itself ("which group does this task fall into") is a domain fact computed once
// server-side (core/status.mjs bucketOf) and served as `task.bucket` on
// /api/tasks — the SPA does NOT re-derive it. This file is pure
// presentation: it maps each canonical bucket key to a display title and a
// column order, so the list and board can't diverge from each other or from the
// server's grouping.
//
// Four buckets, four questions (task 091): Ready (can I grab it), Claimed
// (who's on it — the Who column), Waiting (why not — the derived `waitingWhy`
// wire field), Done (how did it end — sub-grouped ENOUGH · DONE · OBSOLETE,
// visually separated from the active buckets above it).

// Canonical bucket keys, in display order. Mirrors core/status.mjs BUCKET_KEYS.
const BUCKET_KEY_ORDER = ['ready', 'claimed', 'waiting', 'done'];

const BUCKET_TITLES: Record<string, string> = {
  ready: 'Ready',
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

// Done sub-groups, in display order — the sub-group header IS the status.
const DONE_SUBGROUPS: { status: string; title: string }[] = [
  { status: 'ENOUGH', title: 'Enough' },
  { status: 'DONE', title: 'Done' },
  { status: 'OBSOLETE', title: 'Obsolete' },
];

// Bucket filter (replaces the old status filter — status only meaningfully
// split Done's sub-groups once the buckets became the grouping).
export const BUCKET_FILTERS = ['', ...BUCKET_KEY_ORDER];

// Task categories — mirrors core/status.mjs CATEGORIES (the wire
// contract: feature | maintenance | bug | docs). The icons are pure presentation
// — there is no icon font in this portal, so each category shows a glyph.
export const CATEGORIES = ['feature', 'maintenance', 'bug', 'docs'];
export const CATEGORY_ICONS: Record<string, string> = {
  feature: '✨', maintenance: '🔧', bug: '🐞', docs: '📖',
};

export interface BucketSub { title: string; list: any[]; }
export interface Bucket {
  key: string;                 // canonical bucket key — drives per-bucket columns
  title: string;
  list: any[];                 // every task in the bucket (done: all sub-groups, in sub-group order)
  subs: BucketSub[] | null;    // done only: non-empty ENOUGH · DONE · OBSOLETE groups
  separatorAbove: boolean;     // done only: the visual line dividing closed lifecycle from active
}

const byId = (a: any, c: any) =>
  String(a.id ?? '').localeCompare(String(c.id ?? ''), undefined, { numeric: true });

export function bucketKeyOf(t: any): string {
  const b = t.bucket || 'waiting';
  return LEGACY_KEY_FOLD[b] || b;
}

// Group tasks by their server-computed `bucket` key, in BUCKET_KEY_ORDER, each
// list sorted by id (numeric). The done bucket carries its status sub-groups.
export function buildBuckets(tasks: any[]): Bucket[] {
  const map = new Map<string, any[]>();
  for (const t of tasks) { const b = bucketKeyOf(t); if (!map.has(b)) map.set(b, []); map.get(b)!.push(t); }
  return BUCKET_KEY_ORDER.filter((b) => map.has(b)).map((b) => {
    const list = map.get(b)!.sort(byId);
    if (b !== 'done') return { key: b, title: BUCKET_TITLES[b], list, subs: null, separatorAbove: false };
    const subs = DONE_SUBGROUPS
      .map((g) => ({ title: g.title, list: list.filter((t) => t.status === g.status) }))
      .filter((g) => g.list.length);
    // Closed rows whose status matches no sub-group (shouldn't happen) still render.
    const leftovers = list.filter((t) => !DONE_SUBGROUPS.some((g) => g.status === t.status));
    if (leftovers.length) subs.push({ title: 'Closed', list: leftovers });
    return { key: b, title: BUCKET_TITLES[b], list: subs.flatMap((s) => s.list), subs, separatorAbove: true };
  });
}
