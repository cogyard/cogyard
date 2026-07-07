// routes/addons.mjs — the add-on surface.
//
// GET  /api/addons                 discovered catalog: wire-safe manifests +
//                                  machine prereq results + invalid installs
// POST /api/addons/:id/:action     run ONE action through the write seam —
//                                  'safe' executes server-side, 'manual' only
//                                  returns the copy-paste command (core enforces)
//
// Add-ons are MACHINE-LEVEL (they extend cogyard itself, not a project), so
// there is no project parameter anywhere on this surface. An add-on that
// targets a project declares a `type: 'project'` config field; the chosen slug
// travels inside the POST body's cfg like any other value.
//
// Thin adapter: all contract/loader/tier logic lives in core/addons/. The POST
// goes through the SAME requireSameOrigin + readBody seam as every other write
// (routes/config.mjs, routes/projects.mjs) — no new write path.

import * as core from '../../core/index.mjs';
import { json, errJson, requireSameOrigin, readBody } from '../http.mjs';

// GET handlers. Return false for any other path so the router falls through.
export async function handle(path, u, projects, res) {
  if (path === '/api/addons') {
    return json(res, 200, await core.listAddons());
  }
  if (path === '/api/addons/status') {
    return json(res, 200, { statuses: await core.addonStatuses() });
  }
  return false;
}

// POST /api/addons/:id/:action. Body = the card's config values. Returns false
// for any other path.
export async function handlePost(path, req, res) {
  const m = path.match(/^\/api\/addons\/([\w.-]+)\/([\w.-]+)$/);
  if (!m) return false;

  const originErr = requireSameOrigin(req);
  if (originErr) return errJson(res, 403, originErr);

  let cfg;
  try { cfg = JSON.parse((await readBody(req)) || '{}'); }
  catch { return errJson(res, 400, 'invalid JSON body'); }

  try {
    return json(res, 200, await core.runAddonAction(m[1], m[2], cfg));
  } catch (e) {
    return errJson(res, 400, String((e && e.message) || e));
  }
}
