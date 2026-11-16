// routes/storage.mjs — one project's task-storage report (tasks 132, 135).
//
// GET /api/storage?p=<slug> → { rows, drift, home } from core/store-health.mjs,
// the same report `cogyard tasks doctor` prints, for that project alone: where
// its code and its task store actually live and whether that storage is
// healthy. The project settings tab's Location on disk reads it.
//
// Without `p` it is a 400 (task 217). The unfiltered, every-project form fed a
// table on the global /settings page; that table is gone, its facts moved to
// the tabs they describe (Worktrees, the git Graph's Task store view, Tasks),
// and the full cross-project report stays a terminal command.
//
// Registered with the cross-project handlers, ahead of the per-project
// resolution, and reads its own `p` (the way routes/axes.mjs does) — so an
// unknown slug is this route's own 404 rather than the shared one.

import * as core from '../../core/index.mjs';
import { json, errJson } from '../http.mjs';

export async function handle(path, u, projects, res) {
  if (path !== '/api/storage') return false;
  const slug = u.searchParams.get('p');
  if (!slug) return errJson(res, 400, 'p=<project slug> is required');
  const proj = projects.find((p) => p.slug === slug);
  if (!proj) return errJson(res, 404, 'unknown project: ' + slug);
  return json(res, 200, core.storeHealth({ onlyPaths: [proj.path] }));
}
