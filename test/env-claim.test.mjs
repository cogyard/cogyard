// test/env-claim.test.mjs — `cogyard env claim / release / where` after task
// 190: the task file gets only the shared claim (claimed_at, claimed_by,
// branch); this machine's worktree and session go to $COGYARD_HOME/claims.json.
//
// A throwaway project (its own repo, on a task branch) whose `.cogyard/tasks`
// links to a throwaway local-only store, and a throwaway $COGYARD_HOME.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENV = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'env.mjs');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

// The owner's shell by default: these tests often run inside an agent, whose
// variables would make the owner-only override refuse. `asAgent` puts one back.
const AGENT_VARS = ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID'];

function fixture(envLines = ['  branch: null', '  claimed_at: null', '  claimed_by: null'], { id = '7', stem = '007-x' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-claim-')));
  dirs.push(root);
  const store = join(root, 'store'), repo = join(root, 'repo'), home = join(root, 'home');
  mkdirSync(store); mkdirSync(repo); mkdirSync(home);
  git(store, ['init', '-q', '-b', 'tasks']);
  const file = join(store, `${stem}.md`);
  writeFileSync(file, ['---', `id: ${id}`, 'slug: x', 'title: x', 'status: OPEN', 'type: bug', 'env:', ...envLines, '---', '', 'body', ''].join('\n'));
  git(repo, ['init', '-q', '-b', 'task-007-x']);
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'seed']);
  mkdirSync(join(repo, '.cogyard'));
  symlinkSync(store, join(repo, '.cogyard', 'tasks'));
  const runIn = (cwd, args, { asAgent = false } = {}) => {
    const env = { ...process.env, COGYARD_HOME: home, COGYARD_USER: 'Tester' };
    for (const k of AGENT_VARS) delete env[k];
    if (asAgent) env.CLAUDECODE = '1';
    return spawnSync('node', [ENV, ...args], { cwd, encoding: 'utf8', env });
  };
  const run = (...args) => runIn(repo, args);
  // A linked worktree of the project, named as given, on its own branch.
  const worktree = (name) => {
    const path = join(root, 'wts', name);
    git(repo, ['worktree', 'add', '-q', '-b', `worktree-${name}`, path]);
    return path;
  };
  const claims = () => { try { return JSON.parse(readFileSync(join(home, 'claims.json'), 'utf8')); } catch { return {}; } };
  return { store, repo, file, run, runIn, worktree, claims, text: () => readFileSync(file, 'utf8') };
}

test('claim writes the shared fields to the task file and the machine\'s to claims.json', () => {
  const fx = fixture();
  const r = fx.run('claim', fx.file, 'sess-1');
  assert.equal(r.status, 0, r.stderr);
  const t = fx.text();
  assert.match(t, /claimed_at: 20/);
  assert.match(t, /claimed_by: Tester/);
  assert.match(t, /branch: task-007-x/);
  assert.doesNotMatch(t, /claimed_by_session|worktree:/, 'no machine fields in the shared file');
  assert.deepEqual(Object.values(fx.claims()).map(({ worktree, session }) => ({ worktree, session })), [{ worktree: 'repo', session: 'sess-1' }]);
});

test('a second session is refused; the same session may re-claim; --force displaces', () => {
  const fx = fixture();
  assert.equal(fx.run('claim', fx.file, 'sess-1').status, 0);
  const other = fx.run('claim', fx.file, 'sess-2');
  assert.equal(other.status, 2);
  assert.match(other.stderr, /"claimed_by_session": "sess-1"/);
  assert.equal(fx.run('claim', fx.file, 'sess-1').status, 0);
  assert.equal(fx.run('claim', fx.file, 'sess-2', '--force').status, 0);
  assert.equal(Object.values(fx.claims())[0].session, 'sess-2');
});

test('a claim made on another machine (in the file, no record here) is refused too', () => {
  const fx = fixture(['  branch: someone-else', '  claimed_at: 2026-01-01T00:00:00.000Z', '  claimed_by: Teammate']);
  const r = fx.run('claim', fx.file, 'sess-1');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Teammate/);
});

test('where shows the file\'s claim and branch with this machine\'s worktree and session', () => {
  const fx = fixture();
  fx.run('claim', fx.file, 'sess-1');
  const w = JSON.parse(fx.run('where', fx.file).stdout);
  assert.deepEqual({ ...w, claimed_at: !!w.claimed_at, taskFile: undefined },
    { claimed_at: true, claimed_by: 'Tester', branch: 'task-007-x', worktree: 'repo', session: 'sess-1', taskFile: undefined });
});

test('release clears the claim and the session, and keeps branch and worktree as the record', () => {
  const fx = fixture();
  fx.run('claim', fx.file, 'sess-1');
  assert.equal(fx.run('release', fx.file).status, 0);
  const w = JSON.parse(fx.run('where', fx.file).stdout);
  assert.deepEqual([w.claimed_at, w.claimed_by, w.session, w.branch, w.worktree], [null, null, null, 'task-007-x', 'repo']);
  assert.doesNotMatch(fx.text(), /claimed_by_session/);
});

test('release of a not-yet-migrated file clears its old claimed_by_session line too', () => {
  const fx = fixture(['  worktree: old-wt', '  branch: b', '  claimed_at: 2026-01-01', '  claimed_by: Tester', '  claimed_by_session: old-sess']);
  assert.equal(fx.run('release', fx.file).status, 0);
  assert.match(fx.text(), /claimed_by_session: null/);
  assert.equal(JSON.parse(fx.run('where', fx.file).stdout).session, null);
});

// Task 234: a task is claimed only from its own task-<id>-… worktree or the
// main checkout. A claim from any other worktree is refused before anything is
// written, so a worktree made outside the pickup process never becomes the task's.

test('a claim from a worktree not named for the task is refused, and nothing is written', () => {
  const fx = fixture();
  const before = fx.text();
  const wt = fx.worktree('new-build-reload');
  const r = fx.runIn(wt, ['claim', fx.file, 'sess-1']);
  assert.equal(r.status, 3, r.stderr);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error, 'wrong_worktree');
  assert.equal(err.worktree, 'new-build-reload');
  assert.equal(err.expected_worktree, 'task-007-x');
  assert.match(err.hint, /pickup-task Step 5/);
  assert.equal(fx.text(), before, 'task file untouched');
  assert.deepEqual(fx.claims(), {}, 'claims.json untouched');
});

test('another task\'s worktree is refused too: the id has to be this task\'s', () => {
  const fx = fixture();
  const r = fx.runIn(fx.worktree('task-70-other'), ['claim', fx.file, 'sess-1']);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stderr).expected_worktree, 'task-007-x');
});

test('the task\'s own worktree claims as before, padded or not', () => {
  for (const name of ['task-007-x', 'task-7-x', 'task-07-renamed-slug']) {
    const fx = fixture();
    const wt = fx.worktree(name);
    const r = fx.runIn(wt, ['claim', fx.file, 'sess-1']);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(fx.text(), new RegExp(`branch: worktree-${name}`));
    assert.equal(Object.values(fx.claims())[0].worktree, name);
  }
});

test('suffixed and dotted ids match their own worktree and no other', () => {
  const b = fixture(undefined, { id: '028b', stem: '028b-x' });
  assert.equal(b.runIn(b.worktree('task-028b-x'), ['claim', b.file, 's']).status, 0);
  const b2 = fixture(undefined, { id: '028b', stem: '028b-x' });
  assert.equal(b2.runIn(b2.worktree('task-028-x'), ['claim', b2.file, 's']).status, 3);
  const d = fixture(undefined, { id: '013.5', stem: '013.5-x' });
  assert.equal(d.runIn(d.worktree('task-13.5-x'), ['claim', d.file, 's']).status, 0);
  const d2 = fixture(undefined, { id: '013.5', stem: '013.5-x' });
  assert.equal(d2.runIn(d2.worktree('task-013-x'), ['claim', d2.file, 's']).status, 3);
});

test('--any-worktree is the owner\'s: an agent is refused with the command to hand over', () => {
  const fx = fixture();
  const before = fx.text();
  const wt = fx.worktree('scratch');
  const agent = fx.runIn(wt, ['claim', fx.file, 'sess-1', '--any-worktree'], { asAgent: true });
  assert.equal(agent.status, 1);
  assert.match(agent.stderr, /owner's call/);
  assert.match(agent.stderr, /cogyard env claim .* sess-1 --any-worktree/);
  assert.equal(fx.text(), before);
  const owner = fx.runIn(wt, ['claim', fx.file, 'sess-1', '--any-worktree']);
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(Object.values(fx.claims())[0].worktree, 'scratch');
});

test('--any-worktree changes nothing where the claim was allowed anyway, even for an agent', () => {
  const fx = fixture();
  assert.equal(fx.runIn(fx.repo, ['claim', fx.file, 'sess-1', '--any-worktree'], { asAgent: true }).status, 0);
});

// A claim is valid only on an OPEN task: a closed task is reopened first, a
// parked one set back to OPEN. Refused with exit 4, nothing written.

test('a task that is not OPEN is refused, naming reopen for a closed one, and nothing is written', () => {
  for (const [status, hint] of [['DONE', /cogyard tasks reopen 7 --why/], ['ENOUGH', /cogyard tasks reopen 7/], ['PARKED', /set it back to OPEN/], ['OBSOLETE', /set it back to OPEN/]]) {
    const fx = fixture();
    writeFileSync(fx.file, fx.text().replace('status: OPEN', `status: ${status}`));
    const before = fx.text();
    const r = fx.run('claim', fx.file, 'sess-1');
    assert.equal(r.status, 4, `${status}: ${r.stderr}`);
    const err = JSON.parse(r.stderr);
    assert.equal(err.error, 'not_open');
    assert.equal(err.status, status);
    assert.match(err.hint, hint);
    assert.equal(fx.text(), before, `${status}: the file is untouched`);
    assert.deepEqual(fx.claims(), {}, `${status}: nothing recorded on this machine`);
  }
});

test('tasks current lists only OPEN claimed tasks — a claim left on a closed task is not work in progress', () => {
  const fx = fixture();
  assert.equal(fx.run('claim', fx.file, 'sess-1').status, 0);
  writeFileSync(join(fx.store, '008-y.md'), ['---', 'id: 8', 'slug: y', 'title: y', 'status: DONE', 'type: bug', 'env:', '  claimed_at: 2026-08-16T00:00:00.000Z', '  claimed_by: Tester', '---', '', 'body', ''].join('\n'));
  const env = { ...process.env, COGYARD_HOME: dirname(fx.store) + '/home' };
  for (const k of AGENT_VARS) delete env[k];
  const r = spawnSync('node', [join(dirname(ENV), 'tasks.mjs'), 'current'], { cwd: fx.repo, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).tasks.map((t) => t.file), ['007-x.md']);
});

// A local-only store (no origin): claim and release commit their own edit to
// the task file, so the store is clean straight after each and no later chat's
// `sync push` finds the edit pending under someone else's claim.

function seedStore(fx) {
  git(fx.store, ['add', '-A']);
  git(fx.store, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'seed']);
}

test('on a local-only store, claim and release each commit the task file and leave the store clean', () => {
  const fx = fixture();
  seedStore(fx);
  const status = () => git(fx.store, ['status', '--short']);
  const subject = () => git(fx.store, ['log', '-1', '--format=%s']);

  assert.equal(fx.run('claim', fx.file, 'sess-1').status, 0);
  assert.equal(status(), '', 'nothing pending after claim');
  assert.match(subject(), /^claim 007-x\.md/);
  assert.match(git(fx.store, ['show', 'HEAD:007-x.md']), /claimed_by: Tester/);

  assert.equal(fx.run('release', fx.file).status, 0);
  assert.equal(status(), '', 'nothing pending after release');
  assert.match(subject(), /^release 007-x\.md/);
});

test('on a local-only store, a claim commits only the task file, never another pending edit', () => {
  const fx = fixture();
  seedStore(fx);
  writeFileSync(join(fx.store, '008-y.md'), '---\nid: 8\nstatus: OPEN\n---\n');
  assert.equal(fx.run('claim', fx.file, 'sess-1').status, 0);
  assert.equal(git(fx.store, ['status', '--short']), '?? 008-y.md');
  assert.deepEqual(git(fx.store, ['show', '--name-only', '--format=', 'HEAD']).split('\n'), ['007-x.md']);
});
