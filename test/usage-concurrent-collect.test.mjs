// test/usage-concurrent-collect.test.mjs — collectors running at the same time
// never wipe the usage bookmark file (task 253).
//
// The collector remembers how far into each transcript it has counted in
// $COGYARD_HOME/usage/cursors.json. It used to read that file, work, and
// rewrite it in place with no lock, treating an unreadable file as "nothing
// counted yet". When the desktop app stopped a batch of chats at once, each
// chat's SessionEnd hook started a collector; one read the file while another
// had it half written, saved a bookmark file holding only its own transcript,
// and the next full run re-counted every other transcript into the ledger
// again (~$30k of duplicate cost per wipe).
//
// Real CLI processes, started together, over synthetic transcripts.
// COGYARD_HOME points at a throwaway dir, so this never touches ~/.cogyard.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'cli', 'usage.mjs');

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-concurrent-collect-')));
const USAGE = join(HOME, 'usage');
const CURSORS = join(USAGE, 'cursors.json');
const LEDGER = join(USAGE, 'usage.jsonl');
const TRANSCRIPTS = join(HOME, 'transcripts');
mkdirSync(USAGE, { recursive: true });
mkdirSync(TRANSCRIPTS, { recursive: true });
writeFileSync(join(HOME, 'projects.json'), '[]');
after(() => rmSync(HOME, { recursive: true, force: true }));

const ENV = { ...process.env, COGYARD_HOME: HOME, COGYARD_DRIVER: 'claude' };
// The repair test imports core in this process: point it at the throwaway dir too.
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_DRIVER = 'claude';

// A transcript with a few priced assistant turns.
function transcript(name) {
  const file = join(TRANSCRIPTS, `${name}.jsonl`);
  const lines = [];
  for (let i = 0; i < 20; i++) {
    lines.push({
      type: 'assistant', sessionId: name, cwd: join(HOME, 'somewhere'), requestId: `${name}-r${i}`,
      timestamp: `2026-11-16T12:00:${String(i).padStart(2, '0')}Z`,
      message: { id: `${name}-m${i}`, model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } },
    });
  }
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

// A bookmark file the size of a real one: thousands of transcripts already
// counted, each with its recent message ids — big enough that rewriting it
// takes long enough for another process to read it half written.
function seedCursors(n) {
  const cursors = {};
  for (let i = 0; i < n; i++) {
    cursors[join(TRANSCRIPTS, 'old', `${i}.jsonl`)] = {
      offset: 1_000_000 + i,
      recent: Array.from({ length: 100 }, (_, k) => `req_${i}_${k}:msg_${i}_${k}_padding_padding`),
    };
  }
  writeFileSync(CURSORS, JSON.stringify(cursors, null, 1) + '\n');
}

// One SessionEnd hook run: `collect --hook` with the hook's JSON on stdin.
function hookRun(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'collect', '--hook'], { env: ENV });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify({ transcript_path: file }));
  });
}

const readCursors = () => JSON.parse(readFileSync(CURSORS, 'utf8'));
const ledgerRows = () => (existsSync(LEDGER)
  ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

test('thirteen session-end collectors started together keep every bookmark', async () => {
  const OLD = 2000;
  seedCursors(OLD);
  const files = Array.from({ length: 13 }, (_, i) => transcript(`chat-${i}`));

  // The batch: every hook at once, as when the app stops 13 chats together.
  // Then the same batch again, as the next batch stop would: nothing new to count.
  const runs = await Promise.all(files.map(hookRun));
  for (const r of runs) assert.equal(r.code, 0, r.err);
  await Promise.all(files.map(hookRun));

  const cursors = readCursors();
  const oldKept = Object.keys(cursors).filter((k) => k.includes('/old/')).length;
  assert.equal(oldKept, OLD, `bookmarks for already-counted transcripts were lost: ${OLD - oldKept} of ${OLD}`);
  for (const f of files) assert.ok(cursors[f], `no bookmark for ${f}`);

  // Every chat counted, and counted once: each hook waits its turn rather than
  // skipping, so nothing is left for a later sweep.
  const perChat = new Map();
  for (const r of ledgerRows()) perChat.set(r.sessionId, (perChat.get(r.sessionId) || 0) + 1);
  for (let i = 0; i < files.length; i++) assert.equal(perChat.get(`chat-${i}`), 1, `chat-${i} counted ${perChat.get(`chat-${i}`) || 0} times`);
  assert.ok(!existsSync(join(USAGE, 'collect.lock')), 'the lock is released');
});

test('a lock left by a run that died is taken over', async () => {
  // A pid that is not running: a hook killed mid-collection leaves this behind.
  writeFileSync(join(USAGE, 'collect.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '2026-11-16T00:00:00Z', token: 'dead' }));
  const file = transcript('chat-after-dead-lock');
  const { code, out, err } = await hookRun(file);
  assert.equal(code, 0, err);
  assert.equal(JSON.parse(out).rows, 1);
  assert.ok(!existsSync(join(USAGE, 'collect.lock')), 'the lock is released');
});

test('repair: chats on disk are replaced by their recount; gone chats lose exact copies only', async () => {
  const { planLedgerRepair } = await import('../core/usage.mjs');
  const row = (sessionId, firstTs, lastTs, messages, capturedAt, extra = {}) => ({
    capturedAt, sessionId, model: 'claude-opus-4-8', taskId: null, firstTs, lastTs, messages,
    tokens: { input: messages * 100, output: messages * 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    costUSD: messages, pricingVersion: 'v1', backfilled: false, ...extra,
  });
  const ledger = [
    // on disk: counted in two pieces, then re-counted whole twice after wipes
    row('live', '2026-06-01T00:00Z', '2026-06-01T01:00Z', 3, '2026-06-01'),
    row('live', '2026-06-02T00:00Z', '2026-06-02T01:00Z', 2, '2026-06-02'),
    row('live', '2026-06-01T00:00Z', '2026-06-02T01:00Z', 5, '2026-11-10'),
    row('live', '2026-06-01T00:00Z', '2026-06-02T01:00Z', 5, '2026-11-15', { pricingVersion: 'v2' }),
    // gone from disk: one real row, one exact copy (different capture and price version), one distinct row
    row('gone', '2026-05-01T00:00Z', '2026-05-01T01:00Z', 4, '2026-05-01'),
    row('gone', '2026-05-01T00:00Z', '2026-05-01T01:00Z', 4, '2026-11-10', { pricingVersion: 'v2', backfilled: true }),
    row('gone', '2026-05-03T00:00Z', '2026-05-03T01:00Z', 1, '2026-05-03'),
  ];
  const recount = [row('live', '2026-06-01T00:00Z', '2026-06-02T01:00Z', 5, '2026-11-17', { repairedAt: 'now' })];

  const plan = planLedgerRepair(ledger, recount);
  assert.equal(plan.replaced, 4, "all of the on-disk chat's rows are replaced");
  assert.equal(plan.copies, 1, 'the gone chat loses its one exact copy');
  assert.deepEqual(plan.rows.map((r) => [r.sessionId, r.messages, r.capturedAt]), [
    ['gone', 4, '2026-05-01'], // the first of the two copies is the one kept
    ['gone', 1, '2026-05-03'],
    ['live', 5, '2026-11-17'],
  ]);
  assert.equal(plan.rows.reduce((n, r) => n + r.costUSD, 0), 10);
});

test('a bookmark file that cannot be read stops the run instead of starting over', async () => {
  writeFileSync(CURSORS, '{"half a file');
  const before = ledgerRows().length;
  const file = transcript('chat-after-corruption');

  const { code, err } = await hookRun(file);
  assert.notEqual(code, 0, 'the run must fail, not re-count from zero');
  assert.match(err, /cursors\.json/, 'the error names the file');
  assert.equal(ledgerRows().length, before, 'nothing was appended');
  assert.equal(readFileSync(CURSORS, 'utf8'), '{"half a file', 'the unreadable file is left for a person to look at');
});
