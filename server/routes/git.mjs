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

// The repo a read targets: ?source=store → the project's task store (task 191,
// resolved from the slug by core — the client never names the directory),
// else the `worktree=` checkout (or the main one). Store reads ignore
// `worktree=`: a store has one working tree.
function resolveRepoDir(u, proj) {
  if (u.searchParams.get('source') !== 'store') return resolveWorktreeDir(u, proj);
  const dir = core.canonicalStore(proj.path);
  return dir ? { dir, store: true } : { err: 'no separate task store for this project' };
}

export async function handle(path, u, proj, res) {
  if (path === '/api/commit') {
    const h = u.searchParams.get('h') || '';
    const bad = badHash(h);
    if (bad) return errJson(res, 400, bad);
    const { dir, store, err } = resolveRepoDir(u, proj);
    if (err) return errJson(res, 400, err);
    const d = await commitDetail(dir, h);
    // In the store, each file's class (task / job / other …) and the commit's
    // flags come with the detail, so the panel groups and flags without
    // re-deriving the rule client-side.
    return json(res, 200, store ? { ...d, audit: core.auditCommit(d.subject, d.files) } : d);
  }
  if (path === '/api/branches') return json(res, 200, await gitBranches(proj.path));
  if (path === '/api/status') {
    const { dir, store, err } = resolveRepoDir(u, proj);
    if (err) return errJson(res, 400, err);
    const st = await gitStatus(dir);
    if (!store) return json(res, 200, st);
    // Store mode: what each uncommitted file is, and the pending row's flags.
    const facts = core.storeFacts(dir);
    return json(res, 200, { ...st, audit: { flags: facts.pending.flags, files: facts.pending.files } });
  }
  // `from` (optional) = a renamed file's OLD path (task 224). With both paths in
  // the pathspec git pairs them as a rename and shows what changed; with only
  // the new path it shows the whole file as added.
  if (path === '/api/workdiff') {
    const f = u.searchParams.get('path') || '';
    const from = u.searchParams.get('from') || '';
    const kind = u.searchParams.get('kind') || 'unstaged';
    const bad = badRelPath(f) || (from && badRelPath(from)) || badKind(kind);
    if (bad) return errJson(res, 400, bad);
    const { dir, err } = resolveRepoDir(u, proj);
    if (err) return errJson(res, 400, err);
    const patch = await workDiff(dir, f, kind, u.searchParams.get('w') === '1', from || null);
    return json(res, 200, { patch });
  }
  if (path === '/api/diff') {
    const h = u.searchParams.get('h') || '';
    const f = u.searchParams.get('path') || '';
    const from = u.searchParams.get('from') || '';
    const bad = badHash(h) || badRelPath(f) || (from && badRelPath(from));
    if (bad) return errJson(res, 400, bad);
    // Stash commits are merge commits — `git show` yields an empty combined diff.
    // stashFileDiff handles both halves: tracked (base → stash) and untracked
    // files (the `stash -u` ^3 tree), which a plain diff would miss.
    const w = u.searchParams.get('w') === '1';
    const { dir, err } = resolveRepoDir(u, proj);
    if (err) return errJson(res, 400, err);
    let patch;
    if (await isStashCommit(dir, h)) {
      patch = await stashFileDiff(dir, h, f, w);
    } else {
      const args = ['show', '--format=', '--no-color', '-M'];
      if (w) args.push('-w'); // ignore whitespace
      args.push(h, '--', ...(from ? [from] : []), f);
      patch = await core.gitP(args, dir);
    }
    return json(res, 200, { patch: patch || '' });
  }
  return false;
}
