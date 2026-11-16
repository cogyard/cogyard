// test/store-audit.test.mjs — the task-store rules behind the portal's store
// view (task 191): which paths belong in a store, and which commits and
// uncommitted files get flagged.
//
// The history checks run against a throwaway store (its own git repo on branch
// `tasks`), never a real one.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  classifyStorePath, taskIdOfPath, auditCommit, commitFlags,
  pendingEntries, pendingFlags, storeFacts, storeGraph, storeFlagged, storeWindow,
} from '../core/store-audit.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const texts = (flags) => flags.map((f) => f.text);

test('classifyStorePath: task files, including letter-suffixed and dotted ids', () => {
  assert.equal(classifyStorePath('159-cogyard-folder.md'), 'task');
  assert.equal(classifyStorePath('028b-ai-parsing.md'), 'task');
  assert.equal(classifyStorePath('007-x.md'), 'task');
  assert.equal(classifyStorePath('013.5-reveal-animation.md'), 'task');
});

test('classifyStorePath: files/<task id>/… is an attachment, any type, any depth', () => {
  for (const p of ['files/179/mockup.html', 'files/019/IDEAS.md', 'files/044e/x.sql', 'files/013.5/a/b.png']) {
    assert.equal(classifyStorePath(p), 'attachment', p);
  }
  for (const p of ['files/IDEAS.md', 'files/notes/a.md', 'files/179', 'prototypes/179-plan-view/mockup.html']) {
    assert.equal(classifyStorePath(p), 'other', p);
  }
  assert.equal(taskIdOfPath('files/019/a.html'), '19');
  assert.equal(taskIdOfPath('files/044e/x.sql'), '44e');
});

test('commitFlags: attachments are clean, but another task\'s attachment counts as another task', () => {
  assert.deepEqual(commitFlags('[#179] x', [M('179-plan.md'), M('files/179/mockup.html')]), []);
  assert.deepEqual(texts(commitFlags('[#179] x', [M('179-plan.md'), M('files/198/mockup.html')])), ['also changed 198']);
});

test('auditCommit judges a rename by its new path (task 224: path is the new path, oldPath the old)', () => {
  const { flags, files } = auditCommit('[#122] move', [{ status: 'R', path: 'files/122/HANDOFF-bucketof.md', oldPath: 'HANDOFF-bucketof.md' }]);
  assert.deepEqual(flags, []);
  assert.equal(files[0].cls, 'attachment');
  assert.equal(files[0].oldPath, 'HANDOFF-bucketof.md', 'the old path is passed through untouched');
  assert.equal(auditCommit('x', [{ status: 'R', path: 'notes.md', oldPath: 'files/1/a.md' }]).files[0].cls, 'other');
});

test('history readers give a rename one letter and its new path', () => {
  const store = realpathSync(mkdtempSync(join(tmpdir(), 'store-rename-')));
  dirs.push(store);
  git(store, ['init', '-q', '-b', 'tasks']);
  git(store, ['config', 'user.email', 't@t']); git(store, ['config', 'user.name', 't']);
  writeFileSync(join(store, 'HANDOFF-x.md'), 'a\nb\nc\nd\ne\n');
  git(store, ['add', '-A']); git(store, ['commit', '-q', '-m', 'add']);
  mkdirSync(join(store, 'files', '122'), { recursive: true });
  git(store, ['mv', 'HANDOFF-x.md', 'files/122/HANDOFF-x.md']);
  git(store, ['commit', '-q', '-m', '[#122] move']);
  const flagged = storeWindow(store, 7);
  assert.equal(flagged.commits, 2);
  assert.equal(flagged.other, 1, 'only the first commit (a root-level non-task file) is flagged; the move into files/122 is clean');
});

test('classifyStorePath: look-alikes and other files are "other"', () => {
  for (const p of ['044email-debugger.md', '013.-x.md', 'IDEAS.md', 'HANDOFF-x.md',
    'prototypes/179-plan-view/mockup.html', '017-chips.reference.html', 'salvage/a.md', 'sub/159-x.md']) {
    assert.equal(classifyStorePath(p), 'other', p);
  }
});

test('classifyStorePath: job output, index, allowed', () => {
  assert.equal(classifyStorePath('briefs/2026-10-06.md'), 'job');
  assert.equal(classifyStorePath('heartbeats/doc-drift.md'), 'job');
  assert.equal(classifyStorePath('drift.md'), 'job');
  assert.equal(classifyStorePath('INDEX.md'), 'index');
  assert.equal(classifyStorePath('axes.json'), 'allowed');
  assert.equal(classifyStorePath('.gitkeep'), 'allowed');
});

test('taskIdOfPath drops leading zeros so it compares with a [#NN] tag', () => {
  assert.equal(taskIdOfPath('028b-x.md'), '28b');
  assert.equal(taskIdOfPath('159-x.md'), '159');
  assert.equal(taskIdOfPath('007-x.md'), '7');
  assert.equal(taskIdOfPath('013.5-x.md'), '13.5');
  assert.equal(taskIdOfPath('IDEAS.md'), null);
});

const M = (path) => ({ status: 'M', path });

test('commitFlags: the 3e8a6cf case — job files and another task\'s file', () => {
  const flags = commitFlags('[#159] docs(task): move the tunnel marker to task 166', [
    M('159-cogyard-folder.md'), M('166-per-project.md'), M('INDEX.md'),
    { status: 'A', path: 'briefs/2026-10-06.md' }, M('heartbeats/doc-drift.md'), M('heartbeats/project-brief.md'),
  ]);
  assert.deepEqual(texts(flags), ['took 3 job files', 'also changed 166']);
  assert.deepEqual(flags.map((f) => f.tone), ['bad', 'review']);
});

test('commitFlags: a clean task commit gets nothing; INDEX.md never counts as another task', () => {
  assert.deepEqual(commitFlags('[#179] fix(portal): x', [M('179-plan-view.md'), M('INDEX.md')]), []);
  assert.deepEqual(commitFlags('[#7] x', [M('007-x.md')]), [], 'leading zeros compare equal');
});

test('commitFlags: a dotted task is its own task, not its parent', () => {
  assert.deepEqual(commitFlags('[#13] x', [M('013-a.md')]), []);
  assert.deepEqual(texts(commitFlags('[#13] x', [M('013-a.md'), M('013.5-b.md')])), ['also changed 13.5']);
});

test('commitFlags: no [#NN] tag → no other-task flag, whatever it touched', () => {
  assert.deepEqual(commitFlags('add task 166', [M('166-x.md'), M('031-y.md'), M('INDEX.md')]), []);
});

test('commitFlags: more than 3 other tasks reads as a count', () => {
  const files = ['176-strip.md', '1-a.md', '2-b.md', '3-c.md', '4-d.md'].map(M);
  assert.deepEqual(texts(commitFlags('[#176] chore(tasks): drop env.planet', files)), ['changed 4 other tasks']);
  assert.deepEqual(texts(commitFlags('[#176] x', ['176-s.md', '1-a.md', '2-b.md'].map(M))), ['also changed 1, 2']);
});

test('commitFlags: singular and plural, non-task files', () => {
  assert.deepEqual(texts(commitFlags('[#130] x', [M('130-a.md'), M('heartbeats/doc-drift.md')])), ['took 1 job file']);
  assert.deepEqual(texts(commitFlags('add task 179', [{ status: 'A', path: '179-plan.md' },
    ...['README.md', 'mockup.html', 'overlay.json', 'plan.mjs'].map((n) => ({ status: 'A', path: `prototypes/179/${n}` }))])),
  ['4 non-task files']);
});

test('auditCommit marks the foreign task file and classifies every file', () => {
  const { files } = auditCommit('[#159] x', [M('159-a.md'), M('166-b.md'), M('briefs/x.md')]);
  assert.deepEqual(files.map((f) => [f.cls, f.foreignTask]), [['task', null], ['task', '166'], ['job', null]]);
});

test('pendingFlags: job output is warn, a stray file is bad, an old one is bad', () => {
  const now = Date.UTC(2026, 9, 7);
  const day = 24 * 60 * 60 * 1000;
  const p = pendingFlags([
    { path: 'briefs/a.md', cls: 'job', mtimeMs: now - 30 * day },
    { path: 'notes.txt', cls: 'other', mtimeMs: now - day },
    { path: '159-a.md', cls: 'task', mtimeMs: now },
  ], now);
  assert.equal(p.count, 3);
  assert.deepEqual(p.byClass, { task: 1, attachment: 0, index: 0, job: 1, allowed: 0, other: 1 });
  assert.equal(p.oldestDays, 30);
  assert.deepEqual(p.flags.map((f) => [f.text, f.tone]), [['job output', 'warn'], ['not a task file', 'bad'], ['30 days', 'bad']]);
  assert.deepEqual(pendingFlags([], now).flags, []);
});

// --- against a throwaway store ---------------------------------------------------

function store() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-storeaudit-')));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'tasks']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 'T']);
  const commit = (msg, files) => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', msg]);
  };
  return { dir, commit };
}

test('a store: history flags, flagged-only scan, pending row, week counts', async () => {
  const { dir, commit } = store();
  commit('add task 1', { '001-a.md': 'a', 'INDEX.md': '1' });
  commit('[#1] edit', { '001-a.md': 'a2' });
  commit('[#1] sweep', { '001-a.md': 'a3', '002-b.md': 'b', 'briefs/2026-01-01.md': 'x' });
  commit('[#2] edit', { '002-b.md': 'b2' });
  writeFileSync(join(dir, 'heartbeats.md'), 'stray'); // an uncommitted non-task file
  mkdirSync(join(dir, 'heartbeats'));
  writeFileSync(join(dir, 'heartbeats', 'job.md'), 'hb');

  const facts = storeFacts(dir);
  assert.equal(facts.branch, 'tasks');
  assert.equal(facts.remote, false);
  assert.equal(facts.unpushed, null);
  assert.deepEqual(texts(facts.flags), ['leftover INDEX.md'], 'the store still tracks the retired INDEX.md');
  assert.equal(facts.pending.count, 2);
  assert.deepEqual(texts(facts.pending.flags), ['job output', 'not a task file']);
  assert.deepEqual(pendingEntries(dir).map((e) => e.cls).sort(), ['job', 'other']);

  const g = await storeGraph(dir, { facts });
  assert.equal(g.rows[0].kind, 'pending', 'the uncommitted row sits above HEAD');
  assert.deepEqual(g.rows.slice(1).map((r) => texts(r.flags)), [[], ['took 1 job file', 'also changed 2'], [], []]);

  const f = await storeFlagged(dir, { days: 30, facts });
  assert.equal(f.scanned, 4);
  assert.equal(f.flaggedCount, 1);
  const flagged = f.rows.filter((r) => r.kind !== 'pending');
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].hiddenBefore, 1, 'the clean [#2] commit above it');
  assert.equal(f.hiddenAfter, 2);
  assert.equal(flagged[0].cleanSubject, 'sweep');

  assert.deepEqual(storeWindow(dir, 7), { days: 7, commits: 4, flagged: 1, job: 1, other: 0, otherTasks: 1 });
});

test('leftover INDEX.md: flagged on the store while present, never on the commits that carried it', async () => {
  const { dir, commit } = store();
  commit('[#1] edit', { '001-a.md': 'a', 'INDEX.md': 'generated' });
  assert.deepEqual(texts(storeFacts(dir).flags), ['leftover INDEX.md']);
  assert.equal((await storeFlagged(dir, { days: 30 })).flaggedCount, 0, 'the old commit is not flagged');
  rmSync(join(dir, 'INDEX.md'));
  assert.deepEqual(texts(storeFacts(dir).flags), ['leftover INDEX.md'], 'deleted but not committed: still in the store');
  git(dir, ['commit', '-qam', 'remove INDEX.md']);
  assert.deepEqual(storeFacts(dir).flags, []);
});

test('a store off branch tasks, and an old uncommitted file', () => {
  const { dir, commit } = store();
  commit('add task 1', { '001-a.md': 'a' });
  git(dir, ['checkout', '-q', '-b', 'oops']);
  writeFileSync(join(dir, 'briefs.md'), 'x');
  const old = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(join(dir, 'briefs.md'), old, old);
  const facts = storeFacts(dir);
  assert.deepEqual(texts(facts.flags), ['not on tasks (oops)']);
  assert.deepEqual(texts(facts.pending.flags), ['not a task file', '10 days']);
});
