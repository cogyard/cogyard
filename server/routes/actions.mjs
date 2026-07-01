// routes/actions.mjs — the portal's working-tree write/exec actions (task 12):
// discard, and open-in-editor / reveal-in-Finder / open-default. (Stage/unstage
// endpoints were removed — staging is done via Claude, not the portal.)
//
// These are the ONLY endpoints that mutate the git index or shell out on the
// host, so the portal stops being read-only here. Every one is gated by
// requireSameOrigin (CSRF) + assertInProject (path containment) from ../http.mjs,
// and runs via execFile with an args array — never a shell string — so a path
// can't inject. POST-only; reached through the http.mjs seam, same as usage.
//
// macOS only for now (`open` / `code`); non-mac variants are out of scope (v1).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlinkSync } from 'node:fs';
import * as core from '../../core/index.mjs';
import { json, errJson, requireSameOrigin, readBody, assertInProject } from '../http.mjs';

const execFileP = promisify(execFile);

// Resolve {slug, worktree?} to a validated checkout dir. `worktree` (an absolute
// checkout path, as the status/workdiff reads use it) must be one of the
// project's real worktrees — never a raw caller cwd. Omitted = main checkout.
function resolveCheckout(body, projects) {
  const proj = body.slug ? projects.find((p) => p.slug === body.slug) : projects[0];
  if (!proj) return { err: 'unknown project: ' + body.slug };
  if (body.worktree) {
    if (!core.projectWorktreePaths(proj).has(body.worktree)) return { err: 'unknown worktree' };
    return { dir: body.worktree };
  }
  return { dir: proj.path };
}

// Shared preamble: origin gate + JSON body parse. Returns the parsed body, or
// null after having already sent the error response.
async function parseGuarded(req, res) {
  const originErr = requireSameOrigin(req);
  if (originErr) { errJson(res, 403, originErr); return null; }
  try { return JSON.parse((await readBody(req)) || '{}'); }
  catch { errJson(res, 400, 'bad JSON body'); return null; }
}

const stderrOf = (e) => String((e && e.stderr) || (e && e.message) || e).trim();

export async function handlePost(path, req, res, projects) {
  if (path !== '/api/wt/discard' && path !== '/api/open') return false;

  const body = await parseGuarded(req, res);
  if (!body) return true;
  const { dir, err } = resolveCheckout(body, projects);
  if (err) { errJson(res, 400, err); return true; }
  const abs = assertInProject(dir, body.path);
  if (!abs) { errJson(res, 403, 'path outside project'); return true; }

  try {
    if (path === '/api/wt/discard') {
      // Tracked: revert the working-tree file (git restore). Untracked: it isn't
      // in git, so delete it on disk (within the contained, realpath'd abs).
      if (body.untracked) unlinkSync(abs);
      else await execFileP('git', ['restore', '--', body.path], { cwd: dir });
    } else { // /api/open — resolve the target id to its configured command
      const target = core.findOpenTarget(body.target);
      if (!target) { errJson(res, 400, 'unknown open target: ' + body.target); return true; }
      const cmd = core.resolveOpenCommand(target, abs, body.line);
      await execFileP(cmd.exec, cmd.args);
    }
    json(res, 200, { ok: true });
  } catch (e) {
    errJson(res, 500, stderrOf(e));
  }
  return true;
}
