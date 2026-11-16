// Tests for the PreToolUse task-frontmatter guard
// (hooks/pretooluse-validate-frontmatter.mjs).
//
// Integration-style, like guard-dev-server.test.mjs: a real throwaway store on
// disk, and the hook run as the separate process it is, fed real PreToolUse JSON
// on stdin.
//
// TWO halves, and the second matters as much as the first. Refusing a task file
// that would gain a schema error is the point. Letting through everything that
// is not a task is what stops the guard blocking ordinary work — which it did:
// a brief is named for its date, a date starts with a digit, and the gate keyed
// on "basename starts with a digit", so hand-editing `_tasks/briefs/2026-01-01.md`
// was refused for not being a valid TASK.
//
// The guard used to exempt the job directories by name for that. Task 187 moved
// every job's output out of the stores to $COGYARD_HOME, which no `_tasks/` path
// reaches, so the exemption went and the tests below pin the new shape: a brief
// at its real home is untouched, and a date-named file inside a store is a task
// like any other.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'pretooluse-validate-frontmatter.mjs');

let STORE;

// A valid task file, so "before" has zero errors and any new error is a real
// regression rather than a pre-existing one being re-counted.
const GOOD_TASK = `---
id: 42
slug: a-task
title: A task
status: OPEN
type: feature
created: 2026-01-01
done_date: null
depends_on: []
related: []
touches_paths: []
out_of_scope: []
---

# 42: A task

Body.
`;

// The same file with its type removed — one new schema error.
const BROKEN_TASK = GOOD_TASK.replace('type: feature\n', '');

// A real brief: valid as a brief, nonsense as a task (status "ok" is not a task
// status, and there is no id or type).
const BRIEF = `---
date: 2026-01-01
project: demo
status: ok
generated_at: 2026-01-01T05:00:12.000Z
cost_usd: 0.0413
---

# demo — 1 Jan 2026

Three paragraphs of prose about the project.
`;

const HEARTBEAT = `---
job: project-brief
checked: 2026-01-01
outcome: unchanged
---

Looked at this project and found nothing had happened.
`;

// Every run gets its own $COGYARD_HOME (an empty registry unless a test passes
// one), so no test depends on which projects this machine has registered.
function run(file_path, content, home = EMPTY_HOME) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_input: { file_path, content } }),
    encoding: 'utf8',
    env: { ...process.env, COGYARD_HOME: home },
  });
  const out = (r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  const j = JSON.parse(out);
  return {
    decision: j.hookSpecificOutput?.permissionDecision ?? 'allow',
    reason: j.hookSpecificOutput?.permissionDecisionReason ?? '',
  };
}

let EMPTY_HOME;
before(() => {
  EMPTY_HOME = mkdtempSync(join(tmpdir(), 'cogyard-guard-home-'));
  STORE = join(mkdtempSync(join(tmpdir(), 'cogyard-guard-fm-')), '_tasks');
  mkdirSync(STORE, { recursive: true });
  writeFileSync(join(STORE, '042-a-task.md'), GOOD_TASK);
});

after(() => { rmSync(dirname(STORE), { recursive: true, force: true }); rmSync(EMPTY_HOME, { recursive: true, force: true }); });

// --- the guard still guards ---------------------------------------------------

test('a task file that would gain a schema error is refused', () => {
  const r = run(join(STORE, '042-a-task.md'), BROKEN_TASK);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /type/);
});

test('a task file that stays valid is allowed', () => {
  const r = run(join(STORE, '042-a-task.md'), GOOD_TASK);
  assert.equal(r.decision, 'allow');
});

test('a NEW task file must be clean', () => {
  const r = run(join(STORE, '043-new-one.md'), BROKEN_TASK);
  assert.equal(r.decision, 'deny');
});

// Task 160: the link to the store is now `<project>/.cogyard/tasks`. A write
// through it is as much a task write as one through the old `_tasks` link.
test('a task file reached through the .cogyard/tasks link is guarded too', () => {
  const store = join(dirname(STORE), 'project', '.cogyard', 'tasks');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, '042-a-task.md'), GOOD_TASK);
  assert.equal(run(join(store, '042-a-task.md'), BROKEN_TASK).decision, 'deny');
  assert.equal(run(join(store, '042-a-task.md'), GOOD_TASK).decision, 'allow');
});

test('a letter-suffixed task id is still a task file', () => {
  // core/validate.mjs's id grammar is NNN, NNN.M and NNNx — 039a-slug.md is a
  // real task and must not be waved through as if it were a job's file.
  const r = run(join(STORE, '039a-follow-on.md'), BROKEN_TASK);
  assert.equal(r.decision, 'deny');
});

// --- everything else in the store is not a task -------------------------------

test('a brief at its home under $COGYARD_HOME is not validated as a task, though its name starts with a digit', () => {
  // ~/.cogyard/briefs/<slug>/<date>.md — the date-named file that used to
  // collide with the task-filename test, now outside every `_tasks/` path.
  const r = run(join(dirname(STORE), '.cogyard', 'briefs', 'demo', '2026-01-01.md'), BRIEF);
  assert.equal(r.decision, 'allow',
    'a date-named brief is the exact collision this guard used to get wrong');
});

test('a heartbeat at its home, even with a digit-first job id, is not a task', () => {
  const r = run(join(dirname(STORE), '.cogyard', 'heartbeats', 'demo', '3d-render.md'), HEARTBEAT);
  assert.equal(r.decision, 'allow');
});

test('a date-named file INSIDE a store is a task like any other — no job exemption left', () => {
  // Nothing writes job output into a store any more (task 187), so a store's
  // `briefs/` folder is no longer special: what is in it is judged as a task.
  const r = run(join(STORE, 'briefs', '2026-01-01.md'), BRIEF);
  assert.equal(r.decision, 'deny');
});

test('the drift report is not validated as a task', () => {
  const r = run(join(STORE, 'drift.md'), '# Docs that may have gone stale\n\nSomething.\n');
  assert.equal(r.decision, 'allow');
});

test('the generated index is not validated as a task', () => {
  const r = run(join(STORE, 'INDEX.md'), '# Index\n\ngenerated\n');
  assert.equal(r.decision, 'allow');
});

test('a file outside any _tasks dir is none of the guard\'s business', () => {
  const r = run('/tmp/somewhere/042-a-task.md', BROKEN_TASK);
  assert.equal(r.decision, 'allow');
});

// --- what a store may hold (task 190) -------------------------------------------
// A store holds task files, axes.json and files/<task id>/ attachments. Anything
// else written into a store is refused at the write, naming files/<task id>/.

test('through the .cogyard/tasks link, a stray file in a store is refused and pointed at files/<task id>/', () => {
  const link = join(dirname(STORE), 'linked', '.cogyard', 'tasks');
  mkdirSync(link, { recursive: true });
  for (const name of ['IDEAS.md', 'HANDOFF-x.md', 'mockup.html', 'notes/a.md', 'INDEX.md']) {
    const r = run(join(link, name), '# x\n');
    assert.equal(r.decision, 'deny', name);
    assert.match(r.reason, /files\/<task id>\//, name);
  }
});

test('attachments under files/<task id>/ and axes.json are allowed — a digit-first attachment is not validated as a task', () => {
  const link = join(dirname(STORE), 'linked2', '.cogyard', 'tasks');
  mkdirSync(link, { recursive: true });
  assert.equal(run(join(link, 'files', '42', 'mockup.html'), '<p/>').decision, 'allow');
  assert.equal(run(join(link, 'files', '042', '001-notes.md'), 'no frontmatter at all\n').decision, 'allow');
  assert.equal(run(join(link, 'axes.json'), '{}').decision, 'allow');
  assert.equal(run(join(link, 'files', 'loose.md'), 'x').decision, 'deny', 'files/ itself is not a task folder');
});

test('a task file through the link is still validated', () => {
  const link = join(dirname(STORE), 'linked3', '.cogyard', 'tasks');
  mkdirSync(link, { recursive: true });
  assert.equal(run(join(link, '042-a-task.md'), BROKEN_TASK).decision, 'deny');
  assert.equal(run(join(link, '042-a-task.md'), GOOD_TASK).decision, 'allow');
});

test('at a registered store\'s real path, a stray file is refused too', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-guard-reg-')));
  try {
    const store = join(root, '_tasks', 'demo');
    const proj = join(root, 'demo');
    mkdirSync(store, { recursive: true });
    mkdirSync(join(proj, '.cogyard'), { recursive: true });
    symlinkSync(store, join(proj, '.cogyard', 'tasks'));
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'projects.json'), JSON.stringify([{ slug: 'demo', label: 'demo', path: proj }]));
    assert.equal(run(join(store, 'IDEAS.md'), '# ideas\n', home).decision, 'deny');
    assert.equal(run(join(store, 'files', '7', 'a.sql'), 'select 1;', home).decision, 'allow');
    assert.equal(run(join(store, 'IDEAS.md'), '# ideas\n').decision, 'allow', 'with no registry it is not provably a store');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- task 228: status and done_date change only through close / reopen --------

function runEdit(file_path, old_string, new_string) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_input: { file_path, old_string, new_string } }),
    encoding: 'utf8',
    env: { ...process.env, COGYARD_HOME: EMPTY_HOME },
  });
  const out = (r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  const j = JSON.parse(out);
  return { decision: j.hookSpecificOutput?.permissionDecision ?? 'allow', reason: j.hookSpecificOutput?.permissionDecisionReason ?? '' };
}

const withStatus = (status, doneDate = 'null') => GOOD_TASK
  .replace('status: OPEN', `status: ${status}`)
  .replace('done_date: null', `done_date: ${doneDate}`);

function seed(name, content) {
  const p = join(STORE, name);
  writeFileSync(p, content);
  return p;
}

test('hand-editing ENOUGH → DONE is refused, pointing at the close and reopen commands', () => {
  const p = seed('043-enough.md', withStatus('ENOUGH', '2026-10-17').replace('id: 42', 'id: 43'));
  const r = runEdit(p, 'status: ENOUGH', 'status: DONE');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /Task-status guard: `status: ENOUGH` → `status: DONE`/);
  assert.match(r.reason, /cogyard tasks close 43/);
  assert.match(r.reason, /cogyard tasks reopen 43/);
});

test('closing by hand (OPEN → DONE, with a done_date) is refused, as a Write too', () => {
  const p = seed('044-open.md', GOOD_TASK.replace('id: 42', 'id: 44'));
  assert.equal(run(p, withStatus('DONE', '2026-10-18').replace('id: 42', 'id: 44')).decision, 'deny');
  assert.equal(runEdit(p, 'status: OPEN', 'status: ENOUGH').decision, 'deny');
});

test('reopening by hand (DONE → OPEN) and moving a done_date are refused', () => {
  const p = seed('045-done.md', withStatus('DONE', '2026-10-17').replace('id: 42', 'id: 45'));
  assert.equal(runEdit(p, 'status: DONE', 'status: OPEN').decision, 'deny');
  const r = runEdit(p, 'done_date: 2026-10-17', 'done_date: 2026-10-18');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /done_date: 2026-10-17` → `done_date: 2026-10-18`/);
});

test('OPEN ↔ PARKED, OBSOLETE, other edits to a closed task, and a brand-new file all pass', () => {
  const open = seed('046-open.md', GOOD_TASK.replace('id: 42', 'id: 46'));
  assert.equal(runEdit(open, 'status: OPEN', 'status: PARKED').decision, 'allow');
  assert.equal(runEdit(open, 'status: OPEN', 'status: OBSOLETE').decision, 'allow');
  const done = seed('047-done.md', withStatus('DONE', '2026-10-17').replace('id: 42', 'id: 47'));
  assert.equal(runEdit(done, 'Body.', 'Body, with a note added later.').decision, 'allow');
  const placeholder = seed('048-new.md', '');
  assert.equal(run(placeholder, withStatus('DONE', '2026-01-01').replace('id: 42', 'id: 48')).decision, 'allow');
});

// A claim is valid only on an OPEN task: parking or obsoleting a CLAIMED task by
// hand adds a validator error, so the write is refused. An unclaimed one passes
// (the test above), and a file that already carries the error stays editable.
const claimedTask = (id, status = 'OPEN') => GOOD_TASK.replace('id: 42', `id: ${id}`)
  .replace('status: OPEN', `status: ${status}`)
  .replace('out_of_scope: []\n', 'out_of_scope: []\nenv:\n  branch: b\n  claimed_at: 2026-11-06T00:00:00.000Z\n  claimed_by: Tester\n');

test('parking or obsoleting a claimed task by hand is refused, naming the claim', () => {
  const p = seed('049-claimed.md', claimedTask(49));
  const parked = runEdit(p, 'status: OPEN', 'status: PARKED');
  assert.equal(parked.decision, 'deny');
  assert.match(parked.reason, /claimed .* but status is PARKED — a claim is valid only on an OPEN task/);
  assert.equal(runEdit(p, 'status: OPEN', 'status: OBSOLETE').decision, 'deny');
  const leftover = seed('050-leftover.md', claimedTask(50, 'PARKED'));
  assert.equal(runEdit(leftover, 'Body.', 'Body, noted.').decision, 'allow');
});

// --- task 247: claim fields change only through env claim / release ------------
// The file's half of a claim — env.branch, env.claimed_at, env.claimed_by — is
// written by `cogyard env claim` / `release`, which are atomic and commit. A hand
// edit that sets, changes or clears one is refused; one that leaves them alone,
// and a new file with all three null, pass.

const nullEnv = (id) => GOOD_TASK.replace('id: 42', `id: ${id}`)
  .replace('out_of_scope: []\n', 'out_of_scope: []\nenv:\n  branch: null\n  claimed_at: null\n  claimed_by: null\n');

test('hand-setting claimed_at is refused, naming env claim and env release', () => {
  const p = seed('051-unclaimed.md', nullEnv(51));
  const r = runEdit(p, '  claimed_at: null', '  claimed_at: 2026-11-09T00:00:00.000Z');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /Claim guard: `env\.claimed_at: null` → `env\.claimed_at: 2026-11-09/);
  assert.match(r.reason, /cogyard env claim <task-file> <session-id>/);
  assert.match(r.reason, /cogyard env release <task-file>/);
});

test('hand-changing claimed_by, and hand-clearing a claim, are refused', () => {
  const p = seed('052-claimed.md', claimedTask(52));
  assert.equal(runEdit(p, '  claimed_by: Tester', '  claimed_by: Someone Else').decision, 'deny');
  assert.equal(runEdit(p, '  claimed_at: 2026-11-06T00:00:00.000Z', '  claimed_at: null').decision, 'deny');
  assert.equal(runEdit(p, 'env:\n  branch: b\n', 'env:\n  branch: null\n').decision, 'deny');
});

test('a new task file arriving with branch set is refused; one with all three null passes', () => {
  const claimed = nullEnv(53).replace('  branch: null', '  branch: task-x');
  assert.equal(run(join(STORE, '053-new.md'), claimed).decision, 'deny');
  assert.equal(run(join(STORE, '054-new.md'), nullEnv(54)).decision, 'allow');
  assert.equal(run(join(STORE, '055-new.md'), GOOD_TASK.replace('id: 42', 'id: 55')).decision, 'allow', 'no env block at all');
});

test('editing a claimed task without touching its claim passes', () => {
  const p = seed('056-claimed.md', claimedTask(56));
  assert.equal(runEdit(p, 'Body.', 'Body, with a box ticked.').decision, 'allow');
});

test('a claim-shaped edit outside any task store is none of the guard\'s business', () => {
  const r = run('/tmp/elsewhere/057-x.md', nullEnv(57).replace('  branch: null', '  branch: task-x'));
  assert.equal(r.decision, 'allow');
});

// --- task 247: a linked worktree's launch file is the session-start hook's -----
// Real repos with a real linked worktree and a registry under a temp
// $COGYARD_HOME, like guard-dev-server.test.mjs. Refused in a linked worktree of
// a registered project; allowed in the main checkout (it also holds the
// project's own entries) and in an unregistered repo.

function gitRepo(root, name) {
  const dir = join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return realpathSync(dir);
}
let branchSeq = 0;
function linkWorktree(repoRoot, wt) {
  mkdirSync(dirname(wt), { recursive: true });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-q', '-b', `b${++branchSeq}`, wt]);
  return realpathSync(wt);
}
const LAUNCH = ['.claude', 'launch.json'];

test('a hand edit to a linked worktree\'s launch file is refused in a registered project, allowed elsewhere', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-guard-launch-')));
  try {
    const reg = gitRepo(root, 'registered');
    const unreg = gitRepo(root, 'unregistered');
    const wt = linkWorktree(reg, join(reg, '.claude', 'worktrees', 'task-1-x'));
    const elsewhere = linkWorktree(reg, join(root, 'some-other-layout', 'wt'));
    const unregWt = linkWorktree(unreg, join(unreg, '.claude', 'worktrees', 'task-2-y'));
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'projects.json'), JSON.stringify([{ slug: 'registered', label: 'registered', path: reg }]));
    const body = '{"version":"0.0.1","configurations":[]}\n';

    const inWt = run(join(wt, ...LAUNCH), body, home);
    assert.equal(inWt.decision, 'deny');
    assert.match(inWt.reason, /Worktree-file guard/);
    assert.match(inWt.reason, /\.cogyard\/worktree\.json/);
    assert.match(inWt.reason, /cogyard hook session-start \./);
    assert.equal(run(join(elsewhere, ...LAUNCH), body, home).decision, 'deny', 'a worktree in any layout is still a linked worktree');

    assert.equal(run(join(reg, ...LAUNCH), body, home).decision, 'allow', 'the main checkout\'s file is the owner\'s');
    assert.equal(run(join(unregWt, ...LAUNCH), body, home).decision, 'allow', 'an unregistered repo is none of its business');
    assert.equal(run(join(wt, 'src', ...LAUNCH), body, home).decision, 'allow', 'only the file at the worktree root');
    assert.equal(run(join(wt, '.env.development'), 'X=1\n', home).decision, 'allow', 'an env-file link edits the project root\'s own file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
