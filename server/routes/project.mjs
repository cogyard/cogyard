// routes/project.mjs — per-project task/worktree/graph views over core/.

import * as core from '../../core/index.mjs';
import { json } from '../http.mjs';
import { homedir } from 'node:os';
import { originHttpUrl } from '../git.mjs';

// The folder a Graph view reads, for the action bar's folder link (task 191):
// the absolute path plus a `~/…` form to print.
const folderOf = (p) => {
  const home = homedir();
  return { path: p, display: p.startsWith(home + '/') ? '~' + p.slice(home.length) : p };
};

export async function handle(path, u, proj, res) {
  // Task 170: how this project publishes — its .cogyard/publish.json, the
  // commit its /health serves against main's tip, the last release and what is
  // unreleased since, recent publishes, and the defaults a publish applies.
  // Read-only, for the project settings card. Publishing itself is the
  // owner's `cogyard publish` in a terminal; there is deliberately no POST.
  if (path === '/api/publish') return json(res, 200, await core.publishStatus(proj));
  if (path === '/api/tasks') {
    const { tasks, tasksDir } = await core.loadProjectAsync(proj.path);
    return json(res, 200, {
      slug: proj.slug, label: proj.label,
      tasks: core.annotateWorktree(core.tasksToData(tasks, tasksDir), proj),
      axes: core.resolveAxes(proj.path), // task 096: resolved shared+project label axes
    });
  }
  // Task 120: everything the nightly jobs left for this project, behind the
  // Daily tab (owner, 2026-08-20). The briefs were briefly pinned above the task
  // list, which made the page you WORK in carry something you only want when you
  // come BACK; drift (task 119) joins them here rather than getting a surface of
  // its own, because "what happened while I was away" and "what has gone stale
  // while I was away" are the same visit.
  //
  // Both are absent for most projects and the tab is hidden in that case, so
  // this is rarely called for an empty one. `drift` is null when there is no
  // report — and NO REPORT MEANS NO FINDINGS, never "nobody looked": the job
  // deletes the file on a clean pass (core/drift.mjs).
  if (path === '/api/daily') {
    const limit = Number(u.searchParams.get('limit')) || 30;
    return json(res, 200, {
      slug: proj.slug, label: proj.label,
      briefs: core.listBriefs(proj.slug, limit),
      drift: core.readDrift(proj.slug),
      // Task 134: which jobs looked at this project, and when. Once a quiet
      // night correctly writes nothing, an empty `briefs` means either "quiet"
      // or "nothing has been watching this for a week", and those must not
      // render the same. Empty for a project no job watches — the ordinary case.
      heartbeats: core.readHeartbeats(proj.slug),
    });
  }
  // Task 179: what's left, in the order it can run — lanes of tasks that edit
  // the same code, rows (1 = can start now), and the side groups. All derived in
  // core/plan.mjs; the registry is passed so cross-project deps resolve both ways.
  if (path === '/api/plan') {
    const plan = await core.planFor(proj, core.discoverProjects());
    // axes: the same resolved label axes /api/tasks sends, so the cards colour
    // their tags without a second fetch (task 227).
    return json(res, 200, { label: proj.label, ...plan, axes: core.resolveAxes(proj.path) });
  }
  // Task 198: the Plan tab's Recently done strip — the newest DONE tasks.
  if (path === '/api/recently-done') {
    return json(res, 200, { slug: proj.slug, tasks: await core.recentlyDone(proj) });
  }
  if (path === '/api/worktrees') {
    const worktrees = await core.worktreesForProject(proj);
    return json(res, 200, { slug: proj.slug, label: proj.label, worktrees });
  }
  // ?focus=<sha or ref> (task 175): also include that commit's history beyond
  // the newest-250 window, so a link to an old branch head lands on a real row.
  // Validated and resolved in core (resolveFocus); an unusable value is ignored
  // and the default window is served. Still a GET — nothing is written.
  // ?source=store (task 191): the project's TASK STORE instead of its code repo
  // — the store's commits with each one's rule flags (core/store-audit.mjs), a
  // pending row for its uncommitted files, and the store's own facts. The store
  // is resolved here from the slug, never taken from the client. &flagged=1
  // returns only the flagged commits of the last 30 days, not the newest-250
  // window. A project with no separate store is a 200 with `store: null`.
  // `link` (task 217) says why there is none — an in-repo folder, a broken
  // link, or no task directory — and `sharedWith` names any other project
  // reading the same store.
  if (path === '/api/graph' && u.searchParams.get('source') === 'store') {
    const flagged = u.searchParams.get('flagged') === '1';
    const link = core.storeLinkState(proj.path);
    const base = { slug: proj.slug, label: proj.label, source: 'store', flagged, link, sharedWith: [] };
    const dir = core.canonicalStore(proj.path);
    if (!dir) return json(res, 200, { ...base, originUrl: null, folder: null, store: null, rows: [], laneCount: 0, flaggedCount: 0, days: 30 });
    base.sharedWith = core.storeSharedWith(proj.slug, dir);
    const store = core.storeFacts(dir);
    // The store's own origin (a team store's remote) and folder — the same two
    // things the Code view's action bar shows for the code repo.
    base.originUrl = await originHttpUrl(dir);
    base.folder = folderOf(dir);
    // The flagged count labels the filter in both modes, so the scan always runs.
    const scan = await core.storeFlagged(dir, { days: 30, facts: store });
    const g = flagged ? scan : await core.storeGraph(dir, { facts: store });
    return json(res, 200, {
      ...base, store, rows: g.rows, laneCount: g.laneCount,
      flaggedCount: scan.flaggedCount, scanned: scan.scanned, hiddenAfter: scan.hiddenAfter, days: scan.days,
    });
  }
  if (path === '/api/graph') {
    const focus = u.searchParams.get('focus') || null;
    const [g, originUrl] = await Promise.all([core.gitDagWithStashesAndWorktrees(proj, 250, focus), originHttpUrl(proj.path)]);
    // A project naming its releases in publish.json (task 264): each tag ref
    // that is one of them comes with its release's label and version.
    const rows = core.labelReleaseTags(proj.path, g.rows);
    return json(res, 200, { slug: proj.slug, label: proj.label, originUrl, folder: folderOf(proj.path), ...g, rows });
  }
  return false;
}
