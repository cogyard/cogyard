// routes/reclaim.mjs — the Cleanup surface's read endpoint (task 117).
//
// GET /api/reclaim  → every registered project's reclaimable state: disposable
// dir sizes joined to the sessions-audit verdict, per worktree.
//
// Read-only. All computation is core/reclaim.mjs — this file resolves query
// params and serialises, per the repo invariant that server/ owns no data
// logic.
//
// `?sizes=0` skips the `du`/`find` walk. That walk is the expensive half (a du
// per disposable dir across every project takes seconds on a real backlog), so
// a caller that only wants verdicts and counts can opt out of it.

import * as core from '../../core/index.mjs';
import { json } from '../http.mjs';

export async function handle(path, u, projects, res) {
  if (path !== '/api/reclaim') return false;

  const slug = u.searchParams.get('p');
  // Default ON: the sizes are the whole point of the surface. Only an explicit
  // 0/false opts out, so a typo'd value doesn't silently blank the numbers.
  const raw = u.searchParams.get('sizes');
  const sizes = !(raw === '0' || raw === 'false');

  const report = await core.reclaimReport({ slug, sizes });
  return json(res, 200, report);
}
