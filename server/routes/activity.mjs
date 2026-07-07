// routes/activity.mjs — activity-view endpoints. Read-only GETs,
// like the rest of the /api surface: commits-per-day per project (git), plus
// the attention/cost rollup and the single-day drill-down (core/activity.mjs).

import * as core from '../../core/index.mjs';
import { json, errJson } from '../http.mjs';

export async function handle(path, u, projects, res) {
  if (path === '/api/activity') {
    const days = Math.min(Math.max(Number(u.searchParams.get('days')) || 366, 1), 731);
    const commits = {};
    const merges = {};
    await Promise.all(projects.map(async (p) => {
      commits[p.slug] = await core.commitsPerDay(p, days);
      merges[p.slug] = await core.mergesPerDay(p, days);
    }));
    return json(res, 200, { days, commits, merges, punchcards: core.activityPunchcard(), ...core.activityRollup(days) });
  }
  const m = path.match(/^\/api\/activity\/day\/(\d{4}-\d{2}-\d{2})$/);
  if (m) return json(res, 200, core.activityDay(m[1]));
  if (path.startsWith('/api/activity/')) return errJson(res, 404, 'not found: ' + path);
  return false;
}
