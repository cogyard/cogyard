// test/chat-parents.test.mjs — task 258: the Claude driver reads which chat
// started which.
//
// The desktop app records, in a chat's metadata file, the chat that started it
// (`spawnedFrom.sessionId`) and the top chat of its tree
// (`startChain.firstSessionId`) — both as the APP's ids (`local_…`). The driver
// must hand the engine TRANSCRIPT ids (cliSessionId), the key every row uses.
//
// Runs the REAL Claude adapter against a fake Desktop store: HOME and
// COGYARD_HOME point at a throwaway dir and COGYARD_DRIVER forces the driver,
// all BEFORE import. Node's test runner isolates each file in its own process.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'cogyard-chat-parents-'));
process.env.HOME = ROOT;
process.env.COGYARD_HOME = join(ROOT, '.cogyard');
process.env.COGYARD_DRIVER = 'claude';
const STORE = join(ROOT, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
mkdirSync(STORE, { recursive: true });

const chat = (appId, fields) => writeFileSync(join(STORE, `${appId}.json`), JSON.stringify({
  sessionId: appId, cwd: '/x', isArchived: false, lastActivityAt: 1791845000000, ...fields,
}));
// top (started by the person) → mid (side session) → leaf (mid's worker)
chat('local_top', { title: 'Pick up 256', cliSessionId: 't-top' });
chat('local_mid', {
  title: 'Rehearsal', cliSessionId: 't-mid',
  spawnedFrom: { sessionId: 'local_top', title: 'Rehearsal', sideSession: true },
  startChain: { firstSessionId: 'local_top', depth: 1 },
});
chat('local_leaf', {
  title: 'Worker', cliSessionId: 't-leaf',
  spawnedFrom: { sessionId: 'local_mid' },
  startChain: { firstSessionId: 'local_top', depth: 2 },
});
// Its parent's file is gone (deleted in the app).
chat('local_orphan', {
  title: 'Orphan', cliSessionId: 't-orphan',
  spawnedFrom: { sessionId: 'local_gone' },
  startChain: { firstSessionId: 'local_gone', depth: 1 },
});

const { adapter } = await import('../core/drivers.mjs');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const byTitle = () => Object.fromEntries(adapter.sessions.list().map((r) => [r.title, r]));

test('a chat the person started has no parent and no top chat', () => {
  const r = byTitle()['Pick up 256'];
  assert.equal(r.parentSessionId, null);
  assert.equal(r.rootSessionId, null);
});

test('a side session points at its parent and top chat by TRANSCRIPT id', () => {
  const r = byTitle().Rehearsal;
  assert.equal(r.parentSessionId, 't-top');
  assert.equal(r.rootSessionId, 't-top');
});

test("a worker two levels down: parent is the side session, top is the person's chat", () => {
  const r = byTitle().Worker;
  assert.equal(r.parentSessionId, 't-mid');
  assert.equal(r.rootSessionId, 't-top');
});

test('a parent whose file is gone reads as null, so the chat is top-level', () => {
  const r = byTitle().Orphan;
  assert.equal(r.parentSessionId, null);
  assert.equal(r.rootSessionId, null);
});

test("the app's own field names never reach a row", () => {
  for (const r of adapter.sessions.list()) {
    assert.equal('spawnedFrom' in r, false);
    assert.equal('startChain' in r, false);
  }
});
