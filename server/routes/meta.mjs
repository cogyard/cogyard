// routes/meta.mjs — cross-project endpoints: health, project list, overview.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../../core/index.mjs';
import { json } from '../http.mjs';

// Per-project count of tasks with a live claim (env.claimed_at set) — the sidebar
// + dock badge signal (task 85: "which project has work in flight right now",
// replacing the old unmerged-worktree count). File-read only via loadTasks; no
// git, so it's as cheap to poll as projectUnmerged's stat-cached count. `unmerged`
// stays on the payload below — the Branches/overview views still read it.
function projectClaimed(proj) {
  try { return core.taskCountsFromFrontmatter(core.loadTasks(join(proj.path, '_tasks'))).claimed; }
  catch { return 0; }
}

// The RUNNING server's own version + commit (computed here, in the server's layer —
// not read from a frontend build artifact). Stamped once at boot: the short SHA
// bd-verify-deploy polls /health for until it matches local HEAD, and the ROOT
// package.json release counter. (The SPA footer is build-stamped separately via
// frontend/src/version.json — see scripts/generate-version.mjs.)
export const COMMIT = core.tryExec('git rev-parse --short HEAD', { cwd: new URL('../..', import.meta.url).pathname }) || null;
export const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || null; }
  catch { return null; }
})();

export async function handle(path, u, projects, res) {
  if (path === '/api/health') return json(res, 200, { ok: true, commit: COMMIT, version: VERSION, projects: projects.length });
  if (path === '/api/projects') return json(res, 200,
    await Promise.all(projects.map(async (p) => ({ slug: p.slug, label: p.label, claimed: projectClaimed(p), unmerged: await core.projectUnmerged(p) }))));
  // The editable "Open in" target list — id + label only; the
  // command (exec/args) stays server-side, the client just renders the menu.
  if (path === '/api/open-targets') return json(res, 200, core.openTargets().map((t) => ({ id: t.id, label: t.label })));
  if (path === '/api/overview') {
    const rows = await Promise.all(projects.map((p) => core.projectOverview(p).catch(() => ({ slug: p.slug, label: p.label, error: true }))));
    return json(res, 200, { projects: rows });
  }
  return false;
}
