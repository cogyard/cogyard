// Tests for which task a worktree is linked to (core/worktrees.mjs
// worktreesForProject, task 180). A live claim links a worktree; after release
// the task's env.worktree record keeps the link — except on the main checkout,
// where every task ever worked or filed on main records the main folder's name.
// Integration-style: a throwaway git repo with one linked worktree and a
// .cogyard/tasks/ dir whose files are rewritten per case.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ROOT, REPO, TASKS;
let worktreesForProject;

const git = (args) => execFileSync('git', ['-C', REPO, ...args], {
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'a@b.c' },
}).trim();

// One task file. `session` set = a live claim, as `env claim` writes it: a
// session UUID plus the worktree it was claimed from.
const task = (id, { worktree = null, session = null } = {}) => writeFileSync(join(TASKS, `${String(id).padStart(3, '0')}-t.md`), [
  '---',
  `id: ${id}`,
  'slug: t',
  'title: t',
  'status: OPEN',
  'type: bug',
  'env:',
  `  worktree: ${worktree || 'null'}`,
  `  claimed_at: ${session ? '2026-10-06T00:00:00.000Z' : 'null'}`,
  `  claimed_by_session: ${session || 'null'}`,
  '---',
  '',
  `# ${id}`,
  '',
].join('\n'));

const links = async () => {
  const out = {};
  for (const w of await worktreesForProject({ slug: 'fixture', label: 'fixture', path: REPO })) {
    out[w.isMain ? 'main' : w.name] = { taskId: w.claimedByTaskId, live: w.claimLive };
  }
  return out;
};

before(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'cogyard-wtlink-'));
  // Keep worktreesForProject off the real ~/.cogyard (port allocations).
  process.env.COGYARD_HOME = join(ROOT, 'home');
  ({ worktreesForProject } = await import('../core/worktrees.mjs'));

  REPO = join(ROOT, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
  git(['commit', '-q', '--allow-empty', '-m', 'm1']);
  git(['worktree', 'add', '-q', '-b', 'feature', join(ROOT, 'feature')]);
});
after(() => { rmSync(ROOT, { recursive: true, force: true }); });

const reset = () => {
  TASKS = join(REPO, '.cogyard', 'tasks');
  rmSync(TASKS, { recursive: true, force: true });
  mkdirSync(TASKS, { recursive: true });
};

test('the main checkout does not inherit a task that only records it', async () => {
  reset();
  task(1, { worktree: 'repo' });
  task(2, { worktree: 'repo' });
  const l = await links();
  assert.deepEqual(l.main, { taskId: null, live: false });
});

test('a released task still links its own feature worktree', async () => {
  reset();
  task(3, { worktree: 'feature' });
  const l = await links();
  assert.deepEqual(l.feature, { taskId: 3, live: false });
});

test('a live claim on main links main', async () => {
  reset();
  task(1, { worktree: 'repo' });
  task(4, { worktree: 'repo', session: '11111111-2222-4333-8444-555555555555' });
  const l = await links();
  assert.deepEqual(l.main, { taskId: 4, live: true });
});

test('a claim holding a session UUID reads as live on its worktree', async () => {
  reset();
  task(5, { worktree: 'feature', session: '11111111-2222-4333-8444-555555555555' });
  const l = await links();
  assert.deepEqual(l.feature, { taskId: 5, live: true });
});

test('a live claim beats a higher-numbered task that only records the worktree', async () => {
  reset();
  task(6, { worktree: 'feature', session: '66666666-7777-4888-9999-aaaaaaaaaaaa' });
  task(7, { worktree: 'feature' });
  const l = await links();
  assert.deepEqual(l.feature, { taskId: 6, live: true });
});

test('an old-style "<worktree>-<timestamp>" session still reads as live', async () => {
  reset();
  task(8, { session: 'feature-1751234567' });
  const l = await links();
  assert.deepEqual(l.feature, { taskId: 8, live: true });
});
