// routes/usage.mjs — token/cost usage endpoints. Read-only, like
// the entire /api surface. Data comes from the durable ledger in
// ~/.cogyard/usage/ — costs were locked in at collection time and are NEVER
// recomputed here.

import * as core from '../../core/index.mjs';
import { json, errJson, requireSameOrigin } from '../http.mjs';

// The one non-GET endpoint (via the http.mjs seam): the portal's
// usage-refresh button. Collection is idempotent (cursor-guarded), touches
// only ~/.cogyard/usage/, and never rewrites existing ledger rows.
export async function handlePost(path, req, res) {
  if (path !== '/api/usage/collect') return false;
  const originErr = requireSameOrigin(req);
  if (originErr) return errJson(res, 403, originErr);
  return json(res, 200, core.collectUsage());
}

export async function handle(path, u, projects, res) {
  if (path === '/api/usage') {
    return json(res, 200, { projects: core.usageRollup() });
  }
  let m = path.match(/^\/api\/usage\/project\/([^/]+)$/);
  if (m) {
    const slug = decodeURIComponent(m[1]);
    return json(res, 200, core.projectUsage(slug));
  }
  m = path.match(/^\/api\/usage\/task\/([^/]+)\/(\d+)$/);
  if (m) {
    return json(res, 200, core.taskUsage(decodeURIComponent(m[1]), Number(m[2])));
  }
  if (path.startsWith('/api/usage/')) return errJson(res, 404, 'not found: ' + path);
  return false;
}
