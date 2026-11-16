// routes/addons.mjs — the add-on surface.
//
// GET  /api/addons                 discovered catalog: wire-safe manifests +
//                                  machine prereq results + invalid installs
// POST /api/addons/:id/config      persist the add-on's config values (task 127)
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

// POST /api/addons/:id/config — persist the add-on's config values, and
// POST /api/addons/:id/:action — run ONE action. Returns false for any other path.
//
// `config` is matched FIRST and is therefore a RESERVED action id: an add-on
// declaring an action called `config` can never be triggered from here. Worth the
// trade — the alternative is a separate top-level path for what is plainly part
// of this surface — and the contract in docs/ADDONS.md says so.
//
// Only keys the add-on declares are accepted. No credential belongs here:
// config.json is world-readable and rewritten on every settings save, so the
// credential lives in the store (core/secrets.mjs) and never in config.
export async function handlePost(path, req, res) {
  const cfgPath = path.match(/^\/api\/addons\/([\w.-]+)\/config$/);
  const m = cfgPath || path.match(/^\/api\/addons\/([\w.-]+)\/([\w.-]+)$/);
  if (!m) return false;

  const originErr = requireSameOrigin(req);
  if (originErr) return errJson(res, 403, originErr);

  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return errJson(res, 400, 'invalid JSON body'); }

  try {
    if (cfgPath) return json(res, 200, { ok: true, id: m[1], config: await core.saveAddonConfig(m[1], body) });
    return json(res, 200, await core.runAddonAction(m[1], m[2], body));
  } catch (e) {
    return errJson(res, 400, String((e && e.message) || e));
  }
}
