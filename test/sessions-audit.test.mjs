// test/sessions-audit.test.mjs — task 106: the audit's pure parsers.
//
// The join and verdict paths hit live git + the driver's metadata store, so
// they're exercised end-to-end via fixtures (see the task file's verify loop).
// What belongs HERE is the pure, deterministic input parsing: which chat
// titles yield a task id (conservative by design — a wrong join could point
// the cleanup gate at the wrong checkout), and the pid extraction that decides
// LIVE vs LOCKED.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { taskIdFromTitle, pidFromLockReason } = await import('../core/sessions-audit.mjs');

test('taskIdFromTitle: the shapes that must match', () => {
  assert.equal(taskIdFromTitle('Pick up 74'), 74);
  assert.equal(taskIdFromTitle('pick up 106'), 106);
  assert.equal(taskIdFromTitle('Pickup 12'), 12);       // "pick\s*up" tolerates the joined form
  assert.equal(taskIdFromTitle('Task 040 cleanup'), 40); // leading zeros stripped
  assert.equal(taskIdFromTitle('Fix task 96 UI issue'), 96);
  assert.equal(taskIdFromTitle('#103 cost attribution'), 103);
});

test('taskIdFromTitle: bare or ambiguous numbers do NOT match (conservative join)', () => {
  assert.equal(taskIdFromTitle('Complete project 041'), null); // "project 41" ≠ task 41
  assert.equal(taskIdFromTitle('Hide Claude chats from view'), null);
  assert.equal(taskIdFromTitle('port 7437 debugging'), null);
  assert.equal(taskIdFromTitle(''), null);
  assert.equal(taskIdFromTitle(null), null);
});

test('pidFromLockReason: extracts the pid, tolerates absence', () => {
  assert.equal(pidFromLockReason('claude session cost-column-tasks (pid 20880 start Sat Jul 18 01:06:53 2026)'), 20880);
  assert.equal(pidFromLockReason('locked by hand'), null);
  assert.equal(pidFromLockReason(''), null);
  assert.equal(pidFromLockReason(null), null);
});
