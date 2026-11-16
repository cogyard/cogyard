// test/task-chats-rewind.test.mjs — task 208: a rewound chat keeps its title.
//
// A rewind in the Desktop app starts a new transcript for the same chat; the
// metadata file moves cliSessionId to the new id and keeps the old ones in
// priorCliSessionIds. A ledger row recorded under an old id must still resolve
// to the chat's title, and the chat must still be listed ONCE.
//
// Runs the REAL Claude adapter against a fake Desktop store: HOME and
// COGYARD_HOME point at a throwaway dir and COGYARD_DRIVER forces the driver,
// all BEFORE import (both resolve paths at import). Node's test runner isolates
// each file in its own process, so the real ~/Library is never read.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'cogyard-rewind-'));
process.env.HOME = ROOT;
process.env.COGYARD_HOME = join(ROOT, '.cogyard');
process.env.COGYARD_DRIVER = 'claude';
const USAGE = join(ROOT, '.cogyard', 'usage');
mkdirSync(USAGE, { recursive: true });
const STORE = join(ROOT, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
mkdirSync(STORE, { recursive: true });

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(join(USAGE, 'usage.jsonl'), '');
writeFileSync(join(USAGE, 'claims.jsonl'), '');

// One rewound chat (old → mid → current) and one plain chat whose CURRENT id
// collides with the rewound chat's old id — the current id must win.
writeFileSync(join(STORE, 'local_rewound.json'), JSON.stringify({
  title: 'Rewound chat', cliSessionId: 'current', priorCliSessionIds: ['old', 'mid'],
  cwd: '/x', isArchived: true, lastActivityAt: 1791845777192,
}));
writeFileSync(join(STORE, 'local_plain.json'), JSON.stringify({
  title: 'Plain chat', cliSessionId: 'clash', cwd: '/x', isArchived: false, lastActivityAt: 1791845000000,
}));
writeFileSync(join(STORE, 'local_claimer.json'), JSON.stringify({
  title: 'Claimer', cliSessionId: 'other', priorCliSessionIds: ['clash'], cwd: '/x', lastActivityAt: 1791844000000,
}));

const { chatsForTask } = await import('../core/task-chats.mjs');
const { adapter } = await import('../core/drivers.mjs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

test('the Claude adapter lists a rewound chat once, with its earlier transcript ids', () => {
  const rows = adapter.sessions.list();
  assert.equal(rows.length, 3);
  const r = rows.find((x) => x.sessionId === 'current');
  assert.deepEqual(r.priorSessionIds, ['old', 'mid']);
  assert.deepEqual(rows.find((x) => x.sessionId === 'clash').priorSessionIds, []);
});

test('a chat recorded under a pre-rewind transcript id gets its title and archived flag', () => {
  writeFileSync(join(USAGE, 'activity.jsonl'), jsonl([
    { sessionId: 'old', project: 'p', commitTasks: { 5: 2 } },
  ]));
  const [c] = chatsForTask('p', 5).implemented;
  assert.equal(c.sessionId, 'old');
  assert.equal(c.title, 'Rewound chat');
  assert.equal(c.archived, true);
});

test("a chat's current id wins over another chat's old id", () => {
  writeFileSync(join(USAGE, 'activity.jsonl'), jsonl([
    { sessionId: 'clash', project: 'p', commitTasks: { 6: 2 } },
  ]));
  const [c] = chatsForTask('p', 6).implemented;
  assert.equal(c.title, 'Plain chat');
});
