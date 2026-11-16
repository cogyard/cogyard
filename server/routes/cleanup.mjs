// routes/cleanup.mjs — the cleanup surface (task 117).
//
//   GET  /api/cleanup            the report: one item per finished piece of
//                                work, across every registered project
//   POST /api/cleanup/worktree   remove ONE worktree, verified
//
// All the logic is core/cleanup.mjs — this file is transport and gate only,
// per the repo invariant that server/ owns no data logic.
//
// THE GATE, and why it is enforced HERE rather than in the browser.
//
// Task 106's trust model forbids unattended callers and demands a confirmation
// no weaker than the CLI's typed y/n. Clarified 2026-08-07: a
// dialog with a human present satisfies it. But a dialog is client code: it can
// be skipped by anything speaking HTTP, so a client-only confirmation is
// decoration, not a gate. The server therefore requires the caller to echo back
// the worktree's own NAME in `confirm`. That is a check on the REQUEST, not on
// keystrokes: a caller that hasn't decided which worktree it means cannot
// produce the name, so nothing sweeps the yard by accident. The human's own
// consent lives in the page (tick the rows, then Delete in a dialog listing
// them) — the browser fills `confirm` from each row. It used to make the human
// type the name; that was far above the bar task 106 set and made the page
// unused, which is task 129.
//
// One worktree per REQUEST is structural, not a rule to remember: the route
// takes a single worktree and there is no batch shape to send. The page may
// send several in sequence (task 148), each passing this gate on its own.
//
// The removal and its two verifications (branch still resolves, attributed cost
// unchanged) are core/cleanup.mjs's removeWorktree — literally the same body
// `cogyard sessions audit --cleanup` runs. This route does NOT shell out to the
// CLI: trust rule 3 forbids a route calling into it, and the shared core
// function is what makes that unnecessary.

import { basename, resolve } from 'node:path';
import * as core from '../../core/index.mjs';
import { json, errJson, parseGuarded } from '../http.mjs';

export async function handle(path, u, projects, res) {
  if (path !== '/api/cleanup') return false;
  const slug = u.searchParams.get('p');
  return json(res, 200, await core.cleanupReport({ slug }));
}

export async function handlePost(path, req, res) {
  if (path !== '/api/cleanup/worktree') return false;

  const body = await parseGuarded(req, res);
  if (!body) return true;

  const { slug, worktreePath, confirm } = body;
  if (!slug || !worktreePath) { errJson(res, 400, 'slug and worktreePath are required'); return true; }

  // The project must be one we actually manage, and the worktree must be one of
  // ITS real checkouts — never a caller-supplied path we then hand to git.
  // Same containment principle as routes/actions.mjs, expressed against the
  // worktree set because that is what this action operates on.
  const proj = core.discoverProjects().find((p) => p.slug === slug);
  if (!proj) { errJson(res, 400, 'unknown project: ' + slug); return true; }

  const known = [...core.projectWorktreePaths(proj)].find((p) => resolve(p) === resolve(worktreePath));
  if (!known) { errJson(res, 403, 'not a worktree of this project'); return true; }

  // The typed-name gate. Compared against the resolved worktree's own basename,
  // not against anything else the caller sent, so a caller cannot satisfy it by
  // echoing its own input.
  if (String(confirm || '') !== basename(known)) {
    errJson(res, 400, `confirmation must be the worktree name: ${basename(known)}`);
    return true;
  }

  // Which branch/task this worktree carries is read from the report rather than
  // taken from the request — the caller does not get to tell us what it is
  // removing, only which path.
  const report = await core.cleanupReport({ slug });
  const item = (report.projects[0]?.items || []).find((i) => resolve(i.worktree.path) === resolve(known));
  if (!item) { errJson(res, 404, 'worktree not in the cleanup report'); return true; }

  const result = await core.removeWorktree({
    repoPath: item.repoPath,
    worktreePath: known,
    branch: item.worktree.branch,
    project: slug,
    taskId: item.taskId,
  });

  // A refusal is not a server error — the ladder saying DIRTY is this endpoint
  // working correctly. 409: the worktree's state conflicts with the request.
  if (!result.ok) {
    return json(res, result.stage === 'precheck' ? 409 : 500, { ok: false, ...result });
  }
  return json(res, 200, result);
}
