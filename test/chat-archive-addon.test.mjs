// The chat-archive add-on (task 151): copies the agent's chat stores into
// $COGYARD_HOME/chat-archive/, adding and updating, never deleting.
//
// HOME and COGYARD_HOME are redirected to throwaway dirs BEFORE anything loads,
// so the Claude driver's roots resolve inside the fake home and the archive
// lands in a scratch folder — nothing here can touch the real chats.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_HOME = mkdtempSync(join(tmpdir(), 'chat-archive-home-'));
const COGYARD = join(FAKE_HOME, '.cogyard');
process.env.HOME = FAKE_HOME;
process.env.COGYARD_HOME = COGYARD;
process.env.COGYARD_DRIVER = 'claude';

const CONV = join(FAKE_HOME, '.claude', 'projects');
const RECORDS = join(FAKE_HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const ARCHIVE = join(COGYARD, 'chat-archive');

const { manifest } = await import('../extras/addons/chat-archive/addon.mjs');
const { runArchive, readManifest, readHeartbeat } = await import('../extras/addons/chat-archive/archive.mjs');

function put(file, text, mtime) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  if (mtime) utimesSync(file, mtime, mtime);
}

// Every file under dir with its size and mtime — to prove a run left a tree alone.
function snapshot(dir) {
  const out = {};
  for (const rel of readdirSync(dir, { recursive: true })) {
    const st = statSync(join(dir, String(rel)));
    if (st.isFile()) out[rel] = `${st.size}:${st.mtimeMs}`;
  }
  return out;
}

const run = () => manifest.runScheduled({}, { log: () => {} });
const old = new Date('2026-06-01T00:00:00Z');

beforeEach(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
  put(join(CONV, '-Users-x-proj', 'aaa.jsonl'), '{"a":1}\n', old);
  put(join(CONV, '-Users-x-proj', 'aaa', 'subagents', 'agent-1.jsonl'), '{"sub":1}\n', old);
  put(join(CONV, '-Users-x-other', 'bbb.jsonl'), '{"b":1}\n', old);
  put(join(RECORDS, 'u1', 'w1', 'local_aaa.json'), '{"cliSessionId":"aaa","title":"A"}', old);
});

test('first run copies both stores, layout preserved, counts match the source', async () => {
  const r = await run();
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /^4 files copied, 0 already current/);
  assert.equal(readFileSync(join(ARCHIVE, 'conversations', '-Users-x-proj', 'aaa', 'subagents', 'agent-1.jsonl'), 'utf8'), '{"sub":1}\n');
  assert.ok(existsSync(join(ARCHIVE, 'chat-records', 'u1', 'w1', 'local_aaa.json')));
  // The copy keeps the source's modification time.
  assert.equal(statSync(join(ARCHIVE, 'conversations', '-Users-x-other', 'bbb.jsonl')).mtime.getTime(), old.getTime());
  const m = readManifest(ARCHIVE);
  assert.equal(Object.keys(m.files).length, 4);
  const e = m.files['conversations/-Users-x-proj/aaa.jsonl'];
  assert.equal(e.size, 8);
  assert.match(e.sha256, /^[0-9a-f]{64}$/);
  assert.equal(e.goneFromSource, null);
  assert.equal(readHeartbeat(ARCHIVE).outcome, 'written');
});

test('a second run with nothing new copies nothing and still records that it looked', async () => {
  await run();
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.match(r.summary, /^0 files copied, 4 already current/);
  const hb = readHeartbeat(ARCHIVE);
  assert.equal(hb.outcome, 'unchanged');
  assert.equal(hb.job, 'chat-archive');
  assert.match(hb.note, /0 files copied, 4 already current/);
});

test('a grown conversation is recopied', async () => {
  await run();
  put(join(CONV, '-Users-x-proj', 'aaa.jsonl'), '{"a":1}\n{"a":2}\n');
  const r = await run();
  assert.match(r.summary, /^1 file copied, 3 already current/);
  assert.equal(readFileSync(join(ARCHIVE, 'conversations', '-Users-x-proj', 'aaa.jsonl'), 'utf8'), '{"a":1}\n{"a":2}\n');
});

test('a file deleted from the source stays in the archive, marked gone', async () => {
  await run();
  rmSync(join(CONV, '-Users-x-other', 'bbb.jsonl'));
  const r = await run();
  assert.equal(r.ok, true);
  assert.match(r.summary, /1 gone from source \(1 new tonight\)/);
  assert.equal(readFileSync(join(ARCHIVE, 'conversations', '-Users-x-other', 'bbb.jsonl'), 'utf8'), '{"b":1}\n');
  const gone = readManifest(ARCHIVE).files['conversations/-Users-x-other/bbb.jsonl'].goneFromSource;
  assert.ok(gone);
  // Marked once, not re-stamped every night.
  const again = await run();
  assert.match(again.summary, /1 gone from source \(0 new tonight\)/);
  assert.equal(readManifest(ARCHIVE).files['conversations/-Users-x-other/bbb.jsonl'].goneFromSource, gone);
  assert.match(manifest.status().summary, /1 gone from the agent's folders/);
});

test('a source that shrank keeps the previous copy beside the new one', async () => {
  await run();
  put(join(CONV, '-Users-x-proj', 'aaa.jsonl'), '{}\n');
  const r = await run();
  assert.match(r.summary, /1 previous version kept/);
  const dir = join(ARCHIVE, 'conversations', '-Users-x-proj');
  const kept = readdirSync(dir).filter((f) => f.startsWith('aaa.jsonl.kept-'));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), '{"a":1}\n');
  assert.equal(readFileSync(join(dir, 'aaa.jsonl'), 'utf8'), '{}\n');
});

test('a run never writes inside the agent\'s folders', async () => {
  const before = { conv: snapshot(CONV), rec: snapshot(RECORDS) };
  await run();
  rmSync(join(CONV, '-Users-x-other', 'bbb.jsonl'));
  delete before.conv[join('-Users-x-other', 'bbb.jsonl')];
  await run();
  assert.deepEqual(snapshot(CONV), before.conv);
  assert.deepEqual(snapshot(RECORDS), before.rec);
});

test('a lost manifest does not recopy what the archive already holds', async () => {
  await run();
  rmSync(join(ARCHIVE, 'manifest.json'));
  const r = await run();
  assert.match(r.summary, /^0 files copied, 4 already current/);
  assert.equal(Object.keys(readManifest(ARCHIVE).files).length, 4);
});

test('a run stopped part-way marks nothing gone', async () => {
  await run();
  rmSync(join(CONV, '-Users-x-other', 'bbb.jsonl'));
  const ac = new AbortController();
  ac.abort();
  const r = await runArchive({ archiveDir: ARCHIVE, trees: [{ name: 'conversations', root: CONV }], signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.equal(readManifest(ARCHIVE).files['conversations/-Users-x-other/bbb.jsonl'].goneFromSource, null);
});

test('refuses when the archive and a source folder overlap', async () => {
  await assert.rejects(
    runArchive({ archiveDir: join(CONV, 'archive'), trees: [{ name: 'conversations', root: CONV }] }),
    /overlap/,
  );
});

test('a missing conversations folder is reported, not silently clean', async () => {
  rmSync(CONV, { recursive: true, force: true });
  const r = await run();
  assert.equal(r.ok, false);
  assert.match(r.summary, /conversations folder not found/);
  assert.equal(readHeartbeat(ARCHIVE).outcome, 'failed');
});
