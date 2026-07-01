// core/refs.mjs — read a git checkout's ref state straight from the ref files
// (HEAD + refs/heads + packed-refs), with ZERO git spawns. Shared by the
// change-signals in unmerged.mjs and overview.mjs: both want a cheap fingerprint
// of "did a tip move" (commit / checkout / merge / worktree add-remove) so the
// expensive git recompute only runs on an actual change, and a poll where nothing
// moved costs a few file reads instead of a fan-out of git processes.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// packed-refs as a { fullRef -> sha } map, read once per state snapshot.
export function loadPackedRefs(commonDir) {
  const m = new Map();
  try {
    for (const line of readFileSync(join(commonDir, 'packed-refs'), 'utf8').split('\n')) {
      if (!line || line[0] === '#' || line[0] === '^') continue;
      const sp = line.indexOf(' ');
      if (sp > 0) m.set(line.slice(sp + 1), line.slice(0, sp));
    }
  } catch { /* no packed-refs is fine */ }
  return m;
}

// Resolve a ref to its SHA from loose ref file, else packed-refs. No git.
export function resolveRef(commonDir, packed, ref) {
  try { return readFileSync(join(commonDir, ref), 'utf8').trim(); } catch { /* not loose */ }
  return packed.get(ref) || null;
}

// The tip SHA a HEAD file points at — following `ref:` once, or the raw SHA
// when detached. `headDir` holds the HEAD file; refs resolve in `commonDir`.
export function headSha(headDir, commonDir, packed) {
  let h;
  try { h = readFileSync(join(headDir, 'HEAD'), 'utf8').trim(); } catch { return null; }
  if (h.startsWith('ref: ')) return resolveRef(commonDir, packed, h.slice(5).trim());
  return h || null; // detached HEAD → raw SHA
}

// Snapshot { mainSha, wts: [{name, sha}] } read entirely from ref files. The
// linked worktrees live under <repo>/.git/worktrees/<name>/ (the main checkout
// is excluded — it can't be "unmerged" against itself).
export function readState(repoPath) {
  const commonDir = join(repoPath, '.git');
  const packed = loadPackedRefs(commonDir);
  const mainSha = headSha(commonDir, commonDir, packed);
  const wts = [];
  let names = [];
  try { names = readdirSync(join(commonDir, 'worktrees')); } catch { /* none */ }
  for (const name of names) {
    const sha = headSha(join(commonDir, 'worktrees', name), commonDir, packed);
    if (sha) wts.push({ name, sha });
  }
  return { mainSha, wts };
}

// Stable fingerprint of a readState() snapshot — changes iff main's tip or any
// linked worktree's tip moves. Used both as unmerged.mjs's cache key and as the
// ref-half of overview.mjs's change-signal.
export const keyOf = (s) => `${s.mainSha || ''}|${s.wts.map((w) => `${w.name}:${w.sha}`).sort().join(',')}`;
