// test/branches-task-link.test.mjs — the Branches view's branch → task link
// follows the task files, not only the refs (task 181).
//
// GET /api/branches caches its git work on a signal of the ref tips + worktree
// list. A branch linked to its task only by the task's `slug` (or recorded
// `env.branch`) used to keep its old link until some ref moved, because task
// files are not in that signal. The link is now recomputed per request.
//
// COGYARD_HOME is redirected to a throwaway dir BEFORE importing anything, so
// this never touches the real ~/.cogyard.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-branches-link-'));
process.env.COGYARD_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

const REPO = join(HOME, 'proj');
const git = (...args) => execFileSync('git', ['-C', REPO, '-c', 'core.hooksPath=/dev/null', ...args], {
  stdio: 'ignore',
  env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'a@b.c' },
});

mkdirSync(join(REPO, '.cogyard', 'tasks'), { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
writeFileSync(join(REPO, 'a.txt'), 'a\n');
git('add', 'a.txt');
git('commit', '-q', '-m', 'init');
// No [#NN] tag in its tip, no NNN- prefix: only a task's slug can link it.
git('branch', 'shiny-widget');

const { gitBranches } = await import('../server/git.mjs');
const linkOf = (res) => res.branches.find((b) => b.name === 'shiny-widget')?.taskId ?? null;

test('a task added after the first request links its branch on the next one, with no ref moving', async () => {
  const first = await gitBranches(REPO);
  assert.equal(linkOf(first), null);

  writeFileSync(join(REPO, '.cogyard', 'tasks', '007-shiny-widget.md'), '---\nid: 7\nslug: shiny-widget\nstatus: OPEN\n---\n# shiny\n');
  const second = await gitBranches(REPO);
  assert.equal(linkOf(second), '7');

  // The cached git work is reused, not mutated: the earlier answer is untouched.
  assert.equal(linkOf(first), null);
});

test('removing the task drops the link again', async () => {
  rmSync(join(REPO, '.cogyard', 'tasks', '007-shiny-widget.md'));
  assert.equal(linkOf(await gitBranches(REPO)), null);
});
