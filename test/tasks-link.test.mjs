// End-to-end tests for what CREATES a project's link to its task store (tasks
// 160 and 183): `cogyard init`, `cogyard tasks convert`, `cogyard tasks join` and
// `cogyard tasks mount`. Each makes `.cogyard/tasks` (ignored by a committed
// `.cogyard/.gitignore`) and must leave the checkout clean, because a stray
// untracked link is exactly what a session then sweeps into a commit. An old
// top-level `_tasks` link is never read; an in-repo `_tasks/` FOLDER is what
// `convert` adopts.
//
// Every command runs as the real CLI process against a throwaway COGYARD_HOME
// and COGYARD_PROJECTS_ROOT, so no real registry or store is touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync,
  lstatSync, readlinkSync, realpathSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COGYARD_CLI = join(HERE, '..', 'cli', 'cogyard.mjs');
const TASKS_CLI = join(HERE, '..', 'cli', 'tasks.mjs');
const ENV_CLI = join(HERE, '..', 'cli', 'env.mjs');

let ROOT, HOME, PROJECTS;

const ID = ['-c', 'user.email=a@b.c', '-c', 'user.name=x'];
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8' }).trim();

function run(cli, args, cwd) {
  const r = spawnSync('node', [cli, ...args], {
    cwd, encoding: 'utf8',
    // No chat id from the agent running the tests: a claim records the running
    // chat's own id over the one passed (task 260), and these pass their own.
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', COGYARD_HOME: HOME, COGYARD_PROJECTS_ROOT: PROJECTS, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'a@b.c' },
  });
  assert.equal(r.status, 0, `${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const status = (cwd) => git(cwd, ['status', '--porcelain', '--untracked-files=all']);

function addWorktree(project, name, branchFrom = 'HEAD') {
  const wt = join(project, '.claude', 'worktrees', name);
  mkdirSync(dirname(wt), { recursive: true });
  git(project, ['worktree', 'add', '-q', '-b', name, wt, branchFrom]);
  return wt;
}

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-tasklink-')));
  HOME = join(ROOT, 'home');
  PROJECTS = join(ROOT, 'projects');
  mkdirSync(HOME, { recursive: true });
  mkdirSync(PROJECTS, { recursive: true });
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

// --- init: a new project gets only the new link -----------------------------

test('init: .cogyard/tasks → the store, no _tasks, ignored by .cogyard/.gitignore, checkout clean', () => {
  const p = join(PROJECTS, 'fresh');
  run(COGYARD_CLI, ['init', p, '--kind', 'fullstack']);
  const link = join(p, '.cogyard', 'tasks');
  assert.ok(isLink(link), '.cogyard/tasks is a link');
  assert.equal(realpathSync(link), realpathSync(join(PROJECTS, '_tasks', 'fresh')));
  assert.equal(existsSync(join(p, '_tasks')), false, 'no top-level _tasks');
  const tracked = git(p, ['ls-files']).split('\n');
  assert.ok(tracked.includes('.cogyard/.gitignore'), '.cogyard/.gitignore is committed');
  assert.match(readFileSync(join(p, '.cogyard', '.gitignore'), 'utf8'), /^\/tasks$/m);
  assert.doesNotMatch(readFileSync(join(p, '.gitignore'), 'utf8'), /^_tasks\/?$/m, 'root .gitignore gains no _tasks line');
  assert.equal(status(p), '');
});

test('init project: next-id, claim, release and sync push work through .cogyard/tasks alone', () => {
  const p = join(PROJECTS, 'fresh');
  const r = JSON.parse(run(TASKS_CLI, ['next-id', 'first-task'], p));
  assert.equal(r.file, join(realpathSync(join(PROJECTS, '_tasks', 'fresh')), '001-first-task.md'));
  writeFileSync(r.file, '---\nid: 1\nslug: first-task\ntitle: First\nstatus: OPEN\ntype: bug\nenv:\n  claimed_at: null\n  claimed_by: null\n  claimed_by_session: null\n---\n\n# 1\n');
  assert.equal(run(TASKS_CLI, ['find', '1'], p).trim(), r.file);
  run(ENV_CLI, ['claim', r.file, 'sess-1'], p);
  // Task 190: the session is this machine's record (claims.json), not the file's.
  assert.equal(JSON.parse(run(ENV_CLI, ['where', r.file], p)).session, 'sess-1');
  assert.doesNotMatch(readFileSync(r.file, 'utf8'), /sess-1/);
  run(ENV_CLI, ['release', r.file], p);
  assert.equal(JSON.parse(run(ENV_CLI, ['where', r.file], p)).session, null);
  const store = realpathSync(join(PROJECTS, '_tasks', 'fresh'));
  // Claim and release commit themselves on a local-only store too (task 222).
  assert.deepEqual(git(store, ['log', '-2', '--format=%s']).split('\n').map((s) => s.split(' ')[0]), ['release', 'claim']);
  writeFileSync(r.file, readFileSync(r.file, 'utf8') + '\nmore\n');
  run(TASKS_CLI, ['sync', 'push', 'add first task', '--', r.file], p);
  assert.match(git(store, ['log', '-1', '--format=%s']), /add first task/);
  assert.match(git(store, ['ls-files']), /001-first-task\.md/);
  assert.equal(status(p), '', 'project checkout untouched');
});

// --- mount: worktrees get the new link --------------------------------------

test('mount: a worktree of a new-layout project gets .cogyard/tasks, checkout clean', () => {
  const p = join(PROJECTS, 'fresh');
  const wt = addWorktree(p, 'wt-new');
  run(TASKS_CLI, ['mount'], wt);
  assert.equal(realpathSync(join(wt, '.cogyard', 'tasks')), realpathSync(join(PROJECTS, '_tasks', 'fresh')));
  assert.equal(status(wt), '');
  assert.match(run(TASKS_CLI, ['mount'], wt), /\.cogyard\/tasks already present/);
});

// A project whose main checkout links its store under `linkName`, and whose
// branches have no `.cogyard/.gitignore`.
function linkedProject(name, linkName = '.cogyard/tasks', { relative = false } = {}) {
  const p = join(ROOT, name);
  const store = join(ROOT, 'stores', name);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, '001-linked.md'), '---\nid: 1\nslug: linked\ntitle: L\nstatus: OPEN\ntype: bug\n---\n');
  git(store, ['init', '-q', '-b', 'tasks']);
  git(store, ['add', '.']);
  git(store, ['commit', '-q', '-m', 'import']);
  git(ROOT, ['init', '-q', '-b', 'main', p]);
  git(p, ['commit', '-q', '--allow-empty', '-m', 'init']);
  const link = join(p, linkName);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(relative ? join(...dirname(linkName).split('/').map(() => '..'), '..', 'stores', name) : store, link);
  return { p, store };
}

test('mount: a worktree whose branch predates .cogyard/.gitignore gets the link, and git status stays clean', () => {
  const { p, store } = linkedProject('predates-ignore');
  const wt = addWorktree(p, 'wt-predates');
  run(TASKS_CLI, ['mount'], wt);
  assert.equal(readlinkSync(join(wt, '.cogyard', 'tasks')), store);
  assert.equal(status(wt), '');
  assert.equal(run(TASKS_CLI, ['find', '1'], wt).trim(), join(realpathSync(store), '001-linked.md'));
});

// Task 169: cogyard writes only absolute links, so a relative one in the main
// checkout is refused with the command that replaces it; once replaced, mount works.
test('mount: a RELATIVE base link is refused with the ln command that fixes it; after the fix it mounts', () => {
  const { p, store } = linkedProject('relative-link', '.cogyard/tasks', { relative: true });
  const wt = addWorktree(p, 'wt-rel');
  const r = spawnSync('node', [TASKS_CLI, 'mount'], { cwd: wt, encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME, COGYARD_PROJECTS_ROOT: PROJECTS } });
  assert.notEqual(r.status, 0, 'mount refuses a relative base link');
  assert.match(r.stderr, /is a relative link .*needs an absolute one/);
  const fix = r.stderr.match(/^\s+(ln -sfn .+)$/m)?.[1];
  assert.ok(fix, `the refusal prints an ln command:\n${r.stderr}`);
  execFileSync('sh', ['-c', fix], { cwd: p });
  assert.equal(existsSync(join(wt, '.cogyard', 'tasks')), false, 'nothing mounted by the refusal');
  run(TASKS_CLI, ['mount'], wt);
  assert.equal(realpathSync(join(wt, '.cogyard', 'tasks')), realpathSync(store));
});

test('mount: an old top-level _tasks link in the main checkout is not read — nothing is mounted', () => {
  const { p } = linkedProject('old-link-only', '_tasks');
  const wt = addWorktree(p, 'wt-old');
  assert.match(run(TASKS_CLI, ['mount'], wt), /has no task directory — nothing to mount/);
  assert.equal(existsSync(join(wt, '.cogyard', 'tasks')), false);
});

// --- convert: an in-repo _tasks/ becomes a store + the new link -------------

test('convert: a tracked _tasks/ moves into the store and is replaced by .cogyard/tasks', () => {
  const p = join(ROOT, 'to-convert');
  git(ROOT, ['init', '-q', '-b', 'main', p]);
  mkdirSync(join(p, '_tasks'));
  writeFileSync(join(p, '_tasks', '001-a.md'), 'A\n');
  writeFileSync(join(p, '_tasks', '002-b.md'), 'B\n');
  git(p, ['add', '_tasks']);
  git(p, ['commit', '-q', '-m', 'tasks in repo']);
  writeFileSync(join(p, 'staged.txt'), 'not part of the conversion\n');
  git(p, ['add', 'staged.txt']);
  run(TASKS_CLI, ['convert'], p);
  const store = join(PROJECTS, '_tasks', 'to-convert');
  assert.equal(readlinkSync(join(p, '.cogyard', 'tasks')), store);
  assert.equal(readFileSync(join(store, '001-a.md'), 'utf8'), 'A\n');
  assert.equal(existsSync(join(p, '_tasks')), false);
  const committed = git(p, ['show', '--name-status', '--format=', 'HEAD']);
  assert.match(committed, /^D\t_tasks\/001-a\.md$/m);
  assert.match(committed, /^A\t\.cogyard\/\.gitignore$/m);
  assert.doesNotMatch(committed, /staged\.txt/, 'what the owner had staged is not swept into the conversion commit');
  assert.equal(status(p), 'A  staged.txt');
});

test('convert: with nothing to adopt, an empty store is created and linked', () => {
  const p = join(ROOT, 'nothing-to-adopt');
  git(ROOT, ['init', '-q', '-b', 'main', p]);
  git(p, ['commit', '-q', '--allow-empty', '-m', 'init']);
  run(TASKS_CLI, ['convert'], p);
  const store = join(PROJECTS, '_tasks', 'nothing-to-adopt');
  assert.equal(readlinkSync(join(p, '.cogyard', 'tasks')), store);
  assert.equal(git(store, ['branch', '--show-current']), 'tasks');
  assert.match(git(p, ['show', '--name-status', '--format=', 'HEAD']), /^A\t\.cogyard\/\.gitignore$/m);
  assert.equal(status(p), '');
});

test('convert: an old top-level _tasks LINK is refused with the steps to replace it', () => {
  const { p } = linkedProject('old-link-convert', '_tasks');
  const r = spawnSync('node', [TASKS_CLI, 'convert'], {
    cwd: p, encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME, COGYARD_PROJECTS_ROOT: PROJECTS },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /old-style link/);
  assert.match(r.stderr, /\.cogyard\/tasks/);
  assert.equal(existsSync(join(p, '.cogyard', 'tasks')), false, 'nothing is linked');
});

// Task 169: the repair paths. Each fault is refused with its fix, and the fix
// leads to a healthy store.
const convertRaw = (cwd) => spawnSync('node', [TASKS_CLI, 'convert'], {
  cwd, encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME, COGYARD_PROJECTS_ROOT: PROJECTS },
});

test('convert: a folder at .cogyard/tasks is refused; renamed to _tasks/, it is adopted into a store', () => {
  const p = join(ROOT, 'folder-at-link');
  git(ROOT, ['init', '-q', '-b', 'main', p]);
  mkdirSync(join(p, '.cogyard', 'tasks'), { recursive: true });
  writeFileSync(join(p, '.cogyard', 'tasks', '001-a.md'), 'A\n');
  git(p, ['add', '.']);
  git(p, ['commit', '-q', '-m', 'folder']);
  const r = convertRaw(p);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is a folder, not a link to a task store — rename it to _tasks\//);
  git(p, ['mv', '.cogyard/tasks', '_tasks']);
  git(p, ['commit', '-q', '-m', 'rename']);
  run(TASKS_CLI, ['convert'], p);
  const store = join(PROJECTS, '_tasks', 'folder-at-link');
  assert.equal(readlinkSync(join(p, '.cogyard', 'tasks')), store);
  assert.equal(readFileSync(join(store, '001-a.md'), 'utf8'), 'A\n');
});

test('convert: a link to a missing store is refused, not "nothing to do"; removed, an empty store is made', () => {
  const p = join(ROOT, 'dead-link');
  git(ROOT, ['init', '-q', '-b', 'main', p]);
  git(p, ['commit', '-q', '--allow-empty', '-m', 'init']);
  mkdirSync(join(p, '.cogyard'));
  symlinkSync(join(ROOT, 'gone-store'), join(p, '.cogyard', 'tasks'));
  const r = convertRaw(p);
  assert.notEqual(r.status, 0, 'a dead link is not reported as done');
  assert.match(r.stderr, /which does not exist — the store was moved or deleted/);
  assert.match(r.stderr, /rm \.cogyard\/tasks/);
  rmSync(join(p, '.cogyard', 'tasks'));
  run(TASKS_CLI, ['convert'], p);
  assert.equal(realpathSync(join(p, '.cogyard', 'tasks')), realpathSync(join(PROJECTS, '_tasks', 'dead-link')));
});

test('convert: a dead link whose store sits at the usual place names it; relinked, convert has nothing to do', () => {
  const p = join(ROOT, 'dead-link-usual');
  git(ROOT, ['init', '-q', '-b', 'main', p]);
  git(p, ['commit', '-q', '--allow-empty', '-m', 'init']);
  const usual = join(PROJECTS, '_tasks', 'dead-link-usual');
  mkdirSync(usual, { recursive: true });
  mkdirSync(join(p, '.cogyard'));
  symlinkSync(join(ROOT, 'old-place'), join(p, '.cogyard', 'tasks'));
  const r = convertRaw(p);
  assert.notEqual(r.status, 0);
  const fix = r.stderr.match(/(ln -sfn .+? \.cogyard\/tasks)$/m)?.[1];
  assert.ok(fix && fix.includes(usual), `names the usual store with its ln command:\n${r.stderr}`);
  execFileSync('sh', ['-c', fix], { cwd: p });
  assert.match(run(TASKS_CLI, ['convert'], p), /Nothing to do/);
});

// --- join: a team member's fresh clone gets the new link --------------------

test('join: a fresh clone gets .cogyard/tasks → the cloned store', () => {
  const remote = join(ROOT, 'remote-store.git');
  const seed = join(ROOT, 'seed-store');
  mkdirSync(seed);
  writeFileSync(join(seed, '001-shared.md'), 'S\n');
  git(seed, ['init', '-q', '-b', 'tasks']);
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  const p = join(ROOT, 'member-clone');
  git(ROOT, ['init', '-q', '-b', 'main', p]);
  git(p, ['commit', '-q', '--allow-empty', '-m', 'init']);
  run(TASKS_CLI, ['join', remote, '--slug', 'member'], p);
  const link = join(p, '.cogyard', 'tasks');
  assert.equal(readlinkSync(link), join(PROJECTS, '_tasks', 'member'));
  assert.equal(readFileSync(join(link, '001-shared.md'), 'utf8'), 'S\n');
  assert.equal(existsSync(join(p, '_tasks')), false);
  assert.match(readFileSync(join(p, '.cogyard', '.gitignore'), 'utf8'), /^\/tasks$/m);
  // The member's own repo shows only the new ignore file (theirs to commit), never the link.
  assert.equal(status(p), '?? .cogyard/.gitignore');
});
