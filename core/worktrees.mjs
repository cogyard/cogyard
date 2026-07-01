// core/worktrees.mjs — worktree view (read-only, Phase 0). Auto-enumerates
// `git worktree list` per project — the thing SmartGit makes you do by hand.
// Read-only: ahead/behind vs the main worktree's branch, dirty state, a
// staleness flag, and any allocated ports from worktree-ports.json. No actions.

import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { WORKTREE_PORTS_PATH } from './paths.mjs';
import { tryExec, gitP } from './exec.mjs';
import { loadTasks } from './frontmatter.mjs';

function loadPortAllocations() {
  try { return JSON.parse(readFileSync(WORKTREE_PORTS_PATH, 'utf8')).allocations || {}; }
  catch { return {}; }
}

// Parse `git worktree list --porcelain`. The main worktree is listed first.
function gitWorktrees(repoPath) {
  const raw = tryExec('git worktree list --porcelain', { cwd: repoPath });
  if (!raw) return [];
  const entries = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) { if (cur) entries.push(cur); cur = { path: line.slice('worktree '.length) }; }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'bare') cur.bare = true;
  }
  if (cur) entries.push(cur);
  return entries;
}

// For one repo: enrich each worktree with ahead/behind vs the main worktree's
// branch, dirty count, staleness flag + reasons, and ports. Git calls are fanned
// out with Promise.all (per-worktree rev-list + status run concurrently) so a
// 28-worktree repo doesn't pay 56 sequential git spawns.
async function computeWorktrees(repoPath, allocations) {
  const entries = gitWorktrees(repoPath);
  if (!entries.length) return [];
  const main = entries[0];
  const baseRef = main.branch || main.head;
  const baseLabel = main.branch || 'base';
  const headCounts = {};
  for (const e of entries) if (e.head) headCounts[e.head] = (headCounts[e.head] || 0) + 1;

  return Promise.all(entries.map(async (e, i) => {
    const isMain = i === 0;
    const branchRef = e.branch || e.head;
    // Dirty state must be read inside the worktree itself; a pruned/missing
    // worktree dir yields null (unknown) rather than a false "clean".
    const [counts, st] = await Promise.all([
      (!isMain && baseRef && branchRef)
        ? gitP(['rev-list', '--left-right', '--count', `${baseRef}...${branchRef}`], repoPath)
        : Promise.resolve(null),
      gitP(['status', '--porcelain'], e.path),
    ]);
    let ahead = null, behind = null;
    if (counts) { const [b, a] = counts.split(/\s+/).map(Number); behind = b; ahead = a; }
    let dirty = null, dirtyCount = null;
    if (st !== null) { dirtyCount = st ? st.split('\n').filter(Boolean).length : 0; dirty = dirtyCount > 0; }

    const reasons = [];
    if (!isMain && ahead === 0) reasons.push(`no commits beyond ${baseLabel}`);
    if (!isMain && dirty === false && ahead === 0) reasons.push('clean working tree');
    if (!isMain && e.head && headCounts[e.head] > 1) reasons.push('shares commit with another worktree');

    const alloc = allocations[e.path] || null;
    return {
      path: e.path,
      name: basename(e.path),
      branch: e.branch || (e.detached ? '(detached)' : null),
      head: e.head ? e.head.slice(0, 7) : null,
      headFull: e.head || null,
      isMain,
      locked: !!e.locked,
      ahead, behind, dirty, dirtyCount,
      stale: !isMain && ahead === 0 && dirty === false,
      staleReasons: reasons,
      ports: alloc ? { backend: alloc.backend, frontend: alloc.frontend, hostname: alloc.hostname } : null,
    };
  }));
}

// Build the worktree-name -> task id maps for a project. Live claims
// (claimed_by_session is "<worktree-name>-<timestamp>") win; the durable
// env.worktree record fills in after release so the association outlives the
// claim, like the worktrees/sessions themselves do.
function taskIdMaps(proj) {
  const claimMap = {};
  const recordMap = {};
  try {
    for (const t of loadTasks(join(proj.path, '_tasks'))) {
      const fm = t.frontmatter || {};
      const id = fm.id;
      if (id == null) continue;
      const sess = fm.env && fm.env.claimed_by_session;
      if (sess) claimMap[String(sess).replace(/-\d+$/, '')] = id;
      const wt = fm.env && fm.env.worktree;
      if (wt) recordMap[wt] = id; // later (higher) task ids overwrite — most recent wins
    }
  } catch {}
  return { claimMap, recordMap };
}

// Top-level: enumerate worktrees for a project, spanning all clones of a
// collapsed multi-clone (planet) project and tagging each with its clone name.
async function worktreesForProject(proj) {
  const allocations = loadPortAllocations();
  const { claimMap, recordMap } = taskIdMaps(proj);
  const clonePaths = proj.clones && proj.clones.length ? proj.clones : [proj.path];
  const perClone = await Promise.all(clonePaths.map(async (cp) => {
    const cloneLabel = clonePaths.length > 1 ? basename(cp) : null;
    const wts = await computeWorktrees(cp, allocations);
    return wts.map((wt) => ({
      ...wt,
      clone: cloneLabel,
      claimedByTaskId: claimMap[wt.name] != null ? claimMap[wt.name] : (recordMap[wt.name] != null ? recordMap[wt.name] : null),
      claimLive: claimMap[wt.name] != null,
    }));
  }));
  return perClone.flat();
}

// Every real checkout dir of a project (spanning clones). The validation set for
// any caller-supplied `worktree=` param — git must never run in an arbitrary cwd.
function projectWorktreePaths(proj) {
  const clonePaths = proj.clones && proj.clones.length ? proj.clones : [proj.path];
  const out = new Set();
  for (const cp of clonePaths) for (const e of gitWorktrees(cp)) out.add(e.path);
  return out;
}

export { loadPortAllocations, gitWorktrees, computeWorktrees, worktreesForProject, projectWorktreePaths };
