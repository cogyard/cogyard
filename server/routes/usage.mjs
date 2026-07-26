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
  // Task → chats (task 30): the chats that created/implemented/mentioned a task,
  // ledger-sourced so it survives archiving + worktree removal. Lazy per-task
  // (the created-side spawns git), loaded when a row expands — not folded into
  // the bulk projectUsage. Read-only, like everything else on this surface.
  m = path.match(/^\/api\/usage\/task\/([^/]+)\/(\d+)\/chats$/);
  if (m) {
    return json(res, 200, core.chatsForTask(decodeURIComponent(m[1]), Number(m[2])));
  }
  // One chat's readable transcript (task 30 follow-up — the in-portal viewer).
  // Read-only. The sessionId is used to glob the transcript dir for
  // <id>.jsonl, so it MUST be a bare session id — reject anything with a slash,
  // dot, or other path character to keep it inside the transcript root.
  m = path.match(/^\/api\/usage\/chat\/([^/]+)\/transcript$/);
  if (m) {
    const sid = decodeURIComponent(m[1]);
    if (!/^[a-zA-Z0-9-]+$/.test(sid)) return errJson(res, 400, 'bad session id');
    return json(res, 200, core.transcriptForChat(sid));
  }
  if (path.startsWith('/api/usage/')) return errJson(res, 404, 'not found: ' + path);
  return false;
}
