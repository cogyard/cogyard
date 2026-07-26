// test/usage-attribution.test.mjs — task 103: per-task cost attribution.
//
// Locks the resolver that recovers a task id for usage rows carrying no
// claim-based taskId, from the BANKED activity signals (own [#NN] commits, then
// dominant _tasks/NNN- refs). Covers the precedence (claim > commit > refs), the
// count thresholds, the dropped worktree-name rung, and money conservation
// through projectUsage.
//
// COGYARD_HOME is redirected to a throwaway temp dir BEFORE importing usage.mjs
// (it resolves the ledger paths at import). Node's test runner isolates each file
// in its own process, so this never touches the real ~/.cogyard.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-usage-'));
process.env.COGYARD_HOME = HOME;
const USAGE = join(HOME, 'usage');
mkdirSync(USAGE, { recursive: true });

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const writeActivity = (rows) => writeFileSync(join(USAGE, 'activity.jsonl'), jsonl(rows));
const writeUsage = (rows) => writeFileSync(join(USAGE, 'usage.jsonl'), jsonl(rows));

const { sessionTaskFallback, effectiveTaskId, projectUsage } = await import('../core/usage.mjs');

after(() => rmSync(HOME, { recursive: true, force: true }));

// --- effectiveTaskId: precedence --------------------------------------------

test('effectiveTaskId: a claim-stamped row keeps its taskId even if the fallback disagrees', () => {
  const fb = new Map([['s1', 9]]);
  assert.equal(effectiveTaskId({ taskId: 42, sessionId: 's1' }, fb), 42);
});

test('effectiveTaskId: a null-taskId row takes the session fallback', () => {
  const fb = new Map([['s1', 9]]);
  assert.equal(effectiveTaskId({ taskId: null, sessionId: 's1' }, fb), 9);
});

test('effectiveTaskId: no claim and no fallback → null (the (no task) bucket)', () => {
  assert.equal(effectiveTaskId({ taskId: null, sessionId: 'ghost' }, new Map()), null);
});

// --- sessionTaskFallback: signal thresholds + precedence --------------------

test('sessionTaskFallback: a single own [#NN] commit is definitive (floor 1)', () => {
  writeActivity([{ sessionId: 's1', commitTasks: { 5: 1 } }]);
  assert.equal(sessionTaskFallback().get('s1'), 5);
});

test('sessionTaskFallback: a lone _tasks/NNN- mention does NOT tag (refs floor 2)', () => {
  writeActivity([{ sessionId: 's1', tasks: { 7: 1 } }]);
  assert.equal(sessionTaskFallback().get('s1'), undefined);
});

test('sessionTaskFallback: two ref mentions tag when there is no commit signal', () => {
  writeActivity([{ sessionId: 's1', tasks: { 7: 2 } }]);
  assert.equal(sessionTaskFallback().get('s1'), 7);
});

test('sessionTaskFallback: own commit beats a much louder ref count', () => {
  writeActivity([{ sessionId: 's1', commitTasks: { 5: 1 }, tasks: { 9: 50 } }]);
  assert.equal(sessionTaskFallback().get('s1'), 5);
});

test('sessionTaskFallback: dominant commit id wins over a minority one', () => {
  writeActivity([{ sessionId: 's1', commitTasks: { 5: 30, 8: 8, 1: 1 } }]);
  assert.equal(sessionTaskFallback().get('s1'), 5);
});

test('sessionTaskFallback: a commit-count tie resolves to the lower id (deterministic)', () => {
  writeActivity([{ sessionId: 's1', commitTasks: { 8: 2, 3: 2 } }]);
  assert.equal(sessionTaskFallback().get('s1'), 3);
});

test('sessionTaskFallback: rows for one session merge across collections', () => {
  writeActivity([
    { sessionId: 's1', commitTasks: { 5: 1 } },
    { sessionId: 's1', commitTasks: { 5: 1, 8: 1 } },
  ]);
  assert.equal(sessionTaskFallback().get('s1'), 5); // 5:2 beats 8:1
});

test('sessionTaskFallback: worktree name is NOT a signal (dropped rung)', () => {
  // A task-NNN-* worktree with no commit/ref signal must not attribute.
  writeActivity([{ sessionId: 's1', worktree: 'task-042-something' }]);
  assert.equal(sessionTaskFallback().get('s1'), undefined);
});

// --- projectUsage: integration + money conservation -------------------------

test('projectUsage: fallback fills null-taskId cost and money is conserved', () => {
  writeActivity([
    { sessionId: 'claimed', commitTasks: { 1: 5 } }, // signal exists but claim wins
    { sessionId: 'byCommit', commitTasks: { 10: 3 } },
    { sessionId: 'byRef', tasks: { 20: 4 } },
    { sessionId: 'noSignal', worktree: 'task-99-x' }, // worktree only → no attribution
  ]);
  writeUsage([
    { sessionId: 'claimed', project: 'p', taskId: 2, model: 'm', tokens: t(), costUSD: 100 },
    { sessionId: 'byCommit', project: 'p', taskId: null, model: 'm', tokens: t(), costUSD: 60 },
    { sessionId: 'byRef', project: 'p', taskId: null, model: 'm', tokens: t(), costUSD: 40 },
    { sessionId: 'noSignal', project: 'p', taskId: null, model: 'm', tokens: t(), costUSD: 7 },
  ]);
  const u = projectUsage('p');
  const bucket = (id) => u.tasks.find((x) => String(x.taskId) === String(id))?.costUSD ?? 0;

  assert.equal(bucket(2), 100);   // claim honored, NOT re-bucketed to task 1
  assert.equal(bucket(1), 0);     // the commit signal on a claimed row is ignored
  assert.equal(bucket(10), 60);   // recovered by own commit
  assert.equal(bucket(20), 40);   // recovered by dominant refs
  const noTask = u.tasks.find((x) => x.taskId == null)?.costUSD ?? 0;
  assert.equal(noTask, 7);        // signalless cost stays in the general bucket

  const sumTasks = u.tasks.reduce((s, x) => s + x.costUSD, 0);
  assert.equal(Math.round(sumTasks * 100) / 100, u.costUSD); // conserved: 207
  assert.equal(u.costUSD, 207);
});

test('projectUsage: taskId stays a NUMBER on the wire — claim and fallback buckets alike', () => {
  // The SPA joins usage onto task rows with STRICT equality (u.taskId === t.id,
  // t.id numeric from frontmatter). A stringified id silently kills every USAGE
  // box — this locks the cross-layer type contract.
  writeActivity([{ sessionId: 'byCommit', commitTasks: { 10: 3 } }]);
  writeUsage([
    { sessionId: 'claimed', project: 'p', taskId: 2, model: 'm', tokens: t(), costUSD: 1 },
    { sessionId: 'byCommit', project: 'p', taskId: null, model: 'm', tokens: t(), costUSD: 1 },
  ]);
  for (const b of projectUsage('p').tasks.filter((x) => x.taskId != null)) {
    assert.equal(typeof b.taskId, 'number', `taskId ${b.taskId} must be a number`);
  }
});

function t() { return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }; }
