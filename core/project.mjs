// core/project.mjs — project loading (sync CLI path + async server path with
// parallel staleness prefetch) and portal serialization. (It also generated the
// store's INDEX.md until task 190 removed that file: nothing read it, and it
// put a generated file in every store commit.)

import { join, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { gitP } from './exec.mjs';
import { loadTasks, computeDerived } from './frontmatter.mjs';
import { isClosed, bucketOf, waitingWhyOf } from './status.mjs';
import { tasksDirOf } from './tasks-dir.mjs';
import { liveForTask, claimedByOther, cachedUser } from './live-state.mjs';
import { whoAmI } from './close.mjs';
import { validateTasks } from './validate.mjs';

function loadProject(projectPath) {
  const tasksDir = tasksDirOf(projectPath);
  const tasks = loadTasks(tasksDir);
  for (const t of tasks) t.derived = computeDerived(t, tasks, projectPath);
  return { tasks, tasksDir, project: basename(projectPath) };
}

// Staleness only matters for tasks someone might still pick up — a closed task
// is allowed to have the world move past it. Skipping these also drops the ⚠
// from done rows in the portal (intended). "Closed" = DONE/ENOUGH/
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
  const tasksDir = tasksDirOf(projectPath);
  const tasks = loadTasks(tasksDir);
  const staleMap = await computeStaleMap(tasks, projectPath);
  for (const t of tasks) t.derived = computeDerived(t, tasks, projectPath, staleMap.has(t) ? staleMap.get(t) : false);
  return { tasks, tasksDir, project: basename(projectPath) };
}
// `storePath` resolves the task-store link (.cogyard/tasks or _tasks) ONCE per project, not per file: for a
// shared-store project every task lives in the same store, and realpath-ing each
// of a few hundred files to learn the same answer is waste. Null when the caller
// doesn't pass a tasks dir, or when it can't be resolved — a missing provenance
// line is a fine degradation, a crashed task list is not.
function resolveStorePath(tasksDir) {
  if (!tasksDir) return null;
  try { return realpathSync(tasksDir); } catch { return null; }
}

// tasksDir is optional so existing callers keep working; pass it to get the
// file-provenance fields (task 132 — where each task file actually lives, which
// nothing in the portal could say while `file` was a bare basename).
function tasksToData(tasks, tasksDir) {
  const storePath = resolveStorePath(tasksDir);
  const user = cachedUser(whoAmI);
  // Each task's schema errors (task 217) — the check `cogyard tasks validate`
  // runs, over the whole project so duplicate ids and dangling deps count.
  // Errors only: warnings are soft by design (older files predate fields).
  const { results } = validateTasks(tasks);
  return tasks.map((t, i) => ({
    id: t.frontmatter?.id ?? null,
    title: t.frontmatter?.title || basename(t.path).replace(/\.md$/, ''),
    status: t.frontmatter?.status || 'UNKNOWN',
    file: basename(t.path),
    // `file` stays the basename — it is the row key the whole tasks view tracks
    // by. Provenance rides alongside it: filePath is where the file REALLY is
    // (through the store, symlink resolved), storePath the store holding it.
    filePath: storePath ? join(storePath, basename(t.path)) : null,
    storePath,
    progress: t.derived || {},
    claimedAt: t.derived?.claimedAt,
    claimedBy: t.derived?.claimedBy,
    claimedByName: t.derived?.claimedByName,
    // What the agent on it is doing right now (task 202) — only on this
    // machine's own claims; someone else's claim shows their name instead.
    live: liveForTask(t.frontmatter, { user }),
    claimedByOther: claimedByOther(t.frontmatter, user),
    stale: !!t.derived?.stale,
    ready: !!t.derived?.ready,
    bucket: bucketOf(t.derived || {}, t.hasFrontmatter), // server-computed group; SPA consumes, never re-derives
    waitingWhy: waitingWhyOf(t.derived || {}, t.hasFrontmatter), // derived "why" for the Waiting bucket; null elsewhere
    bodyMd: t.body || '',
    fm: t.frontmatter || {},
    hasFrontmatter: t.hasFrontmatter,
    schemaErrors: results[i].errors,
  }));
}

export { loadProject, computeStaleMap, loadProjectAsync, tasksToData };
