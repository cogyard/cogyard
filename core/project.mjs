// core/project.mjs — project loading (sync CLI path + async server path with
// parallel staleness prefetch), portal serialization, and INDEX.md generation.
// generateIndexMd / loadTasks feed _tasks/INDEX.md, which the bd-pickup-task
// skill and the /cogyard natural-language path READ directly. INDEX.md is
// consumed tooling, not portal display — do not retire it.

import { join, basename } from 'node:path';
import { gitP } from './exec.mjs';
import { loadTasks, computeDerived } from './frontmatter.mjs';
import { isClosed, bucketOf } from './status.mjs';

function loadProject(projectPath) {
  const tasksDir = join(projectPath, '_tasks');
  const tasks = loadTasks(tasksDir);
  for (const t of tasks) t.derived = computeDerived(t, tasks, projectPath);
  return { tasks, tasksDir, project: basename(projectPath) };
}

// Staleness only matters for tasks someone might still pick up — a closed task
// is allowed to have the world move past it. Skipping these also drops the ⚠
// from done rows in the portal (intended, task 8). "Closed" = DONE/ENOUGH/
// OBSOLETE, defined once in core/status.mjs.

// A task's stale verdict (`git log reviewed..HEAD -- paths`) can only change
// when the repo's HEAD moves or the task's frontmatter inputs change — both
// are in the cache key, so polling clients (7s portal auto-refresh) pay one
// `git rev-parse` per request and zero `git log`s between commits.
// repoRoot → { head, verdicts: Map<'reviewed|paths', boolean> }
const staleCache = new Map();
const STALE_GIT_POOL = 8;

// Prefetch the staleness git call for the tasks that need it — this is the slow
// part of computeDerived (one `git log` per task). Returns a Map<task, boolean>.
// Tasks without last_reviewed_at_commit/touches_paths, and DONE/OBSOLETE tasks,
// are absent (treated as not-stale by the caller).
async function computeStaleMap(tasks, repoRoot) {
  const map = new Map();
  if (!repoRoot) return map;
  const jobs = [];
  for (const task of tasks) {
    const fm = task.frontmatter || {};
    if (isClosed(fm.status)) continue;
    if (!(fm.last_reviewed_at_commit && Array.isArray(fm.touches_paths) && fm.touches_paths.length)) continue;
    const paths = fm.touches_paths.filter((p) => !p.startsWith('~/'));
    if (!paths.length) continue;
    jobs.push({ task, paths, reviewed: fm.last_reviewed_at_commit, key: `${fm.last_reviewed_at_commit}|${paths.join(',')}` });
  }
  if (!jobs.length) return map;
  const head = await gitP(['rev-parse', 'HEAD'], repoRoot);
  let cached = staleCache.get(repoRoot);
  if (!cached || cached.head !== head || head === null) cached = { head, verdicts: new Map() };
  staleCache.set(repoRoot, cached);
  // Bounded pool: 70 simultaneous `git log`s against one repo effectively
  // serialize anyway (~2s on a large repo); a small pool is just as fast after a
  // commit and avoids the process storm.
  const queue = jobs.filter((j) => !cached.verdicts.has(j.key));
  await Promise.all(Array.from({ length: Math.min(STALE_GIT_POOL, queue.length) }, async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      const out = await gitP(['log', '--oneline', `${j.reviewed}..HEAD`, '--', ...j.paths], repoRoot);
      const count = out ? out.split('\n').filter(Boolean).length : 0;
      cached.verdicts.set(j.key, count > 5);
    }
  }));
  for (const j of jobs) map.set(j.task, cached.verdicts.get(j.key) ?? false);
  return map;
}

// Async equivalent of loadProject for the server: staleness prefetched in
// parallel, then fed into computeDerived so no per-task git runs sequentially.
async function loadProjectAsync(projectPath) {
  const tasksDir = join(projectPath, '_tasks');
  const tasks = loadTasks(tasksDir);
  const staleMap = await computeStaleMap(tasks, projectPath);
  for (const t of tasks) t.derived = computeDerived(t, tasks, projectPath, staleMap.has(t) ? staleMap.get(t) : false);
  return { tasks, tasksDir, project: basename(projectPath) };
}
function tasksToData(tasks) {
  return tasks.map((t) => ({
    id: t.frontmatter?.id ?? null,
    title: t.frontmatter?.title || basename(t.path).replace(/\.md$/, ''),
    status: t.frontmatter?.status || 'UNKNOWN',
    file: basename(t.path),
    progress: t.derived || {},
    claimedAt: t.derived?.claimedAt,
    claimedBy: t.derived?.claimedBy,
    stale: !!t.derived?.stale,
    ready: !!t.derived?.ready,
    bucket: bucketOf(t.derived || {}, t.hasFrontmatter), // server-computed group (task 47); SPA consumes, never re-derives
    bodyMd: t.body || '',
    fm: t.frontmatter || {},
    hasFrontmatter: t.hasFrontmatter,
  }));
}

function generateIndexMd(tasks, project) {
  const lines = [`# Task index for ${project}`, '', `Generated ${new Date().toISOString()}`, ''];
  // Group via the shared SSOT (core/status.mjs bucketOf) — same categorization
  // the portal and the /api `bucket` field use, so INDEX.md never drifts from them.
  const buckets = { ready: [], inProgress: [], blocked: [], parked: [], stale: [], claimed: [], enough: [], done: [], obsolete: [], unknown: [] };
  for (const t of tasks) buckets[bucketOf(t.derived || {}, t.hasFrontmatter)].push(t);
  function row(t) {
    const fm = t.frontmatter || {};
    const id = fm.id || basename(t.path).split('-')[0];
    const title = fm.title || basename(t.path).replace(/^\d+[a-z]?-/, '').replace(/\.md$/, '');
    const file = basename(t.path);
    const progress = t.derived?.totalCount > 0 ? ` (${t.derived.checkedCount}/${t.derived.totalCount})` : '';
    const claim = t.derived?.claimed ? ` 🔒 ${t.derived.claimedBy || '?'}` : '';
    const stale = t.derived?.stale ? ' ⚠️ stale' : '';
    return `- **${id}** [${title}](${file})${progress}${claim}${stale}`;
  }
  function section(title, list) {
    if (!list.length) return;
    lines.push(`## ${title} (${list.length})`, '');
    for (const t of list.sort((a, b) => Number(a.frontmatter?.id || 0) - Number(b.frontmatter?.id || 0))) {
      lines.push(row(t));
    }
    lines.push('');
  }
  section('Ready to pick', buckets.ready);
  section('Claimed (in progress on another worktree)', buckets.claimed);
  section('In progress', buckets.inProgress);
  section('Blocked', buckets.blocked);
  section('Parked', buckets.parked);
  section('Stale review needed', buckets.stale);
  section('Enough (closed; leftovers harvestable)', buckets.enough);
  section('Done', buckets.done.slice(-10));
  section('Obsolete', buckets.obsolete);
  section('Unknown / pre-frontmatter (backfill candidates)', buckets.unknown);
  return lines.join('\n') + '\n';
}

export { loadProject, computeStaleMap, loadProjectAsync, tasksToData, generateIndexMd };
