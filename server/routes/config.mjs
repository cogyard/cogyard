// routes/config.mjs — the portal's config/settings surface.
//
// GET /api/config returns the resolved config picture the /settings view + the
// first-run wizard render (paths with env-vs-default flags, version/commit, the
// editable open-target rows, the New/Add creation defaults, and which agent
// adapter is active). GET /api/project-icon streams
// one project's configured icon file (task 114) — a read, so it adds nothing to
// the POST allowlist. POST /api/config + POST /api/open-targets persist the
// settable bits — the FOURTH write set on the read-mostly /api surface, through
// the SAME requireSameOrigin + readBody seam as routes/projects.mjs.
// No new write path; all data logic lives in core/ (config.mjs, open-targets.mjs).

import { createReadStream, existsSync, statSync } from 'node:fs';
import * as core from '../../core/index.mjs';
import { json, errJson, requireSameOrigin, readBody, assertInProject } from '../http.mjs';
import { VERSION, COMMIT } from './meta.mjs';

// GET /api/config and GET /api/project-icon. Returns false for any other path so
// the router falls through.
export async function handle(path, u, projects, res) {
  if (path === '/api/project-icon') return projectIcon(u, projects, res);
  if (path === '/api/project-images') return projectImages(u, projects, res);
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
    defaults: core.projectDefaults(), // { kind }
    kinds: core.scaffoldKinds(),      // [{ kind, description, builtin }] — the scaffold registry
    ui: core.uiPrefs(),               // { weekStart, dayStart, hiddenTabs, defaultTab, projectIcons }
    // DERIVED, not persisted (task 140) — { [slug]: version } for whatever
    // artwork each configured icon currently resolves to. The rail threads it
    // into the /api/project-icon URL so the address changes when the bytes do;
    // without it the URL is slug-only and a re-pointed icon stayed cached. It
    // sits at the top level rather than inside `ui` precisely because it is
    // computed: `ui` is the persisted preference block that POST round-trips.
    projectIconVersions: iconVersions(projects),
    driver: { active: core.adapter.name, available: core.listDriverNames() },
  });
}

// { [slug]: version } over the configured icons. One stat per configured icon,
// on a route the portal already polls — cheap enough to do inline, and skipped
// entirely for projects with no icon. An unreadable file yields no entry, which
// the rail reads as "unversioned": the URL still resolves, and its 404 is the
// empty-slot state.
function iconVersions(projects) {
  const out = {};
  for (const [slug, rel] of Object.entries(core.uiPrefs().projectIcons)) {
    const proj = projects.find((p) => p.slug === slug);
    if (!proj) continue;
    const abs = assertInProject(proj.path, rel);
    if (!abs) continue;
    const v = core.iconVersion(abs, rel);
    if (v) out[slug] = v;
  }
  return out;
}

// GET /api/project-images?slug=<slug> — every image file in that project's repo,
// repo-root-relative (task 140). The Icon card's picker reads this so choosing
// artwork no longer means leaving the portal to transcribe a path by hand.
//
// A READ, so it adds nothing to the POST allowlist. Not detection: it lists,
// nothing ranks or nominates — see the header of core/project-icons.mjs.
async function projectImages(u, projects, res) {
  const slug = u.searchParams.get('slug');
  const proj = projects.find((p) => p.slug === slug);
  if (!proj) return errJson(res, 404, 'unknown project');
  return json(res, 200, {
    slug,
    // The card's Copy-instructions brief states the repo and the accepted
    // formats. Both come from here rather than being retyped in the frontend,
    // so extending ICON_MIME updates the brief with no second edit to remember.
    repoPath: proj.path,
    extensions: Object.keys(core.ICON_MIME),
    images: await core.listProjectImages(proj.path),
  });
}

// GET /api/project-icon?slug=<slug>[&path=<rel>] — stream an icon.
// The file lives inside a project repo, outside the SPA's static root, so it
// needs a read endpoint. Path safety is doubled up: core/project-icons.mjs
// validated the shape on the way IN (relative, no `..`, image extension), and
// assertInProject re-checks realpath containment here so a path that became a
// symlink escape after it was saved still can't be served. A missing/unset/bad
// icon is a 404 — the rail then renders its empty slot, which is the no-icon
// state anyway.
function projectIcon(u, projects, res) {
  const slug = u.searchParams.get('slug');
  const proj = projects.find((p) => p.slug === slug);
  if (!proj) return errJson(res, 404, 'unknown project');

  // An explicit `path` previews an UNSAVED draft (task 140); without one this
  // serves whatever is configured, as it always has. The draft path gets the
  // same treatment as a stored one — the extension allowlist here, realpath
  // containment below — so previewing can read no file that saving couldn't.
  const draft = u.searchParams.get('path');
  const rel = draft === null ? core.uiPrefs().projectIcons[slug] : draft.trim();
  if (!rel) return errJson(res, 404, draft === null ? 'no icon configured' : 'no path given');
  // Say WHICH rule the path broke — this message is what the card shows the
  // owner while they type, so "not an image" for a `../` path would send them
  // looking at the wrong end of it.
  if (rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)) {
    return errJson(res, 400, 'must be relative to the project root, not absolute');
  }
  if (rel.split(/[\\/]/).includes('..')) {
    return errJson(res, 400, 'must stay inside the project — no ".." segments');
  }
  if (!core.isIconPath(rel)) {
    return errJson(res, 400, `must be an image file (${Object.keys(core.ICON_MIME).join(', ')})`);
  }

  const abs = assertInProject(proj.path, rel);
  if (!abs) return errJson(res, 403, 'icon path escapes the project');
  if (!existsSync(abs) || !statSync(abs).isFile()) return errJson(res, 404, 'icon file not found');

  res.writeHead(200, {
    'Content-Type': core.iconMime(rel),
    // A minute for a configured icon, deliberately, even though callers now pass
    // a `v` that changes whenever the artwork does (task 140). The version makes
    // a LONG cache safe, but not correct: `v` comes from /api/config, so a client
    // holding a stale config would pin a stale icon for however long we said.
    // Sixty seconds is the ceiling on being wrong, at one small request a minute.
    //
    // A draft preview is never cached. It is the answer to "is the file I am
    // typing the one I want", asked while the owner may also be editing that
    // file — a cached yes from thirty seconds ago is worse than no answer.
    'Cache-Control': draft === null ? 'public, max-age=60' : 'no-store',
  });
  createReadStream(abs).pipe(res);
  return true;
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
    // Only `kind` is a default; anything else the client sends is not persisted.
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
    if (u.projectIcons !== undefined) {
      const err = core.projectIconsError(u.projectIcons);
      if (err) return errJson(res, 400, err);
      // Sanitize rather than store verbatim: an empty-string value is how the
      // settings card CLEARS a project's icon, and it must not persist as a key.
      ui.projectIcons = core.sanitizeProjectIcons(u.projectIcons);
    }
    if (u.projectIconBorders !== undefined) {
      const err = core.projectIconBordersError(u.projectIconBorders);
      if (err) return errJson(res, 400, err);
      ui.projectIconBorders = core.sanitizeProjectIconBorders(u.projectIconBorders);
    }
    if (u.hiddenTabs !== undefined) {
      if (!Array.isArray(u.hiddenTabs) || u.hiddenTabs.some((t) => !core.PORTAL_TABS.includes(t))) {
        return errJson(res, 400, `hiddenTabs must be an array of tab ids (${core.PORTAL_TABS.join(', ')})`);
      }
      ui.hiddenTabs = u.hiddenTabs;
    }
    if (u.defaultTab !== undefined) {
      if (!core.PORTAL_TABS.includes(u.defaultTab)) {
        return errJson(res, 400, `defaultTab must be one of: ${core.PORTAL_TABS.join(', ')}`);
      }
      ui.defaultTab = u.defaultTab;
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
