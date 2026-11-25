// routes/meta.mjs — cross-project endpoints: health, project list, overview,
// in-progress.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import * as core from '../../core/index.mjs';
import { json, errJson, servedBuild, parseGuarded } from '../http.mjs';

// Per-project count of tasks with a live claim (env.claimed_at set) — the sidebar
// + dock badge signal (task 85: "which project has work in flight right now",
// replacing the old unmerged-worktree count). File-read only via loadTasks; no
// git, so it's as cheap to poll as projectUnmerged's stat-cached count. `unmerged`
// stays on the payload below — the Branches/overview views still read it.
function projectClaimed(proj) {
  try { return core.taskCountsFromFrontmatter(core.loadTasks(core.tasksDirOf(proj.path))).claimed; }
  catch { return 0; }
}

// The RUNNING server's own version + commit (computed here, in the server's layer —
// not read from a frontend build artifact). Stamped once at boot: the short SHA
// bd-verify-deploy polls /health for until it matches local HEAD, and the ROOT
// package.json release counter. (The SPA footer is build-stamped separately via
// frontend/src/version.json — see scripts/generate-version.mjs.)
export const COMMIT = core.tryExec('git rev-parse --short HEAD', { cwd: new URL('../..', import.meta.url).pathname }) || null;
export const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || null; }
  catch { return null; }
})();

// A driver's logo: the image the Plan and Tasks tabs show beside a claimed
// task's live state, so the agent working it is recognisable. The driver's
// bundled file if it ships one, else the copy its onboarding downloaded
// (core/driver-logo.mjs); the name must be an installed driver, so the URL can
// never name another path.
const LOGO_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png' };
async function driverLogo(name, res) {
  if (!core.listDriverNames().includes(name)) return errJson(res, 404, 'no such driver');
  let file = null;
  try { file = core.logoFile(await core.loadAdapter(name)); } catch { /* broken adapter → no logo */ }
  const type = file && LOGO_TYPES[extname(file).toLowerCase()];
  if (!type) return errJson(res, 404, 'this driver has no logo — onboarding the driver downloads one');
  let body;
  try { body = readFileSync(file); } catch { return errJson(res, 404, 'logo file missing'); }
  // no-cache: a driver update that changes its logo shows on the next load,
  // not an hour later. The file is a few KB. The CSP and nosniff keep a
  // downloaded SVG from ever running script on the portal's origin, even if
  // someone opens the URL directly.
  res.writeHead(200, {
    'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  });
  res.end(body);
}

// POST /api/drivers/<name>/open { session } — a click on the driver logo
// beside a claimed task: ask the ACTIVE driver to bring its app to the front
// on that chat (adapter.sessions.open). Nothing is written. The driver's
// answer comes back as it is, 200 either way — "chat is archived" is the
// endpoint working, not failing. Only the active driver: it is the one whose
// chats the portal is showing.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
export async function handlePost(path, req, res) {
  const m = path.match(/^\/api\/drivers\/([a-z0-9_-]+)\/open$/);
  if (!m) return false;
  const body = await parseGuarded(req, res);
  if (!body) return true;
  if (m[1] !== core.adapter.name || typeof core.adapter.sessions?.open !== 'function') {
    errJson(res, 404, 'this driver cannot open a chat'); return true;
  }
  if (typeof body.session !== 'string' || !SESSION_ID.test(body.session)) { errJson(res, 400, 'session must be a chat id'); return true; }
  let r;
  try { r = core.adapter.sessions.open(body.session); }
  catch (e) { r = { ok: false, reason: String((e && e.message) || e) }; }
  json(res, 200, r && r.ok ? { ok: true } : { ok: false, reason: (r && r.reason) || 'could not open the chat' });
  return true;
}

export async function handle(path, u, projects, res) {
  if (path === '/api/health') return json(res, 200, { ok: true, commit: COMMIT, version: VERSION, projects: projects.length });
  const logo = path.match(/^\/api\/drivers\/([a-z0-9_-]+)\/logo$/);
  if (logo) return driverLogo(logo[1], res);
  // GET /api/versions?k=<entry>&k=<entry>… → { <entry>: code | null } (task 173).
  // The portal's one refresh check: the browser sends the cache entries something
  // on screen reads, and refetches only those whose code moved (null = no code,
  // poll it). Read-only; file metadata only, no git. Capped so a malformed
  // client can't make one request walk every repo hundreds of times.
  // '@build' rides along: the SPA build served now (servedBuild), which no
  // entry name can collide with — an open page shows a reload icon when it
  // differs from the build it is running.
  if (path === '/api/versions') {
    const keys = [...new Set(u.searchParams.getAll('k'))].slice(0, 200);
    return json(res, 200, { ...core.versionsFor(keys, projects), '@build': servedBuild() });
  }
  if (path === '/api/projects') return json(res, 200,
    await Promise.all(projects.map(async (p) => ({
      slug: p.slug, label: p.label, claimed: projectClaimed(p), unmerged: await core.projectUnmerged(p),
    }))));
  // The editable "Open in" target list — id + label only; the
  // command (exec/args) stays server-side, the client just renders the menu.
  if (path === '/api/open-targets') return json(res, 200, core.openTargets().map((t) => ({ id: t.id, label: t.label })));
  if (path === '/api/overview') {
    const rows = await Promise.all(projects.map((p) => core.projectOverview(p).catch(() => ({ slug: p.slug, label: p.label, error: true }))));
    return json(res, 200, { projects: rows });
  }
  // The All tab's per-project boxes (task 265): each project's tasks in progress
  // and its last 10 closed — the Plan tab's own data (core/in-progress.mjs).
  if (path === '/api/in-progress') return json(res, 200, { projects: await core.inProgressAll(projects) });
  return false;
}
