// routes/axes.mjs — the label-axis manager's read + write surface (task 096,
// Phase 4). The portal /settings axis manager edits each LAYER of the axis map
// separately, so this exposes the RAW shared and RAW project maps (not the
// resolved/merged view — that rides on /api/tasks for rendering) and persists
// edits through the same http.mjs write seam every other write uses.
//
// GET  /api/axes?scope=shared            → raw shared map ($COGYARD_HOME/axes.json)
// GET  /api/axes?scope=project&p=<slug>  → raw project map (<task link>/axes.json)
// POST /api/axes  { scope, slug?, axes } → persist that layer (guarded)
//
// Writes go through parseGuarded (origin gate + capped JSON body); the project
// scope additionally runs assertInStore, which confirms the project has a task
// store and resolves the fixed target <store>/axes.json. The map lives IN the
// store (with the tasks), which for shared-store projects is a symlink outside
// the repo — deliberately outside assertInProject's boundary, hence assertInStore.

import * as core from '../../core/index.mjs';
import { json, errJson, parseGuarded, assertInStore } from '../http.mjs';

function projectForSlug(slug) {
  if (!slug) return null;
  return core.discoverProjects().find((p) => p.slug === slug) || null;
}

export async function handle(path, u, projects, res) {
  if (path !== '/api/axes') return false;
  const scope = u.searchParams.get('scope');
  if (scope === 'shared') {
    return json(res, 200, { scope: 'shared', axes: core.readSharedAxes() });
  }
  if (scope === 'project') {
    const proj = projectForSlug(u.searchParams.get('p'));
    if (!proj) return errJson(res, 404, 'unknown project');
    return json(res, 200, { scope: 'project', slug: proj.slug, axes: core.readProjectAxes(proj.path) });
  }
  return errJson(res, 400, "scope must be 'shared' or 'project'");
}

export async function handlePost(path, req, res) {
  if (path !== '/api/axes') return false;
  const body = await parseGuarded(req, res);
  if (body === null) return true; // parseGuarded already sent the error

  if (!Array.isArray(body.axes)) return errJson(res, 400, 'axes must be an array');

  if (body.scope === 'shared') {
    const axes = core.writeSharedAxes(body.axes);
    return json(res, 200, { ok: true, scope: 'shared', axes });
  }

  if (body.scope === 'project') {
    const proj = projectForSlug(body.slug);
    if (!proj) return errJson(res, 404, 'unknown project');
    // Containment: the only file this scope may ever write is <store>/axes.json,
    // resolved from the project's own task store. Null = no store → refuse.
    if (!assertInStore(proj.path)) {
      return errJson(res, 403, 'project has no task store');
    }
    const axes = core.writeProjectAxes(proj.path, body.axes);
    return json(res, 200, { ok: true, scope: 'project', slug: proj.slug, axes });
  }

  return errJson(res, 400, "scope must be 'shared' or 'project'");
}
