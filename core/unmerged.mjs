// core/unmerged.mjs — per-project "unmerged worktree" count (worktrees holding
// commits not yet landed on main), computed ONCE per actual change and read cheap.
//
// This backs the sidebar + dock/web badges, which read it often but it changes
// rarely (only on commit / merge / checkout / worktree add-remove). So the read
// path touches NO git: it reads each worktree's tip SHA straight from the ref
// files (HEAD + refs/heads + packed-refs) and uses the (mainTip, worktreeTips)
// tuple as a cache key. The git work — a `merge-base --is-ancestor` per worktree
// to decide merged-vs-unmerged — runs only when that tuple changes.
//
// Contrast with the /api/overview memoize, whose change-signal is itself git
// (rev-parse + status per project on every read). Here the change-signal is pure
// file reads, so a hit is microseconds. The ref-snapshot reader lives in
// core/refs.mjs (shared with overview.mjs's signal).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readState, keyOf } from './refs.mjs';

const execFileP = promisify(execFile);

// repoPath -> { key, count }. Process-lifetime cache; the server is long-running.
const cache = new Map();

// Unmerged worktree count for ONE checkout (a project clone). Cheap on a cache
// hit (just the ref-file reads above); on a miss, one ancestry probe per worktree.
export async function worktreeUnmergedCount(repoPath) {
  let state;
  try { state = readState(repoPath); } catch { return 0; }
  if (!state.mainSha) return 0;
  const key = keyOf(state);
  const hit = cache.get(repoPath);
  if (hit && hit.key === key) return hit.count;

  // Miss: a tip moved. A worktree is unmerged iff its tip is NOT an ancestor of
  // main (i.e. it carries commits main doesn't). Same-tip is a free shortcut.
  const verdicts = await Promise.all(state.wts.map(async (w) => {
    if (w.sha === state.mainSha) return false;
    try { await execFileP('git', ['-C', repoPath, 'merge-base', '--is-ancestor', w.sha, state.mainSha]); return false; } // exit 0 = ancestor = merged
    catch (e) { return e.code === 1; } // exit 1 = not ancestor = unmerged; other codes (bad sha) → ignore
  }));
  const count = verdicts.filter(Boolean).length;
  cache.set(repoPath, { key, count });
  return count;
}

// Sum across a project's clones (multi-clone planet projects).
export async function projectUnmerged(proj) {
  const clonePaths = proj.clones && proj.clones.length ? proj.clones : [proj.path];
  const counts = await Promise.all(clonePaths.map((cp) => worktreeUnmergedCount(cp)));
  return counts.reduce((n, c) => n + c, 0);
}
