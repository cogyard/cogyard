// core/reclaim.mjs — what is sitting around reclaimable, across every
// registered project (task 117).
//
// Two things live here:
//
//   1. The regenerable-dir sizing that `cogyard tasks cleanup` has always done.
//      It was inline in cli/tasks.mjs; the portal cannot import from cli/ and
//      server/ owns no data logic, so it moved here and the CLI now calls the
//      same code. Behaviour is unchanged — same dir names, same -prune walk,
//      same `du -sk`.
//
//   2. The join that existed nowhere: disposable-dir SIZE alongside the
//      sessions-audit VERDICT, for every project at once. `tasks cleanup` knew
//      the megabytes but not the lock state; `sessions audit --all` knew the
//      verdicts but not the size and only for one repo. Neither could answer
//      "what is the biggest safe win", which is the whole question the portal
//      surface exists to answer.
//
// READ-ONLY. Nothing here removes anything — `reclaimDisk` in the CLI and the
// portal's own gated routes do the deleting, both off this module's report.

import { execSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { readRegistry } from './registry.mjs';
import { worktreesForProject } from './worktrees.mjs';
import { allWorktreeCandidates } from './sessions-audit.mjs';
import { findRepoRoot } from './exec.mjs';

// Build/install output that is heavy and 100% regenerable. Matched by name at
// ANY depth (root, frontend/, extras/desktop/…) so workspaces and sub-packages
// are all caught — `node_modules` (install; desktop's holds the ~250 MB Electron
// binary), `dist`/`.angular`/`out-tsc`/`coverage` (build + cache), `release`
// (electron-builder's packaged .app/dmg). NOT a "delete everything gitignored"
// sweep — that net also catches *.local.md private notes and the task-store link,
// which are irreplaceable. Names only; never files.
const DISPOSABLE_DIRS = ['node_modules', 'dist', '.angular', 'out-tsc', 'coverage', 'release'];

function dirSizeKb(p) {
  try { return parseInt(execSync(`du -sk ${JSON.stringify(p)}`).toString().trim().split(/\s+/)[0], 10) || 0; }
  catch { return 0; }
}

// `-prune` stops find descending INTO a match, so a package's own dist inside
// node_modules is never separately listed — each top-level disposable dir is
// returned once, and we don't walk the tens of thousands of files inside.
function findDisposable(root) {
  const names = DISPOSABLE_DIRS.map((n) => `-name ${JSON.stringify(n)}`).join(' -o ');
  try {
    const out = execSync(`find ${JSON.stringify(root)} -type d \\( ${names} \\) -prune`, { maxBuffer: 64 * 1024 * 1024 }).toString().trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch { return []; }
}

// Eligibility for reclaiming DISK from a worktree. "Nothing unique left to
// lose", NOT a task-status lookup (a task can span several worktrees, so the
// worktree→task map is unreliable): STALE means fully merged into the base
// branch (ahead === 0) AND a clean working tree. That alone proves every file
// is already in the base branch, and it protects in-flight work for free.
//
// Hard exclusions, in order: the main checkout (never stale, and the portal
// builds from it), the ACTIVE checkout (don't yank deps from a live build), and
// any worktree with a live claim (a session is holding it).
function diskEligible(wt, activeRoot) {
  if (wt.isMain) return { ok: false, why: 'main checkout' };
  if (activeRoot && resolve(wt.path) === activeRoot) return { ok: false, why: 'active checkout' };
  if (wt.claimLive) return { ok: false, why: 'live claim' };
  if (!wt.stale) return { ok: false, why: wt.dirty ? 'uncommitted changes' : 'commits not on the base branch' };
  return { ok: true, why: null };
}

// One project's reclaimable state: every non-main worktree, with its disposable
// dirs + size, and the sessions-audit verdict when the repo could be read.
//
// `sizes: false` skips the `du`/`find` walk — it is the expensive half (a `du`
// per disposable dir over four projects takes seconds), so callers that only
// want verdicts and counts can opt out.
async function projectReclaim(proj, { activeRoot = null, sizes = true } = {}) {
  const row = { slug: proj.slug, label: proj.label, worktrees: [], diskKb: 0, heldKb: 0, removableCount: 0, error: null };

  let wts;
  try { wts = await worktreesForProject(proj); }
  catch (e) { row.error = String((e && e.message) || e); return row; }

  // Verdicts come from the existing ladder, keyed by worktree path so the join
  // can't drift on name collisions across a multi-clone project.
  const verdicts = new Map();
  try {
    for (const c of (await allWorktreeCandidates(proj.path)).rows) verdicts.set(resolve(c.worktree.path), c);
  } catch { /* unreadable repo — rows just carry no verdict */ }

  for (const wt of wts) {
    if (wt.isMain) continue;
    const elig = diskEligible(wt, activeRoot);
    // Size EVERY worktree, not just the eligible ones. The CLI only ever needed
    // the cleanable set, but this report feeds a visibility surface: a dirty
    // worktree sitting on 1.3 GB is exactly what needs to be seen, and
    // reporting it as "—" hides the single biggest thing on the page (observed:
    // a project holding 1337 MB with zero removable worktrees).
    const dirs = sizes ? findDisposable(wt.path) : [];
    const kb = dirs.reduce((s, d) => s + dirSizeKb(d), 0);
    const v = verdicts.get(resolve(wt.path)) || null;

    // Reclaimable and held are kept apart at every level. Summing them would
    // promise disk that cannot be taken without dealing with the blocker first.
    if (elig.ok) row.diskKb += kb; else row.heldKb += kb;
    if (v && v.verdict === 'REMOVABLE') row.removableCount += 1;

    row.worktrees.push({
      name: wt.name,
      path: wt.path,
      branch: wt.branch,
      taskId: wt.claimedByTaskId,
      claimLive: wt.claimLive,
      // Disk axis — what a build would recreate.
      diskKb: kb,
      diskDirs: dirs.map((d) => ({ path: d, name: basename(d) })),
      diskEligible: elig.ok,
      diskBlockedBy: elig.why,
      // Git-state axis — the verdict ladder, untouched (task 117 adds no new
      // safety logic; `out_of_scope` forbids a second model).
      verdict: v ? v.verdict : null,
      verdictDetail: v ? v.detail : null,
      removeCmd: v ? v.removeCmd : null,
      undoCmd: v ? v.undoCmd : null,
    });
  }
  return row;
}

// The cross-project report the portal renders and `tasks cleanup` sizes from.
// Every registered project, or one when `slug` is given.
async function reclaimReport({ slug = null, sizes = true, cwd = null } = {}) {
  const all = readRegistry();
  const projects = slug ? all.filter((p) => p.slug === slug) : all;
  // The active checkout is never offered for disk reclaim — resolved once here
  // rather than per project so the exclusion is consistent across the report.
  const repoRoot = findRepoRoot(cwd || process.cwd());
  const activeRoot = repoRoot ? resolve(repoRoot) : null;

  const rows = await Promise.all(projects.map((p) => projectReclaim(p, { activeRoot, sizes })));
  return {
    projects: rows,
    totalDiskKb: rows.reduce((s, r) => s + r.diskKb, 0),
    totalHeldKb: rows.reduce((s, r) => s + r.heldKb, 0),
    totalRemovable: rows.reduce((s, r) => s + r.removableCount, 0),
  };
}

export { DISPOSABLE_DIRS, dirSizeKb, findDisposable, diskEligible, projectReclaim, reclaimReport };
