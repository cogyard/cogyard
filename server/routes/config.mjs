// routes/config.mjs — the portal's config/settings surface.
//
// GET /api/config returns the resolved config picture the /settings view + the
// first-run wizard render (paths with env-vs-default flags, version/commit, the
// editable open-target rows, the New/Add creation defaults, and which agent
// adapter is active). POST /api/config + POST /api/open-targets persist the
// settable bits — the FOURTH write set on the read-mostly /api surface, through
// the SAME requireSameOrigin + readBody seam as routes/projects.mjs.
// No new write path; all data logic lives in core/ (config.mjs, open-targets.mjs).

import * as core from '../../core/index.mjs';
import { json, errJson, requireSameOrigin, readBody } from '../http.mjs';
import { VERSION, COMMIT } from './meta.mjs';

// GET /api/config — the resolved picture. Returns false for any other path so the
// router falls through.
export async function handle(path, u, projects, res) {
  if (path !== '/api/config') return false;
  const pr = core.resolveProjectsRoot();
  return json(res, 200, {
    home: core.COGYARD_HOME,
    homeFromEnv: !!process.env.COGYARD_HOME,
    projectsRoot: pr.value,
    projectsRootSource: pr.source, // 'env' | 'config' | 'default'
    version: VERSION,
    commit: COMMIT,
    // Full rows here (id/label/exec/args) — the /settings list editor edits the
    // command, unlike GET /api/open-targets which exposes only id+label.
    openTargets: core.openTargets(),
    defaults: core.projectDefaults(), // { kind, store }
    kinds: core.scaffoldKinds(),      // [{ kind, description, builtin }] — the scaffold registry
    ui: core.uiPrefs(),               // { weekStart }
    driver: { active: core.adapter.name, available: core.listDriverNames() },
  });
}

// POST /api/config and POST /api/open-targets. Returns false for any other path.
export async function handlePost(path, req, res) {
  if (path !== '/api/config' && path !== '/api/open-targets') return false;

  const originErr = requireSameOrigin(req);
  if (originErr) return errJson(res, 403, originErr);

  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return errJson(res, 400, 'invalid JSON body'); }

  if (path === '/api/config') return saveConfig(body, res);
  return saveOpenTargets(body, res);
}

// Persist ONLY { defaults?, projectsRoot? } — never a free-form merge of whatever
// the client sends (driver/COGYARD_HOME are not API-writable). Each field is
// validated before it's allowed into the patch.
function saveConfig(body, res) {
  const patch = {};

  if (body.defaults !== undefined) {
    const d = body.defaults;
    if (!d || typeof d !== 'object') return errJson(res, 400, 'defaults must be an object');
    const defaults = {};
    if (d.kind !== undefined) {
      if (!core.KINDS.includes(d.kind)) return errJson(res, 400, `kind must be one of: ${core.KINDS.join(', ')}`);
      defaults.kind = d.kind;
    }
    // `store` is no longer a settable default — shared is the only store model.
    // Any `store` field the client sends is ignored, not persisted.
    patch.defaults = defaults;
  }

  if (body.ui !== undefined) {
    const u = body.ui;
    if (!u || typeof u !== 'object') return errJson(res, 400, 'ui must be an object');
    const ui = {};
    if (u.weekStart !== undefined) {
      if (!core.WEEK_STARTS.includes(u.weekStart)) return errJson(res, 400, `weekStart must be one of: ${core.WEEK_STARTS.join(', ')}`);
      ui.weekStart = u.weekStart;
    }
    if (u.dayStart !== undefined) {
      if (!Number.isInteger(u.dayStart) || u.dayStart < 0 || u.dayStart > 23) return errJson(res, 400, 'dayStart must be an integer hour 0-23');
      ui.dayStart = u.dayStart;
    }
    if (u.hiddenTabs !== undefined) {
      if (!Array.isArray(u.hiddenTabs) || u.hiddenTabs.some((t) => !core.PORTAL_TABS.includes(t))) {
        return errJson(res, 400, `hiddenTabs must be an array of tab ids (${core.PORTAL_TABS.join(', ')})`);
      }
      ui.hiddenTabs = u.hiddenTabs;
    }
    patch.ui = { ...core.readConfig().ui, ...ui };
  }

  if (body.disabledAddons !== undefined) {
    if (!Array.isArray(body.disabledAddons) || body.disabledAddons.some((x) => typeof x !== 'string')) {
      return errJson(res, 400, 'disabledAddons must be an array of add-on ids');
    }
    patch.disabledAddons = body.disabledAddons;
  }

  if (body.projectsRoot !== undefined) {
    if (typeof body.projectsRoot !== 'string' || !body.projectsRoot.trim()) {
      return errJson(res, 400, 'projectsRoot must be a non-empty string');
    }
    patch.projectsRoot = body.projectsRoot.trim();
  }

  if (Object.keys(patch).length === 0) return errJson(res, 400, 'nothing to save (expected defaults, ui, disabledAddons, and/or projectsRoot)');

  try {
    core.writeConfig(patch);
    // Re-resolve so the client gets the new projectsRoot source immediately (a
    // projectsRoot change only re-resolves PROJECTS_ROOT on process restart — the
    // documented LaunchAgent reload — but the saved value is reported back now).
    const pr = core.resolveProjectsRoot();
    return json(res, 200, { ok: true, defaults: core.projectDefaults(), ui: core.uiPrefs(), projectsRoot: pr.value, projectsRootSource: pr.source });
  } catch (e) {
    return errJson(res, 400, String((e && e.message) || e));
  }
}

function saveOpenTargets(body, res) {
  const list = Array.isArray(body) ? body : body.targets;
  try {
    const written = core.writeOpenTargets(list);
    return json(res, 200, { ok: true, openTargets: written });
  } catch (e) {
    return errJson(res, 400, String((e && e.message) || e));
  }
}
