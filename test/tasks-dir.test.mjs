// Tests for where a project's task directory is read from (tasks 160 and 183).
//
// The link to a project's shared task store is `.cogyard/tasks`. The old
// top-level `_tasks` name is not read anywhere any more (task 183 removed that
// fallback): a project with only `_tasks` has no task directory as far as
// cogyard is concerned. The resolver is tested directly, then through the
// readers that act on it: `cogyard tasks find` (the CLI's lookup, run as a real
// process inside a real git repo) and the store containment the `/api/axes` and
// open-file writes use.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateTasksDir, tasksDirOf, oldTasksDir, oldTasksDirProblem, TASKS_DIR } from '../core/tasks-dir.mjs';
import { findTaskFile } from '../cli/tasks.mjs';
import { assertInStore } from '../server/http.mjs';

const TASKS_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');

let ROOT;

function writeTask(store, file, id) {
  writeFileSync(join(store, file), `---\nid: ${id}\nslug: s${id}\ntitle: t\nstatus: OPEN\ntype: bug\n---\n\n# ${id}\n`);
}

// A store outside the project, holding one task file named after the store so a
// lookup's answer says which link it went through.
function makeStore(name) {
  const store = join(ROOT, 'stores', name);
  mkdirSync(store, { recursive: true });
  writeTask(store, `001-from-${name}.md`, 1);
  return store;
}

function makeProject(name, { current, old } = {}) {
  const project = join(ROOT, name);
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  if (current) {
    mkdirSync(join(project, '.cogyard'), { recursive: true });
    symlinkSync(current, join(project, TASKS_DIR));
  }
  if (old) symlinkSync(old, join(project, '_tasks'));
  return project;
}

function cliFind(project, id) {
  const r = spawnSync('node', [TASKS_CLI, 'find', String(id)], { cwd: project, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

before(() => { ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-tasksdir-'))); });
after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

// --- the resolver ------------------------------------------------------------

test('no link → null, and tasksDirOf names .cogyard/tasks', () => {
  const dir = join(ROOT, 'bare');
  mkdirSync(dir);
  assert.equal(locateTasksDir(dir), null);
  assert.equal(tasksDirOf(dir), join(dir, '.cogyard', 'tasks'));
});

test('.cogyard/tasks → that link', () => {
  const p = makeProject('r-new', { current: makeStore('r-new') });
  assert.deepEqual(locateTasksDir(p), { path: join(p, '.cogyard', 'tasks') });
});

test('an old _tasks link alone is not read', () => {
  const p = makeProject('r-old', { old: makeStore('r-old') });
  assert.equal(locateTasksDir(p), null);
});

test('both → .cogyard/tasks; the old link is ignored', () => {
  const p = makeProject('r-both', { current: makeStore('r-both-new'), old: makeStore('r-both-old') });
  assert.deepEqual(locateTasksDir(p), { path: join(p, '.cogyard', 'tasks') });
});

test('a BROKEN link is still the task directory (reported as broken, not skipped)', () => {
  const p = makeProject('r-broken');
  mkdirSync(join(p, '.cogyard'));
  symlinkSync(join(ROOT, 'stores', 'does-not-exist'), join(p, TASKS_DIR));
  assert.equal(locateTasksDir(p).path, join(p, '.cogyard', 'tasks'));
});

// --- a leftover _tasks is named, never read ------------------------------------

test('oldTasksDir: an old _tasks link alone → named as a link, with its target', () => {
  const store = makeStore('o-link');
  const p = makeProject('o-link', { old: store });
  assert.deepEqual(oldTasksDir(p), { path: join(p, '_tasks'), kind: 'link', target: store });
  assert.match(oldTasksDirProblem(oldTasksDir(p)), /old task link _tasks → .*link \.cogyard\/tasks to the same target/);
});

test('oldTasksDir: an in-repo _tasks folder → named as a folder, fixed by convert', () => {
  const p = makeProject('o-folder');
  mkdirSync(join(p, '_tasks'));
  assert.deepEqual(oldTasksDir(p), { path: join(p, '_tasks'), kind: 'folder', target: null });
  assert.match(oldTasksDirProblem(oldTasksDir(p)), /old task folder _tasks\/.*cogyard tasks convert/);
});

test('oldTasksDir: null when .cogyard/tasks exists, or when there is no _tasks', () => {
  assert.equal(oldTasksDir(makeProject('o-both', { current: makeStore('o-both-new'), old: makeStore('o-both-old') })), null);
  assert.equal(oldTasksDir(makeProject('o-none')), null);
});

// discoverProjects reads the registry under COGYARD_HOME at import, so it runs in
// a child process with a home of its own.
function discoverIn(home) {
  const r = spawnSync('node', ['--input-type=module', '-e',
    "import { discoverProjects } from './core/registry.mjs'; process.stdout.write(JSON.stringify(discoverProjects()));"],
  { cwd: join(dirname(TASKS_CLI), '..'), env: { ...process.env, COGYARD_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('discoverProjects: a project on an old _tasks link or folder is an error row, not dropped', () => {
  const home = join(ROOT, 'home-discover');
  mkdirSync(home);
  const link = makeProject('d-link', { old: makeStore('d-link') });
  const folder = makeProject('d-folder');
  mkdirSync(join(folder, '_tasks'));
  const none = makeProject('d-none');
  writeFileSync(join(home, 'projects.json'), JSON.stringify([
    { slug: 'd-link', path: link, label: 'd-link' },
    { slug: 'd-folder', path: folder, label: 'd-folder' },
    { slug: 'd-none', path: none, label: 'd-none' },
  ]));
  const rows = discoverIn(home);
  assert.deepEqual(rows.map((r) => r.slug), ['d-folder', 'd-link'], 'the project with no _tasks at all is still dropped');
  assert.match(rows.find((r) => r.slug === 'd-link').error, /old task link _tasks/);
  assert.match(rows.find((r) => r.slug === 'd-folder').error, /old task folder _tasks\/.*cogyard tasks convert/);
});

test('tasks doctor: a project on an old _tasks link has LINK missing and its row names the old link', () => {
  const home = join(ROOT, 'home-tdoctor');
  mkdirSync(home);
  const p = makeProject('t-link', { old: makeStore('t-link') });
  writeFileSync(join(home, 'projects.json'), JSON.stringify([{ slug: 't-link', path: p, label: 't-link' }]));
  const r = spawnSync('node', [TASKS_CLI, 'doctor'], { cwd: p, env: { ...process.env, COGYARD_HOME: home }, encoding: 'utf8' });
  const row = (r.stdout || '').split('\n').find((l) => l.startsWith('t-link'));
  assert.ok(row, r.stdout + r.stderr);
  assert.match(row, /^t-link\s+missing\s/);
  assert.match(row, /no task directory/);
  assert.match(row, /old task link _tasks → .*stores\/t-link/);
});

// The folder's problem line names `cogyard tasks convert` as the fix, so that has
// to actually work on what an older release left: a tracked `_tasks/` folder.
test('convert moves an old tracked _tasks folder into a store, after which find works', () => {
  const home = join(ROOT, 'home-convert');
  mkdirSync(home);
  const p = makeProject('v-folder');
  mkdirSync(join(p, '_tasks'));
  writeTask(join(p, '_tasks'), '001-tracked.md', 1);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: p });
  git('add', '_tasks');
  git('commit', '-qm', 'tracked tasks');
  writeFileSync(join(home, 'projects.json'), JSON.stringify([{ slug: 'v-folder', path: p, label: 'v-folder' }]));
  const env = { ...process.env, COGYARD_HOME: home, COGYARD_PROJECTS_ROOT: ROOT, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const conv = spawnSync('node', [TASKS_CLI, 'convert'], { cwd: p, env, encoding: 'utf8' });
  assert.equal(conv.status, 0, conv.stderr + conv.stdout);
  assert.equal(oldTasksDir(p), null, 'the old folder is gone and .cogyard/tasks is in place');
  const r = spawnSync('node', [TASKS_CLI, 'find', '1'], { cwd: p, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /001-tracked\.md$/);
});

// --- readers: `cogyard tasks find` --------------------------------------------

test('find: through .cogyard/tasks → the store file', () => {
  const store = makeStore('f-new');
  const p = makeProject('f-new', { current: store });
  const r = cliFind(p, 1);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, join(store, '001-from-f-new.md'));
});

test('find: an old _tasks link alone → fails, naming .cogyard/tasks', () => {
  const p = makeProject('f-old', { old: makeStore('f-old') });
  const r = cliFind(p, 1);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /\.cogyard\/tasks/);
});

test('find: both links at DIFFERENT stores → the .cogyard/tasks store', () => {
  const p = makeProject('f-both', { current: makeStore('f-both-new'), old: makeStore('f-both-old') });
  assert.equal(findTaskFile(p, 1), join(ROOT, 'stores', 'f-both-new', '001-from-f-both-new.md'));
});

// --- readers: store containment (the /api/axes + open-file writes) -----------

test('assertInStore resolves through .cogyard/tasks and never through _tasks', () => {
  const sNew = makeStore('c-new');
  assert.equal(assertInStore(makeProject('c-new', { current: sNew })), join(sNew, 'axes.json'));
  const pBoth = makeProject('c-both', { current: makeStore('c-both-new'), old: makeStore('c-both-old') });
  assert.equal(assertInStore(pBoth, '.'), join(ROOT, 'stores', 'c-both-new'));
});
