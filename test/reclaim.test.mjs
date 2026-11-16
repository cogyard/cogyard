// test/reclaim.test.mjs — task 117: the disk-eligibility rule.
//
// The report itself walks live git + `du`, so it's exercised against this
// machine's real backlog (the task file's verify loop). What belongs HERE is
// the pure decision that guards every deletion: which worktrees may have their
// regenerable dirs reclaimed. Getting this wrong deletes node_modules out from
// under a running build, or — worse — treats a dirty checkout as disposable.
//
// The rule is deliberately "nothing unique left to lose": merged AND clean.
// Not a task-status lookup, because a task can span several worktrees.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { diskEligible, DISPOSABLE_DIRS } = await import('../core/reclaim.mjs');

// A stale (merged + clean) worktree that is not the main checkout and is
// unclaimed — the only shape that may be reclaimed.
const ok = { path: '/repo/.claude/worktrees/task-1', isMain: false, stale: true, dirty: false, claimLive: false };

test('stale, unclaimed, non-main worktree is eligible', () => {
  assert.deepEqual(diskEligible(ok, '/repo/.claude/worktrees/other'), { ok: true, why: null });
});

test('the main checkout is never eligible', () => {
  // Never stale by construction, but the guard must not depend on that: the
  // portal builds from main, so it is excluded on identity.
  const r = diskEligible({ ...ok, isMain: true, stale: true }, null);
  assert.equal(r.ok, false);
  assert.equal(r.why, 'main checkout');
});

test('the active checkout is never eligible, even when stale', () => {
  // Yanking node_modules out of the checkout running the build is the failure
  // this exists to prevent. Compared by resolved path, not by name.
  const r = diskEligible(ok, '/repo/.claude/worktrees/task-1');
  assert.equal(r.ok, false);
  assert.equal(r.why, 'active checkout');
});

test('a live claim blocks reclaim — a session is holding the worktree', () => {
  const r = diskEligible({ ...ok, claimLive: true }, null);
  assert.equal(r.ok, false);
  assert.equal(r.why, 'live claim');
});

test('uncommitted changes block reclaim, and the reason says so', () => {
  const r = diskEligible({ ...ok, stale: false, dirty: true }, null);
  assert.equal(r.ok, false);
  assert.equal(r.why, 'uncommitted changes');
});

test('unmerged commits block reclaim, distinctly from dirty', () => {
  const r = diskEligible({ ...ok, stale: false, dirty: false }, null);
  assert.equal(r.ok, false);
  assert.equal(r.why, 'commits not on the base branch');
});

test('exclusions are ordered by blast radius — main wins over every other reason', () => {
  // A worktree can trip several rules at once; the reported reason must be the
  // most fundamental one, so the UI never says "uncommitted changes" about the
  // main checkout.
  const r = diskEligible({ ...ok, isMain: true, claimLive: true, stale: false, dirty: true }, ok.path);
  assert.equal(r.why, 'main checkout');
});

test('the disposable list is names-only and holds no irreplaceable entries', () => {
  // A "delete everything gitignored" net would catch *.local.md private notes
  // and the _tasks symlink. This list must stay a closed set of regenerable
  // BUILD/INSTALL dir names — no globs, no paths, no dotfiles beyond .angular.
  assert.deepEqual(DISPOSABLE_DIRS, ['node_modules', 'dist', '.angular', 'out-tsc', 'coverage', 'release']);
  for (const n of DISPOSABLE_DIRS) {
    assert.ok(!n.includes('/'), `${n} must be a bare name, not a path`);
    assert.ok(!n.includes('*'), `${n} must not be a glob`);
  }
});
