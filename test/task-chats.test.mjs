// test/task-chats.test.mjs — task 30: the task → chats bucketing.
//
// Locks the pure ledger logic of chatsForTask: which sessions land in
// implemented vs mentioned, the claimed-before-committed rank, dedup (a session
// that both claimed and committed appears ONCE), project scoping, recency order,
// and the empty-task no-throw. Transcript/label/archived resolution hits the
// adapter (the real desktop store is absent in CI → labels null), so it's out of
// scope here; the live end-to-end check is the task's `node -e` acceptance line.
//
// COGYARD_HOME is redirected to a throwaway temp dir BEFORE importing usage.mjs
// (it resolves the ledger paths at import). Node's test runner isolates each file
// in its own process, so this never touches the real ~/.cogyard.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-taskchats-'));
process.env.COGYARD_HOME = HOME;
const USAGE = join(HOME, 'usage');
mkdirSync(USAGE, { recursive: true });

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const writeClaims = (rows) => writeFileSync(join(USAGE, 'claims.jsonl'), jsonl(rows));
const writeActivity = (rows) => writeFileSync(join(USAGE, 'activity.jsonl'), jsonl(rows));
const writeUsage = (rows) => writeFileSync(join(USAGE, 'usage.jsonl'), jsonl(rows));

const { chatsForTask } = await import('../core/task-chats.mjs');

after(() => rmSync(HOME, { recursive: true, force: true }));

const roleOf = (list, sid) => list.find((c) => c.sessionId === sid)?.role;

test('buckets by strongest signal: claimed > committed > mentioned, with dedup', () => {
  writeClaims([
    { ts: '2026-07-01T10:00:00Z', event: 'claim', project: 'p', taskId: 55, sessionId: 'claimedSess' },
  ]);
  writeActivity([
    { sessionId: 'claimedSess', project: 'p', commitTasks: { 55: 3 } }, // ALSO committed → still one row, role claimed
    { sessionId: 'committedSess', project: 'p', commitTasks: { 55: 2 } },
    { sessionId: 'mentionedSess', project: 'p', tasks: { 55: 2 } },
    { sessionId: 'commitAndMention', project: 'p', commitTasks: { 55: 1 }, tasks: { 55: 5 } },
    { sessionId: 'otherProj', project: 'q', commitTasks: { 55: 9 } }, // wrong project → excluded
    { sessionId: 'otherTask', project: 'p', commitTasks: { 77: 4 } },  // wrong task → excluded
  ]);
  writeUsage([]);

  const r = chatsForTask('p', 55);
  const implSids = r.implemented.map((c) => c.sessionId);

  // claimed session appears exactly once, and as 'claimed' (not doubled by its commit signal).
  assert.equal(implSids.filter((s) => s === 'claimedSess').length, 1);
  assert.equal(roleOf(r.implemented, 'claimedSess'), 'claimed');
  // committed sessions land in implemented as 'committed'.
  assert.equal(roleOf(r.implemented, 'committedSess'), 'committed');
  // a session that both committed AND mentioned is implemented, never mentioned.
  assert.equal(roleOf(r.implemented, 'commitAndMention'), 'committed');
  assert.equal(r.mentioned.find((c) => c.sessionId === 'commitAndMention'), undefined);
  // mention-only → mentioned bucket.
  assert.deepEqual(r.mentioned.map((c) => c.sessionId), ['mentionedSess']);
  // scoping: other project + other task excluded everywhere.
  assert.equal(implSids.includes('otherProj'), false);
  assert.equal(implSids.includes('otherTask'), false);

  // claimed ranks before committed in the implemented list.
  assert.equal(r.implemented[0].role, 'claimed');
});

test('recency orders sessions within a rank (most-recent lastActiveAt first)', () => {
  writeClaims([]);
  writeActivity([
    { sessionId: 'older', project: 'p', commitTasks: { 8: 1 } },
    { sessionId: 'newer', project: 'p', commitTasks: { 8: 1 } },
  ]);
  writeUsage([
    { sessionId: 'older', project: 'p', taskId: 8, model: 'm', tokens: t(), costUSD: 1, firstTs: '2026-06-01T00:00:00Z', lastTs: '2026-06-01T01:00:00Z' },
    { sessionId: 'newer', project: 'p', taskId: 8, model: 'm', tokens: t(), costUSD: 1, firstTs: '2026-06-10T00:00:00Z', lastTs: '2026-06-10T01:00:00Z' },
  ]);
  const r = chatsForTask('p', 8);
  assert.deepEqual(r.implemented.map((c) => c.sessionId), ['newer', 'older']);
});

test('incidental + tied signals do NOT attribute a chat (the task-37 pollution)', () => {
  // The activity collector counts tags per whole transcript RECORD, so a git-log
  // dump or doc read lands several `[#NN]`/`_tasks/NN-` tags with equal counts.
  // Only a UNIQUE top signal attributes; a tie or a lone mention must not.
  writeClaims([]);
  writeActivity([
    { sessionId: 'tiedCommit', project: 'p', commitTasks: { 37: 4, 40: 4, 89: 4 } }, // 3-way tie → none
    { sessionId: 'loneRef', project: 'p', tasks: { 37: 1 } },                          // single incidental → not mentioned
    { sessionId: 'realCommit', project: 'p', commitTasks: { 37: 4, 89: 1 } },           // 37 unique-top → committed
    { sessionId: 'realRef', project: 'p', tasks: { 37: 3, 89: 1 } },                    // 37 unique-top, ≥2 → mentioned
  ]);
  writeUsage([]);
  const r = chatsForTask('p', 37);
  const impl = r.implemented.map((c) => c.sessionId);
  assert.equal(impl.includes('tiedCommit'), false, 'a tied commit signal must not attribute');
  assert.equal(r.mentioned.find((c) => c.sessionId === 'loneRef'), undefined, 'a lone incidental ref must not tag');
  assert.equal(roleOf(r.implemented, 'realCommit'), 'committed');
  assert.deepEqual(r.mentioned.map((c) => c.sessionId), ['realRef']);
});

test('a task with no chats returns empty buckets, not an error', () => {
  writeClaims([]);
  writeActivity([{ sessionId: 's', project: 'p', commitTasks: { 1: 1 } }]);
  writeUsage([]);
  const r = chatsForTask('p', 99999);
  assert.deepEqual({ created: r.created, impl: r.implemented, ment: r.mentioned }, { created: null, impl: [], ment: [] });
});

test('null project scope (everywhere) crosses projects', () => {
  writeClaims([]);
  writeActivity([
    { sessionId: 'inP', project: 'p', commitTasks: { 12: 1 } },
    { sessionId: 'inQ', project: 'q', commitTasks: { 12: 1 } },
  ]);
  writeUsage([]);
  const sids = chatsForTask(null, 12).implemented.map((c) => c.sessionId).sort();
  assert.deepEqual(sids, ['inP', 'inQ']);
});

function t() { return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }; }
