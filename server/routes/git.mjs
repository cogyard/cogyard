// routes/git.mjs — per-project git views: commit detail, branches, working-tree
// status and diffs. Read-only.
//
// (routes/actions.mjs sits next to this file: POST /api/wt/discard,
// /api/open — guarded by requireSameOrigin + assertInProject from ../http.mjs.)

import * as core from '../../core/index.mjs';
import { json, errJson, badHash, badRelPath, badKind } from '../http.mjs';
import { gitBranches, gitStatus, workDiff, commitDetail, isStashCommit, stashFileDiff } from '../git.mjs';

// Resolve the optional `worktree=` param to a checkout dir. Validated against
// the project's real worktree list — never a raw caller-supplied cwd (same
// posture as /api/diff's traversal guards). Shared with the per-worktree
// reads: reuse this, don't re-derive.
export function resolveWorktreeDir(u, proj) {
  const wt = u.searchParams.get('worktree');
  if (!wt) return { dir: proj.path };
  if (!core.projectWorktreePaths(proj).has(wt)) return { err: 'unknown worktree' };
  return { dir: wt };
}

export async function handle(path, u, proj, res) {
  if (path === '/api/commit') {
    const h = u.searchParams.get('h') || '';
    const bad = badHash(h);
    if (bad) return errJson(res, 400, bad);
    return json(res, 200, await commitDetail(proj.path, h));
  }
  if (path === '/api/branches') return json(res, 200, await gitBranches(proj.path));
  if (path === '/api/status') {
    const { dir, err } = resolveWorktreeDir(u, proj);
    if (err) return errJson(res, 400, err);
    return json(res, 200, await gitStatus(dir));
  }
  if (path === '/api/workdiff') {
    const f = u.searchParams.get('path') || '';
    const kind = u.searchParams.get('kind') || 'unstaged';
    const bad = badRelPath(f) || badKind(kind);
    if (bad) return errJson(res, 400, bad);
    const { dir, err } = resolveWorktreeDir(u, proj);
    if (err) return errJson(res, 400, err);
    const patch = await workDiff(dir, f, kind, u.searchParams.get('w') === '1');
    return json(res, 200, { patch });
  }
  if (path === '/api/diff') {
    const h = u.searchParams.get('h') || '';
    const f = u.searchParams.get('path') || '';
    const bad = badHash(h) || badRelPath(f);
    if (bad) return errJson(res, 400, bad);
    // Stash commits are merge commits — `git show` yields an empty combined diff.
    // stashFileDiff handles both halves: tracked (base → stash) and untracked
    // files (the `stash -u` ^3 tree), which a plain diff would miss.
    const w = u.searchParams.get('w') === '1';
    let patch;
    if (await isStashCommit(proj.path, h)) {
      patch = await stashFileDiff(proj.path, h, f, w);
    } else {
      const args = ['show', '--format=', '--no-color'];
      if (w) args.push('-w'); // ignore whitespace
      args.push(h, '--', f);
      patch = await core.gitP(args, proj.path);
    }
    return json(res, 200, { patch: patch || '' });
  }
  return false;
}
