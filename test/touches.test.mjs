// `cogyard tasks touches` (task 239): keeping a task's touches_paths true, so
// the plan's parallel check (`clash`) can be relied on. Unit tests over the
// pure helpers, then the CLI end to end on a throwaway local-only store.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTouchesPaths, outsideList, runningClashesFor } from '../core/touches.mjs';
import { parseFrontmatter } from '../core/frontmatter.mjs';

const fmOf = (text) => parseFrontmatter(text.slice(4, text.indexOf('\n---\n', 4)));

test('addTouchesPaths: adds to a block list, keeping every other line as written', () => {
  const t = '---\nid: 1\ntouches_paths:\n  - a.js\n  - lib/\ncommit_policy: per-phase\n---\n\n# body\n';
  const { text, added } = addTouchesPaths(t, ['b.js', 'lib/x.js', 'a.js']);
  assert.deepEqual(added, ['b.js'], 'a.js is listed and lib/x.js is under lib/');
  assert.deepEqual(fmOf(text).touches_paths, ['a.js', 'lib/', 'b.js']);
  assert.match(text, /commit_policy: per-phase\n---\n\n# body\n$/);
});

test('addTouchesPaths: an inline list or [] becomes a block list; a missing field is added after related', () => {
  assert.deepEqual(fmOf(addTouchesPaths('---\nid: 1\ntouches_paths: [a.js, "b.js"]\n---\n', ['c.js']).text).touches_paths, ['a.js', 'b.js', 'c.js']);
  assert.deepEqual(fmOf(addTouchesPaths('---\nid: 1\ntouches_paths: []\n---\n', ['c.js']).text).touches_paths, ['c.js']);
  const r = addTouchesPaths('---\nid: 1\nrelated: []\nenv:\n  branch: null\n---\n', ['c.js']);
  assert.match(r.text, /related: \[\]\ntouches_paths:\n  - c\.js\nenv:/);
});

test('addTouchesPaths: nothing new leaves the text exactly as it was', () => {
  const t = '---\nid: 1\ntouches_paths:\n  - a.js\n---\n';
  assert.deepEqual(addTouchesPaths(t, ['a.js']), { text: t, added: [] });
});

test('outsideList: changed files the list does not cover, Markdown left out', () => {
  assert.deepEqual(outsideList({
    changed: ['a.js', 'lib/x.js', 'docs/A.md', 'publish/manifest.txt', 'core/index.mjs'],
    touches: ['a.js', 'lib/'],
  }), ['publish/manifest.txt', 'core/index.mjs']);
});

test('runningClashesFor: only tasks in progress, only the paths asked about', () => {
  const plan = {
    groups: { progress: ['2', '1'] },
    tasks: { 1: { clash: [{ id: '2', files: ['a.js', 'b.js'], resources: [] }, { id: '3', files: ['c.js'], resources: [] }] } },
  };
  assert.deepEqual(runningClashesFor(plan, '1', ['b.js']), [{ id: '2', files: ['b.js'] }]);
  assert.deepEqual(runningClashesFor(plan, '1', ['c.js']), [], '3 is not in progress');
  assert.deepEqual(runningClashesFor(plan, '1', ['z.js']), []);
});

// --- the CLI, end to end -------------------------------------------------------
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function task(store, id, paths, claimed) {
  const file = join(store, `00${id}-t${id}.md`);
  writeFileSync(file, [
    '---', `id: ${id}`, `slug: t${id}`, `title: t${id}`, 'status: OPEN', 'type: bug', 'done_date: null',
    'depends_on: []', 'related: []', 'touches_paths:', ...paths.map((p) => `  - ${p}`),
    'env:', `  branch: ${claimed ? `task-${id}` : 'null'}`,
    `  claimed_at: ${claimed ? '2026-11-01T00:00:00.000Z' : 'null'}`, `  claimed_by: ${claimed ? 'Tester' : 'null'}`,
    '---', '', `# ${id}`, '', '- [ ] work', '',
  ].join('\n'));
  return file;
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-touches-')));
  dirs.push(root);
  const store = join(root, 'store'), repo = join(root, 'repo'), home = join(root, 'home');
  mkdirSync(store); mkdirSync(repo); mkdirSync(home);
  for (const d of [store, repo]) {
    git(d, ['init', '-q', '-b', 'main']);
    git(d, ['config', 'user.email', 'test@example.com']);
    git(d, ['config', 'user.name', 'Tester']);
  }
  const files = { mine: task(store, 1, ['a.js'], true), theirs: task(store, 2, ['shared.js'], true), idle: task(store, 3, ['idle.js'], false) };
  git(store, ['add', '-A']); git(store, ['commit', '-qm', 'seed']);
  for (const f of ['a.js', 'shared.js', 'idle.js', 'other.js']) writeFileSync(join(repo, f), '1\n');
  writeFileSync(join(repo, '.gitignore'), '.cogyard/tasks\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'seed']);
  mkdirSync(join(repo, '.cogyard'));
  symlinkSync(store, join(repo, '.cogyard', 'tasks'));
  return { store, repo, home, files };
}
const AGENT_VARS = ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID'];
function cli(fx, sub, ...args) {
  const env = { ...process.env, COGYARD_HOME: fx.home, COGYARD_USER: 'Tester' };
  for (const k of AGENT_VARS) delete env[k];
  return spawnSync('node', [CLI, sub, ...args], { cwd: fx.repo, encoding: 'utf8', env });
}
const touches = (fx, ...args) => cli(fx, 'touches', ...args);
const conflicts = (fx, id) => cli(fx, 'conflicts', String(id));

test('touches --add: a file a task in progress lists → added, committed, named for information, exit 0 (owner 2026-11-13)', () => {
  const fx = fixture();
  const r = touches(fx, '1', '--add', 'shared.js', 'new.js');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /added shared\.js, new\.js/);
  assert.match(r.stdout, /For information[\s\S]*#2: shared\.js/);
  assert.match(r.stdout, /cogyard tasks conflicts 1/);
  assert.deepEqual(fmOf(readFileSync(fx.files.mine, 'utf8')).touches_paths, ['a.js', 'shared.js', 'new.js']);
  assert.equal(git(fx.store, ['status', '--porcelain']), '', 'the edit is committed');
  assert.match(git(fx.store, ['log', '-1', '--format=%s']), /\[#1\] touches: add shared\.js, new\.js/);
});

test('touches --add: a file only an idle task lists, or nobody lists → exit 0', () => {
  const fx = fixture();
  const r = touches(fx, '1', '--add', 'idle.js', 'other.js');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /stop and ask/);
  const again = touches(fx, '1', '--add', 'other.js');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already listed/);
});

test('touches --check: names files the branch changed outside the list, leaving out Markdown', () => {
  const fx = fixture();
  git(fx.repo, ['checkout', '-q', '-b', 'task-1']);
  writeFileSync(join(fx.repo, 'a.js'), '2\n');
  writeFileSync(join(fx.repo, 'other.js'), '2\n');
  writeFileSync(join(fx.repo, 'NOTES.md'), 'x\n');
  git(fx.repo, ['add', '-A']); git(fx.repo, ['commit', '-qm', 'work']);
  const r = touches(fx, '1', '--check');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /other\.js/);
  assert.doesNotMatch(r.stdout, /NOTES\.md|  a\.js/);
  assert.equal(touches(fx, '1', '--add', 'other.js').status, 0);
  assert.equal(touches(fx, '1', '--check').status, 0, 'listed now');
});

// --- conflicts: real dry-run merges --------------------------------------------
// shared.js starts as five lines; each task edits lines on its own branch.
function setLine(repo, n, text) {
  const lines = readFileSync(join(repo, 'shared.js'), 'utf8').split('\n');
  lines[n - 1] = text;
  writeFileSync(join(repo, 'shared.js'), lines.join('\n'));
}
function branchWith(fx, branch, edits, from = 'main') {
  git(fx.repo, ['checkout', '-q', '-B', branch, from]);
  for (const [n, text] of edits) setLine(fx.repo, n, text);
  git(fx.repo, ['commit', '-qam', `${branch} work`]);
  git(fx.repo, ['checkout', '-q', 'main']);
}
function conflictFixture() {
  const fx = fixture();
  writeFileSync(join(fx.repo, 'shared.js'), 'a\nb\nc\nd\ne\n');
  git(fx.repo, ['commit', '-qam', 'five lines']);
  return fx;
}

test('conflicts: same file, different lines → merges cleanly, exit 0', () => {
  const fx = conflictFixture();
  branchWith(fx, 'task-2', [[1, 'A2']]);
  branchWith(fx, 'task-1', [[5, 'E1']]);
  const r = conflicts(fx, 1);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /#2 \(task-2\): merges cleanly/);
  assert.match(r.stdout, /main: merges cleanly/);
});

test('conflicts: the same line on two tasks in progress → exit 1 naming the task and the file', () => {
  const fx = conflictFixture();
  branchWith(fx, 'task-2', [[1, 'A2']]);
  branchWith(fx, 'task-1', [[1, 'A1']]);
  const r = conflicts(fx, 1);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /#2 \(task-2\): CONFLICTS in shared\.js/);
  assert.match(r.stdout, /stop and ask/);
  assert.equal(git(fx.repo, ['status', '--porcelain']), '', 'nothing in the working tree changed');
});

test('conflicts: main moved under the same line → exit 1 naming main', () => {
  const fx = conflictFixture();
  branchWith(fx, 'task-1', [[3, 'C1']]);
  setLine(fx.repo, 3, 'C-main');
  git(fx.repo, ['commit', '-qam', 'main moves']);
  const r = conflicts(fx, 1);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /main: CONFLICTS in shared\.js/);
});

test('conflicts: an idle task is not checked; a recorded branch that is gone is skipped, not a stop', () => {
  const fx = conflictFixture();
  branchWith(fx, 'task-1', [[1, 'A1']]);
  branchWith(fx, 'task-3', [[1, 'A3']]); // task 3 is not claimed — never compared
  const r = conflicts(fx, 1);              // task 2 is claimed, but task-2 doesn't exist
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /#2 \(task-2\): skipped — branch task-2 not found/);
  assert.doesNotMatch(r.stdout, /#3/);
});
