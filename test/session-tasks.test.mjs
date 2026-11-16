// test/session-tasks.test.mjs — task 117: the chat → tasks ladder, and the one
// thing that must stay true about it.
//
// There are two views of the same ladder and they are NOT interchangeable:
//   sessionTaskIdsAll  every task in the chat — the ARCHIVE-SAFETY decision
//   sessionTaskIds     the strongest 3 — a DISPLAY convenience
//
// Cleanup asks "is this chat safe to archive?", which is true only when every
// task in it is finished. Answering from a truncated list drops the tasks that
// should have blocked archiving — so the failure mode is archiving a chat that
// another open task still needs. These tests exist to stop a future change
// quietly capping the uncapped one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sessionTaskIdsAll, sessionTaskIds, SESSION_TASK_DISPLAY_CAP } =
  await import('../core/activity.mjs');

// A chat that touched five tasks by the strongest signal there is: its own
// commits, each stamped `[#NN]` by the /commit skill.
const fiveByCommit = { commitTasks: { 101: 9, 102: 7, 103: 5, 104: 3, 105: 1 } };

test('all: returns EVERY task, past the display cap', () => {
  const ids = sessionTaskIdsAll(fiveByCommit, null);
  assert.deepEqual(ids, ['101', '102', '103', '104', '105']);
  assert.ok(ids.length > SESSION_TASK_DISPLAY_CAP,
    'the fixture must exceed the cap or this test proves nothing');
});

test('display: caps at 3, strongest first', () => {
  assert.deepEqual(sessionTaskIds(fiveByCommit, null), ['101', '102', '103']);
});

test('the two agree on the prefix — same ladder, one is just truncated', () => {
  const all = sessionTaskIdsAll(fiveByCommit, null);
  assert.deepEqual(sessionTaskIds(fiveByCommit, null), all.slice(0, SESSION_TASK_DISPLAY_CAP));
});

test('signal order: commits, then claims, then dominant refs, then worktree name', () => {
  const ids = sessionTaskIdsAll(
    { commitTasks: { 7: 3 }, tasks: { 9: 10, 11: 10 }, worktree: 'task-013-something' },
    { claimedTasks: ['8'] });
  assert.deepEqual(ids, ['7', '8', '9', '11', '13']);
});

test('leading zeros are normalised so #007 and #7 are one task', () => {
  // A worktree named task-007-* and a commit stamped [#7] are the same task;
  // if they deduped as two, cleanup would wait forever on a task that is done.
  assert.deepEqual(sessionTaskIdsAll({ commitTasks: { '007': 2 }, worktree: 'task-7-thing' }, null), ['7']);
});

test('passing mentions do NOT tag a task', () => {
  // The dominant-reference rung needs >=25% of the top count AND >=2 hits, so a
  // chat that merely name-drops a task is not treated as working on it —
  // otherwise every chat would look unsafe to archive forever.
  assert.deepEqual(sessionTaskIdsAll({ tasks: { 50: 40, 51: 1 } }, null), ['50']);
});

test('a chat with no signal yields nothing, not a guess', () => {
  assert.deepEqual(sessionTaskIdsAll(null, null), []);
  assert.deepEqual(sessionTaskIdsAll({}, {}), []);
});
