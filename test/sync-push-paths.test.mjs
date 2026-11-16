// test/sync-push-paths.test.mjs — how `tasks sync push "<msg>" -- <path>` reads
// the paths after `--`.
//
// The bug this exists to prevent (task 161): the paths were handed to git
// verbatim, with git's cwd set to the task store. The store is its own repo whose
// root IS the store directory, so the repo-relative `.cogyard/tasks/NNN-foo.md` a caller
// naturally types (and tab-completion produces) died as a bare
// `fatal: pathspec ... did not match any files`. Every form below must reach the
// same store-relative name, and a path outside the store must be refused with a
// message naming the store — never a raw git fatal.
//
// Fixtures are a throwaway store (its own git repo) plus a throwaway project repo
// whose `.cogyard/tasks` is a symlink to it: the shared-store shape, never the real one.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveStorePath } from '../cli/tasks.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function task(dir, file, id, extraEnv = '') {
  writeFileSync(join(dir, file), [
    '---', `id: ${id}`, `slug: t${id}`, `title: t${id}`, 'status: OPEN', 'type: bug',
    'env:', extraEnv || '  claimed_at: null', '---', '', `# ${id}`, '',
  ].join('\n'));
}

// A store with two committed task files, and a project whose `.cogyard/tasks` links to it.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-syncpaths-')));
  dirs.push(root);
  const store = join(root, 'store');
  const repo = join(root, 'repo');
  mkdirSync(store); mkdirSync(repo);
  for (const d of [store, repo]) {
    git(d, ['init', '-q', '-b', 'main']);
    git(d, ['config', 'user.email', 'test@example.com']);
    git(d, ['config', 'user.name', 'Test']);
  }
  task(store, '001-one.md', 1);
  task(store, '002-two.md', 2);
  git(store, ['add', '-A']); git(store, ['commit', '-qm', 'seed']);
  writeFileSync(join(repo, 'README.md'), 'seed\n');
  writeFileSync(join(repo, '.gitignore'), '.cogyard/tasks\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'seed']);
  mkdirSync(join(repo, '.cogyard'), { recursive: true });
  symlinkSync(store, join(repo, '.cogyard', 'tasks'));
  return { root, store, repo };
}

// Run as a human's shell, never as the chat running the tests: a plain push
// decides what to commit by which chat is pushing (task 225).
const humanEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR'].includes(k)));
const push = (cwd, ...args) => spawnSync('node', [CLI, 'sync', 'push', ...args], { cwd, encoding: 'utf8', env: humanEnv });
const lastCommitFiles = (store) => git(store, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);

// --- resolveStorePath, directly ---------------------------------------------

test('every form of the same file resolves to its store-relative name', () => {
  const { store, repo } = fixture();
  const opts = { canonical: store, bases: [repo, repo, store] };
  for (const p of [
    '001-one.md',                        // bare filename
    join(store, '001-one.md'),           // absolute store path (what `tasks find` prints)
    join(repo, '.cogyard', 'tasks', '001-one.md'),  // absolute path through the link
    '.cogyard/tasks/001-one.md',                 // repo-relative through the link
  ]) assert.equal(resolveStorePath(p, opts), '001-one.md', `form: ${p}`);
});

test('the link name is not special — any link to the store resolves', () => {
  // Resolution follows the link by realpath, never by stripping a known prefix.
  const { store, repo } = fixture();
  symlinkSync(store, join(repo, 'another-link'));
  const opts = { canonical: store, bases: [repo, repo, store] };
  assert.equal(resolveStorePath('another-link/002-two.md', opts), '002-two.md');
});

test('a relative path is read against the caller\'s cwd first', () => {
  const { store, repo } = fixture();
  mkdirSync(join(repo, 'sub'));
  const opts = { canonical: store, bases: [join(repo, 'sub'), repo, store] };
  assert.equal(resolveStorePath('../.cogyard/tasks/001-one.md', opts), '001-one.md');
});

test('a deleted file still resolves, so its deletion can be committed', () => {
  const { store, repo } = fixture();
  rmSync(join(store, '002-two.md'));
  const opts = { canonical: store, bases: [repo, repo, store] };
  assert.equal(resolveStorePath('.cogyard/tasks/002-two.md', opts), '002-two.md');
});

test('a deleted file whose folder is gone too still resolves inside the store', () => {
  // Task 196: removing job output's files and then their emptied folder left
  // the deletions uncommittable — realpath of the file AND of its folder failed.
  const { store, repo } = fixture();
  mkdirSync(join(store, 'sub', 'deeper'), { recursive: true });
  const opts = { canonical: store, bases: [repo, repo, store] };
  rmSync(join(store, 'sub'), { recursive: true });
  assert.equal(resolveStorePath('sub/deeper/x.md', opts), join('sub', 'deeper', 'x.md'));
  assert.equal(resolveStorePath('.cogyard/tasks/sub/deeper/x.md', opts), join('sub', 'deeper', 'x.md'));
  // A missing path OUTSIDE the store is still refused, however deep.
  assert.throws(() => resolveStorePath(join(repo, 'gone', 'x.md'), opts), /not inside the task store/);
});

test('a path outside the store is refused, naming the store', () => {
  const { store, repo } = fixture();
  const opts = { canonical: store, bases: [repo, repo, store] };
  for (const p of ['README.md', join(repo, 'README.md'), '../../etc/passwd', '/etc/hosts']) {
    assert.throws(() => resolveStorePath(p, opts),
      (e) => e.message.includes(store) && e.message.includes('not inside the task store'), `form: ${p}`);
  }
});

// --- the real command, end to end -------------------------------------------

for (const [label, form] of [
  ['bare filename', () => '001-one.md'],
  ['absolute store path', (f) => join(f.store, '001-one.md')],
  ['absolute path through the link', (f) => join(f.repo, '.cogyard', 'tasks', '001-one.md')],
  ['repo-relative path', () => '.cogyard/tasks/001-one.md'],
]) {
  test(`sync push -- <${label}> commits exactly that file in the store`, () => {
    const f = fixture();
    writeFileSync(join(f.store, '001-one.md'), 'edited\n', { flag: 'a' });
    writeFileSync(join(f.store, '002-two.md'), 'edited\n', { flag: 'a' });
    const r = push(f.repo, 'msg', '--', form(f));
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /fatal/);
    assert.deepEqual(lastCommitFiles(f.store), ['001-one.md']);
    assert.equal(git(f.store, ['log', '-1', '--format=%s']), 'msg');
    // The other pending edit is untouched — an explicit push names what it commits.
    assert.match(git(f.store, ['status', '--porcelain']), /002-two\.md/);
  });
}

test('sync push commits the deletion of a file whose folder was removed too', () => {
  const f = fixture();
  mkdirSync(join(f.store, 'briefs'));
  writeFileSync(join(f.store, 'briefs', '2026-01-01.md'), 'a brief\n');
  git(f.store, ['add', '-A']); git(f.store, ['commit', '-qm', 'add brief']);
  rmSync(join(f.store, 'briefs'), { recursive: true });
  const r = push(f.repo, 'remove the brief', '--', 'briefs/2026-01-01.md');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(f.store), ['briefs/2026-01-01.md']);
  assert.equal(git(f.store, ['ls-files', 'briefs']), '');
});

test('the commit message reaches git verbatim — no shell expansion', () => {
  // Task 196: the message went through a shell inside double quotes, so `$VAR`
  // expanded (task 187's "moved to $COGYARD_HOME" landed as "moved to  ") and
  // backticks or $(…) would have RUN.
  const f = fixture();
  writeFileSync(join(f.store, '001-one.md'), 'edited\n', { flag: 'a' });
  const marker = join(f.root, 'ran');
  const msg = `move to $HOME and \`touch ${marker}\` and $(touch ${marker}) "quoted" 'single'`;
  const r = push(f.repo, msg, '--', '001-one.md');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(f.store, ['log', '-1', '--format=%s']), msg);
  assert.equal(existsSync(marker), false, 'a command inside the message must never run');
});

test('a path with shell characters is committed as itself', () => {
  const f = fixture();
  const name = '003-$HOME-`x`.md';
  task(f.store, name, 3);
  const r = push(f.repo, 'add odd name', '--', name);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(f.store), [name]);
});

test('sync push -- <path outside the store> is refused with no git fatal', () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'README.md'), 'edited\n', { flag: 'a' });
  const before = git(f.store, ['rev-parse', 'HEAD']);
  const r = push(f.repo, 'msg', '--', 'README.md');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not inside the task store/);
  assert.ok(r.stderr.includes(f.store), r.stderr);
  assert.doesNotMatch(r.stderr, /fatal: pathspec/);
  assert.equal(git(f.store, ['rev-parse', 'HEAD']), before);
});

test('sync push -- <name that is not in the store> is refused with no git fatal', () => {
  const f = fixture();
  const r = push(f.repo, 'msg', '--', '.cogyard/tasks/999-typo.md');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not exist in the task store/);
  assert.doesNotMatch(r.stderr, /fatal: pathspec/);
});

test('default scope is unchanged: a file claimed on another branch is left pending', () => {
  const f = fixture();
  task(f.store, '002-two.md', 2, [
    '  claimed_at: 2026-09-30T00:00:00.000Z', '  claimed_by_session: other', '  branch: someone-elses-branch',
  ].join('\n'));
  writeFileSync(join(f.store, '001-one.md'), 'edited\n', { flag: 'a' });
  const r = push(f.repo, 'msg');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(f.store).sort(), ['001-one.md']);
  assert.match(r.stdout, /claimed by another chat[\s\S]*002-two\.md — claimed by session other, branch someone-elses-branch/);
});

// --- the commit gate: a store commit never adds a validator error -------------
// The Edit/Write hook sees only an agent's edit tool; an edit made in a shell or
// an editor reaches the store only through `sync push`, which applies the same
// rule: a file may keep the errors it already had, never gain one.

const head = (store) => git(store, ['rev-parse', 'HEAD']);
const staged = (store) => git(store, ['diff', '--cached', '--name-only']);
const edit = (store, file, from, to) => {
  const p = join(store, file);
  writeFileSync(p, readFileSync(p, 'utf8').replace(from, to));
};

test('a hand edit that adds a validator error is refused: nothing committed, nothing left staged, the error named', () => {
  const f = fixture();
  const before = head(f.store);
  edit(f.store, '001-one.md', 'type: bug\n', '');
  const r = push(f.repo, 'msg', '--', '001-one.md');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nothing committed — this commit would add validator errors to 1 task file\(s\):\n  001-one\.md\n    • type: missing/);
  assert.equal(head(f.store), before);
  assert.equal(staged(f.store), '');
});

test('parking a claimed task by hand is refused at commit', () => {
  const f = fixture();
  task(f.store, '001-one.md', 1, '  claimed_at: 2026-11-06T00:00:00.000Z\n  claimed_by: Tester');
  git(f.store, ['commit', '-qam', 'claim']);
  edit(f.store, '001-one.md', 'status: OPEN', 'status: PARKED');
  const r = push(f.repo, 'msg', '--', '001-one.md');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /but status is PARKED — a claim is valid only on an OPEN task/);
});

test('one bad file stops the whole commit, the good one included', () => {
  const f = fixture();
  const before = head(f.store);
  edit(f.store, '001-one.md', 'type: bug\n', '');
  edit(f.store, '002-two.md', '# 2', '# 2 — edited');
  const r = push(f.repo, 'msg', '--', '001-one.md', '002-two.md');
  assert.notEqual(r.status, 0);
  assert.equal(head(f.store), before);
});

test('errors a file already had pass, a deletion passes, and a new file must be clean', () => {
  const f = fixture();
  edit(f.store, '001-one.md', 'type: bug\n', '');
  git(f.store, ['commit', '-qam', 'an old file with an error already']);
  edit(f.store, '001-one.md', '# 1', '# 1 — edited, still missing its type');
  assert.equal(push(f.repo, 'msg', '--', '001-one.md').status, 0);

  rmSync(join(f.store, '002-two.md'));
  assert.equal(push(f.repo, 'msg', '--', '002-two.md').status, 0);
  assert.deepEqual(lastCommitFiles(f.store), ['002-two.md']);

  writeFileSync(join(f.store, '003-three.md'), '---\nid: 3\nslug: t3\ntitle: t3\nstatus: OPEN\n---\n');
  assert.notEqual(push(f.repo, 'msg', '--', '003-three.md').status, 0);
  task(f.store, '003-three.md', 3);
  assert.equal(push(f.repo, 'msg', '--', '003-three.md').status, 0);
});
