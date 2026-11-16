// test/sync-push-scope.test.mjs — what a plain `tasks sync push "<msg>"` (no
// `-- <paths>`) commits.
//
// The bug this exists to prevent (task 187): the default scope took EVERY
// pending file in the store, so nightly job output (briefs/, heartbeats/,
// drift.md) and stray files were swept into whatever "add task NNN" commit a
// session made next, under a message that said nothing about them. The default
// scope is now task files and the store's allowed files
// (core/store-audit.mjs classifyStorePath — the same rule the portal's store
// view flags by); everything else is left pending and listed. An explicit
// `-- <path>` push still commits exactly what it names. `INDEX.md` is no longer
// written or committed at all (task 190): a leftover one is just another file
// that is not a task file.
//
// Task 225: a plain push decides ownership by CHAT, not branch. Two chats in one
// checkout share a branch, so one chat's push used to sweep the other's claimed
// task file into its commit; and an unclaimed new task file was anyone's. Now a
// file claimed by another chat, or unclaimed and not reserved by this chat
// (`next-id`), is left pending and listed with who holds it.
//
// Fixtures are a throwaway store (its own git repo) plus a throwaway project repo
// whose `.cogyard/tasks` is a symlink to it: the shared-store shape, never the real one.
// Every CLI run gets its own COGYARD_HOME (claims.json) and an explicit chat id —
// none = a human's shell — never the environment of the chat running the tests.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const ENV_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'env.mjs');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function task(dir, file, id, title = `t${id}`) {
  writeFileSync(join(dir, file), [
    '---', `id: ${id}`, `slug: t${id}`, `title: ${title}`, 'status: OPEN', 'type: bug',
    'env:', '  claimed_at: null', '---', '', `# ${id}`, '',
  ].join('\n'));
}

// A store with a committed task and a committed heartbeat; a project linking to it.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-syncscope-')));
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
  mkdirSync(join(store, 'heartbeats'));
  writeFileSync(join(store, 'heartbeats', 'x.md'), 'ran: 2026-01-01\n');
  git(store, ['add', '-A']); git(store, ['commit', '-qm', 'seed']);
  writeFileSync(join(repo, 'README.md'), 'seed\n');
  writeFileSync(join(repo, '.gitignore'), '.cogyard/tasks\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'seed']);
  mkdirSync(join(repo, '.cogyard'), { recursive: true });
  symlinkSync(store, join(repo, '.cogyard', 'tasks'));
  const home = join(root, 'home');
  mkdirSync(home);
  return { store, repo, home };
}

// Job output and a stray file pending beside an edited task file.
function dirty({ store }) {
  task(store, '001-one.md', 1, 'one, edited');
  mkdirSync(join(store, 'briefs'));
  writeFileSync(join(store, 'briefs', '2026-01-01.md'), '# brief\n');
  writeFileSync(join(store, 'heartbeats', 'x.md'), 'ran: 2026-01-02\n');
  writeFileSync(join(store, 'drift.md'), '# drift\n');
  writeFileSync(join(store, 'notes.txt'), 'scratch\n');
}

// The environment one CLI run sees: the fixture's own COGYARD_HOME, and
// `chat` as the id of the chat running it (null = a human's shell).
function envFor(fx, chat) {
  const env = { ...process.env, COGYARD_HOME: fx.home };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR']) delete env[k];
  if (chat) env.CLAUDE_CODE_SESSION_ID = chat;
  return env;
}
const pushAs = (fx, chat, ...args) => spawnSync('node', [CLI, 'sync', 'push', ...args], { cwd: fx.repo, encoding: 'utf8', env: envFor(fx, chat) });
const push = (fx, ...args) => pushAs(fx, null, ...args);
// Claim a task file as `chat`. The claim commits itself (task 222), so only
// later edits are pending.
function claimAs(fx, chat, file) {
  const r = spawnSync('node', [ENV_CLI, 'claim', join(fx.store, file), chat], { cwd: fx.repo, encoding: 'utf8', env: envFor(fx, chat) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(pending(fx.store), [], 'the claim left nothing pending');
}
const appendTo = (fx, file, text) => writeFileSync(join(fx.store, file), readFileSync(join(fx.store, file), 'utf8') + text);
const lastCommitFiles = (store) => git(store, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort();
// Untrimmed: porcelain's first line can start with a space (" M path").
const pending = (store) => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: store, encoding: 'utf8' })
  .split('\n').map((l) => l.slice(3)).filter(Boolean).sort();

test('a plain push commits only the task file, and leaves job output and stray files pending', () => {
  const fx = fixture();
  dirty(fx);
  const r = push(fx, 'edit task 1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(fx.store), ['001-one.md']);
  assert.deepEqual(pending(fx.store), ['briefs/2026-01-01.md', 'drift.md', 'heartbeats/x.md', 'notes.txt']);
  assert.match(r.stdout, /not a task file/);
  for (const f of ['briefs/2026-01-01.md', 'drift.md', 'heartbeats/x.md', 'notes.txt']) assert.ok(r.stdout.includes(f), `lists ${f}`);
});

test('a plain push commits a task\'s attachments under files/<id>/, not a loose file beside them', () => {
  const fx = fixture();
  task(fx.store, '001-one.md', 1, 'one, edited');
  mkdirSync(join(fx.store, 'files', '001'), { recursive: true });
  writeFileSync(join(fx.store, 'files', '001', 'mockup.html'), '<p>mock</p>\n');
  writeFileSync(join(fx.store, 'files', 'loose.md'), 'no task\n');
  const r = push(fx, 'edit task 1 + its mockup');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(fx.store), ['001-one.md', 'files/001/mockup.html']);
  assert.deepEqual(pending(fx.store), ['files/loose.md']);
});

test('a push neither writes INDEX.md nor commits a leftover one', () => {
  const fx = fixture();
  writeFileSync(join(fx.store, 'INDEX.md'), '# old index\n');
  git(fx.store, ['add', 'INDEX.md']); git(fx.store, ['commit', '-qm', 'an old index']);
  task(fx.store, '001-one.md', 1, 'one, edited');
  writeFileSync(join(fx.store, 'INDEX.md'), '# edited by hand\n');
  const r = push(fx, 'edit task 1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(fx.store), ['001-one.md']);
  assert.deepEqual(pending(fx.store), ['INDEX.md']);
});

test('a fresh store gets no INDEX.md from a push', () => {
  const fx = fixture();
  task(fx.store, '001-one.md', 1, 'one, edited');
  assert.equal(push(fx, 'edit task 1').status, 0);
  assert.deepEqual(pending(fx.store), []);
  assert.ok(!git(fx.store, ['ls-files']).split('\n').includes('INDEX.md'));
});

test('with only job output pending, a plain push commits nothing', () => {
  const fx = fixture();
  mkdirSync(join(fx.store, 'briefs'));
  writeFileSync(join(fx.store, 'briefs', '2026-01-01.md'), '# brief\n');
  const head = git(fx.store, ['rev-parse', 'HEAD']);
  const r = push(fx, 'nothing of mine');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(fx.store, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(pending(fx.store), ['briefs/2026-01-01.md']);
});

// Task 190: naming a path no longer commits anything at all. A file the store
// does not hold is refused even when named; its deletion still commits.
test('an explicit -- <path> push refuses a file a store does not hold, naming files/<task id>/', () => {
  const fx = fixture();
  dirty(fx);
  const head = git(fx.store, ['rev-parse', 'HEAD']);
  for (const p of ['heartbeats/x.md', 'notes.txt']) {
    const r = push(fx, 'commit it', '--', p);
    assert.notEqual(r.status, 0, p);
    assert.match(r.stderr, /files\/<task id>\//, p);
  }
  assert.equal(git(fx.store, ['rev-parse', 'HEAD']), head, 'nothing committed');
});

test('an explicit -- <path> push commits a task file, an attachment, or an attachment folder', () => {
  const fx = fixture();
  task(fx.store, '001-one.md', 1, 'one, edited');
  mkdirSync(join(fx.store, 'files', '1'), { recursive: true });
  writeFileSync(join(fx.store, 'files', '1', 'a.sql'), 'select 1;\n');
  writeFileSync(join(fx.store, 'files', '1', 'b.html'), '<p/>\n');
  assert.equal(push(fx, 'task', '--', '001-one.md').status, 0);
  assert.equal(push(fx, 'one attachment', '--', 'files/1/a.sql').status, 0);
  assert.deepEqual(lastCommitFiles(fx.store), ['files/1/a.sql']);
  const r = push(fx, 'the folder', '--', 'files/1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(fx.store), ['files/1/b.html']);
});

test('an explicit -- <path> push still commits the DELETION of a stray file — that is the cleanup', () => {
  const fx = fixture();
  rmSync(join(fx.store, 'heartbeats', 'x.md'));
  const r = push(fx, 'remove the old heartbeat', '--', 'heartbeats/x.md');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(fx.store), ['heartbeats/x.md']);
});

// --- Task 225: ownership by chat, not branch -----------------------------------

// Two claimed task files, edited and uncommitted, both claimed from the SAME
// checkout (branch main) — the 2026-10-13 incident (tasks 211 and 217).
function twoChats() {
  const fx = fixture();
  task(fx.store, '002-two.md', 2);
  git(fx.store, ['add', '-A']); git(fx.store, ['commit', '-qm', 'task 2']);
  claimAs(fx, 'S1', '001-one.md');
  claimAs(fx, 'S2', '002-two.md');
  appendTo(fx, '001-one.md', 'S1 note\n');
  appendTo(fx, '002-two.md', 'S2 note\n');
  return fx;
}

test('same branch, two chats: a plain push commits only the pushing chat\'s claimed file and names the other\'s holder', () => {
  const fx = twoChats();
  const r = pushAs(fx, 'S2', 'S2 edits two');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(fx.store), ['002-two.md']);
  assert.deepEqual(pending(fx.store), ['001-one.md']);
  assert.match(r.stdout, /001-one\.md — claimed by session S1, worktree repo/);
});

test('a chat\'s own claimed task is still committed by a plain push', () => {
  const fx = twoChats();
  assert.equal(pushAs(fx, 'S1', 'S1 edits one').status, 0);
  assert.deepEqual(lastCommitFiles(fx.store), ['001-one.md']);
});

test('pushing chat unknown (a human\'s shell): every file a chat has claimed is left pending', () => {
  const fx = twoChats();
  task(fx.store, '003-three.md', 3);
  const r = push(fx, 'from a terminal');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(fx.store), ['003-three.md']);
  assert.deepEqual(pending(fx.store), ['001-one.md', '002-two.md']);
});

test('an attachment follows its task\'s claim', () => {
  const fx = twoChats();
  mkdirSync(join(fx.store, 'files', '001'), { recursive: true });
  writeFileSync(join(fx.store, 'files', '001', 'mock.html'), '<p/>\n');
  assert.equal(pushAs(fx, 'S2', 'S2 edits two').status, 0);
  assert.deepEqual(pending(fx.store), ['001-one.md', 'files/001/mock.html']);
});

test('an unclaimed file is left pending unless this chat reserved it with next-id', () => {
  const fx = fixture();
  const reserve = spawnSync('node', [CLI, 'next-id', 'new-thing'], { cwd: fx.repo, encoding: 'utf8', env: envFor(fx, 'S1') });
  assert.equal(reserve.status, 0, reserve.stderr);
  const file = JSON.parse(reserve.stdout).file;
  writeFileSync(file, '---\nid: 2\nslug: new-thing\ntitle: new\nstatus: OPEN\ntype: bug\nenv:\n  claimed_at: null\n---\n');
  task(fx.store, '001-one.md', 1, 'one, edited by nobody in particular');
  const other = pushAs(fx, 'S2', 'S2 has nothing of its own');
  assert.equal(other.status, 0, other.stderr);
  assert.deepEqual(pending(fx.store), ['001-one.md', '002-new-thing.md']);
  assert.match(other.stdout, /002-new-thing\.md — reserved by session S1/);
  assert.match(other.stdout, /001-one\.md — unclaimed/);
  assert.equal(pushAs(fx, 'S1', 'add task 2').status, 0);
  assert.deepEqual(lastCommitFiles(fx.store), ['002-new-thing.md']);
  assert.deepEqual(pending(fx.store), ['001-one.md']);
});

test('no session recorded on the claim: the branch rule still decides', () => {
  const fx = fixture();
  // A claim written before claims.json existed: branch in the file, no session anywhere.
  writeFileSync(join(fx.store, '001-one.md'), [
    '---', 'id: 1', 'slug: t1', 'title: t1', 'status: OPEN', 'type: bug',
    'env:', '  claimed_at: 2026-01-01T00:00:00Z', '  branch: some-other-branch', '---', '', '# 1', '',
  ].join('\n'));
  git(fx.store, ['add', '-A']); git(fx.store, ['commit', '-qm', 'old-style claim']);
  appendTo(fx, '001-one.md', 'edit\n');
  const r = pushAs(fx, 'S2', 'not mine');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(pending(fx.store), ['001-one.md']);
  assert.match(r.stdout, /claimed by branch some-other-branch/);
});

test('an explicit -- <path> push commits another chat\'s file when named — naming is deliberate', () => {
  const fx = twoChats();
  const r = pushAs(fx, 'S2', 'commit one on purpose', '--', '001-one.md');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastCommitFiles(fx.store), ['001-one.md']);
  assert.deepEqual(pending(fx.store), ['002-two.md']);
});
