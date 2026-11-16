// routes/switches.mjs — a project's switches (task 246): the project settings
// page's switches card reads and saves them here. Modelled on routes/axes.mjs.
//
// GET  /api/switches?p=<slug>            → { slug, switches, stored, defaults, problems }
//        switches: the resolved values ({ value, set } per switch, as
//                  `cogyard tasks switches --json` prints them)
//        stored:   only what the file sets (what the card edits)
//        defaults: what each switch is when the file does not set it
//        problems: entries in the file that are being ignored, and why
// POST /api/switches  { slug, switches } → write <store>/switches.json (guarded)
//        A key left out or null goes back to its default. An invalid entry is
//        refused (400, with each reason) and nothing is written.
//
// The write goes through parseGuarded (origin gate + capped JSON body) and
// assertInStore, which confirms the project has a task store and resolves the
// one fixed file it may write. Like axes.json, the save does not commit: the
// store shows it as uncommitted until `cogyard tasks sync push "<msg>" --
// switches.json` runs (the card says so).

import * as core from '../../core/index.mjs';
import { json, errJson, parseGuarded, assertInStore } from '../http.mjs';

function projectForSlug(slug) {
  if (!slug) return null;
  return core.discoverProjects().find((p) => p.slug === slug) || null;
}

function view(proj) {
  return {
    slug: proj.slug,
    switches: core.resolveSwitches(proj.path),
    stored: core.readProjectSwitches(proj.path),
    defaults: core.switchDefaults(proj.path),
    problems: core.switchProblems(proj.path),
  };
}

export async function handle(path, u, projects, res) {
  if (path !== '/api/switches') return false;
  const proj = projectForSlug(u.searchParams.get('p'));
  if (!proj) return errJson(res, 404, 'unknown project');
  return json(res, 200, view(proj));
}

export async function handlePost(path, req, res) {
  if (path !== '/api/switches') return false;
  const body = await parseGuarded(req, res);
  if (body === null) return true; // parseGuarded already sent the error

  const proj = projectForSlug(body.slug);
  if (!proj) return errJson(res, 404, 'unknown project');
  // Containment: the only file this route may ever write is <store>/switches.json,
  // resolved from the project's own task store. Null = no store → refuse.
  if (!assertInStore(proj.path, core.SWITCHES_FILE)) return errJson(res, 403, 'project has no task store');

  const r = core.writeProjectSwitches(proj.path, body.switches);
  if (!r.ok) return json(res, 400, { error: r.errors.join('; '), errors: r.errors });
  return json(res, 200, { ok: true, ...view(proj) });
}
