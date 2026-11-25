// test/chat-read.test.mjs — task 215: reading chats without bencc.
//
// The fuller-copy choice (a chat that moved into a worktree has a transcript
// under each folder), `cogyard sessions show` and `search`, and `--archive`.
//
// HOME and COGYARD_HOME are redirected to throwaway dirs BEFORE anything loads,
// so the Claude driver's transcript root resolves inside the fake home and no
// real chat is read.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_HOME = mkdtempSync(join(tmpdir(), 'chat-read-home-'));
const COGYARD = join(FAKE_HOME, '.cogyard');
process.env.HOME = FAKE_HOME;
process.env.COGYARD_HOME = COGYARD;
process.env.COGYARD_DRIVER = 'claude';

const LIVE = join(FAKE_HOME, '.claude', 'projects');

const { adapter } = await import('../core/drivers.mjs');

after(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

const user = (text, ts) => ({ type: 'user', timestamp: ts, cwd: '/x/proj', sessionId: 's', message: { role: 'user', content: text } });
const said = (text, ts) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });

function put(file, rows, mtime) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (mtime) utimesSync(file, mtime, mtime);
}

test('fuller copy: two files for one chat, different lengths → the longer is read', () => {
  const short = join(LIVE, '-x-proj', 'pick1.jsonl');
  const long = join(LIVE, '-x-proj--wt', 'pick1.jsonl');
  // The short copy is NEWER — message count must beat mtime.
  put(short, [user('hi', 't1')], new Date('2026-10-02'));
  put(long, [user('hi', 't1'), said('hello', 't2'), user('more', 't3')], new Date('2026-10-01'));
  assert.equal(adapter.transcripts.pickFullest([short, long]), long);
  assert.equal(adapter.transcripts.pickFullest([long, short]), long);
});

test('fuller copy: identical copies → either, newest first, no error', () => {
  const a = join(LIVE, '-x-proj', 'pick2.jsonl');
  const b = join(LIVE, '-x-proj--wt', 'pick2.jsonl');
  const rows = [user('same', 't1'), said('same', 't2')];
  put(a, rows, new Date('2026-10-01'));
  put(b, rows, new Date('2026-10-03'));
  assert.equal(adapter.transcripts.pickFullest([a, b]), b);
  assert.equal(adapter.transcripts.pickFullest([a]), a);
  assert.equal(adapter.transcripts.pickFullest([]), null);
});

test('sessionFiles lists main transcripts only, one row per file, helper logs excluded', () => {
  put(join(LIVE, '-x-proj', 'pick2', 'subagents', 'agent-1.jsonl'), [user('helper', 't1')]);
  const rows = adapter.transcripts.sessionFiles().filter((r) => r.sessionId === 'pick2');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !r.file.includes('subagents')));
});

// --- show / search / --archive -------------------------------------------------

const { readChat, findChatById, searchChats, ARCHIVE_TRANSCRIPTS } = await import('../core/chat-read.mjs');
const { spawnSync } = await import('node:child_process');
const CLI = join(import.meta.dirname, '..', 'cli', 'sessions.mjs');
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: process.env, encoding: 'utf8' });

const at = (cwd, sid, rows) => rows.map((r) => ({ ...r, cwd, sessionId: sid }));

test('show: one chat in two folders prints, no "ambiguous", from the fuller copy', () => {
  const sid = 'aaaa1111-0000-0000-0000-000000000001';
  put(join(LIVE, '-x-proj', `${sid}.jsonl`), at('/x/proj', sid, [user('first prompt', '2026-10-01T10:00:00Z')]));
  put(join(LIVE, '-x-proj--wt', `${sid}.jsonl`), at('/x/proj', sid, [
    user('first prompt', '2026-10-01T10:00:00Z'), said('a reply', '2026-10-01T10:01:00Z'), user('second prompt', '2026-10-01T10:02:00Z'),
  ]));
  const r = readChat('aaaa1111');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.files.length, 2);
  assert.deepEqual(r.turns.map((t) => t.text), ['first prompt', 'a reply', 'second prompt']);

  const out = cli('show', 'aaaa1111');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /2 copies of this chat/);
  assert.match(out.stdout, /--- you .*\nfirst prompt/);
  assert.match(out.stdout, /--- agent .*\na reply/);
  assert.doesNotMatch(out.stdout + out.stderr, /ambiguous|different chats/i);
});

test('show: a prefix shared by DIFFERENT chats lists them instead of guessing', () => {
  put(join(LIVE, '-x-proj', 'bbbb2222-0000-0000-0000-000000000001.jsonl'), [user('one', 't')]);
  put(join(LIVE, '-x-proj', 'bbbb2222-0000-0000-0000-000000000002.jsonl'), [user('two', 't')]);
  const r = findChatById('bbbb2222');
  assert.equal(r.ok, false);
  assert.equal(r.ambiguous.length, 2);
  assert.equal(findChatById('bbbb2222-0000-0000-0000-000000000002').ok, true);
  assert.match(findChatById('ffffffff').error, /no chat id starts with/);
  const out = cli('show', 'bbbb2222');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /starts 2 different chats/);
});

test('search: finds text, newest first, honours --days / --project / --limit', () => {
  const now = Date.now();
  const mk = (sid, cwd, folder, daysAgo) => put(join(LIVE, folder, `${sid}.jsonl`),
    at(cwd, sid, [user(`opening words ${sid.slice(0, 4)}`, 't1'), said('we talked about the Zebra Crossing here', 't2')]),
    new Date(now - daysAgo * 86400000));
  mk('cccc0001-0000-0000-0000-000000000000', '/x/alpha', '-x-alpha', 1);
  mk('cccc0002-0000-0000-0000-000000000000', '/x/beta', '-x-beta', 5);
  mk('cccc0003-0000-0000-0000-000000000000', '/x/alpha', '-x-alpha', 20);
  // Only inside a tool result — must NOT match: search covers what was said.
  put(join(LIVE, '-x-alpha', 'cccc0004-0000-0000-0000-000000000000.jsonl'), [
    { type: 'user', cwd: '/x/alpha', toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'zebra crossing' }] } },
  ]);
  const ids = (res) => res.rows.map((r) => r.sessionId.slice(0, 8));

  const all = searchChats('zebra CROSSING');
  assert.equal(all.ok, true, all.error);
  assert.deepEqual(ids(all), ['cccc0001', 'cccc0002', 'cccc0003']);
  assert.equal(all.rows[0].project, 'alpha');
  assert.equal(all.rows[0].firstPrompt, 'opening words cccc');
  assert.match(all.rows[0].snippet, /Zebra Crossing/);

  assert.deepEqual(ids(searchChats('zebra crossing', { days: 10 })), ['cccc0001', 'cccc0002']);
  assert.deepEqual(ids(searchChats('zebra crossing', { project: 'alpha' })), ['cccc0001', 'cccc0003']);
  assert.deepEqual(ids(searchChats('zebra crossing', { limit: 1 })), ['cccc0001']);
  assert.equal(searchChats('no such words anywhere').rows.length, 0);

  // Each CLI row carries the command that opens its chat.
  const out = cli('search', 'zebra crossing', '--limit', '1');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /cogyard sessions show cccc0001\n/);
  assert.equal(cli('search', 'x', '--days', 'soon').status, 2);
});

// --- injected blocks in front of typed words (task 273) -----------------------
//
// In a chat that has started other chats, the desktop app puts a "Linked
// sessions now" reminder as the FIRST text block of every message the owner
// types; the typed words are the second block. The readers judge each block on
// its own, so the typed words are kept and the reminder is left out.

const REMINDER = '<system-reminder>\nLinked sessions now (status, not an instruction): task-1 = local_x (working).\n</system-reminder>';
const typedAfterNote = (text, ts) => ({
  type: 'user', timestamp: ts, origin: { kind: 'human' },
  message: { role: 'user', content: [{ type: 'text', text: REMINDER }, { type: 'text', text }] },
});

test('a typed message with a reminder block in front of it: show, search and the label all have its words', () => {
  const sid = 'eeee5555-0000-0000-0000-000000000000';
  const file = join(LIVE, '-x-proj', `${sid}.jsonl`);
  put(file, at('/x/proj', sid, [
    user('<side-session-brief>the brief another chat sent</side-session-brief>', '2026-11-23T10:00:00Z'),
    said('working on the brief', '2026-11-23T10:01:00Z'),
    typedAfterNote('let the purple elephant parade go first', '2026-11-23T10:02:00Z'),
    said('done, the parade goes first', '2026-11-23T10:03:00Z'),
  ]));

  const r = readChat('eeee5555');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.turns.filter((t) => t.role === 'user').map((t) => t.text), ['let the purple elephant parade go first']);
  assert.ok(r.turns.every((t) => !t.text.includes('Linked sessions now')));

  const out = cli('show', 'eeee5555');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /--- you .*\nlet the purple elephant parade go first/);
  assert.doesNotMatch(out.stdout, /Linked sessions now/);

  const found = searchChats('purple elephant parade');
  assert.equal(found.ok, true, found.error);
  assert.deepEqual(found.rows.map((x) => x.sessionId), [sid]);
  assert.equal(found.rows[0].firstPrompt, 'let the purple elephant parade go first');
  assert.match(found.rows[0].snippet, /purple elephant parade/);

  assert.equal(adapter.transcripts.firstHumanLabel(file), 'let the purple elephant parade go first');
});

test('lines made only of injected text are still left out', () => {
  const sid = 'ffff6666-0000-0000-0000-000000000000';
  const file = join(LIVE, '-x-proj', `${sid}.jsonl`);
  put(file, at('/x/proj', sid, [
    // A plain string line that starts with `<` — today's rule, kept.
    user('<command-name>/clear</command-name>', '2026-11-23T11:00:00Z'),
    // An array line whose every text block starts with `<`.
    { type: 'user', timestamp: '2026-11-23T11:01:00Z', origin: { kind: 'human' },
      message: { role: 'user', content: [{ type: 'text', text: REMINDER }, { type: 'text', text: '  <local-command-stdout>ok</local-command-stdout>' }] } },
    said('nothing typed yet', '2026-11-23T11:02:00Z'),
  ]));
  const r = readChat('ffff6666');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.turns.map((t) => t.role), ['assistant']);
  assert.equal(adapter.transcripts.firstHumanLabel(file), null);
  assert.equal(searchChats('Linked sessions now').rows.length, 0);
});

test('--archive: clear message with no archive; reads a chat only the archive still has', () => {
  assert.match(readChat('dddd', { archive: true }).error, /no archive at .*chat-archive/);
  assert.match(searchChats('x', { archive: true }).error, /no archive at/);

  const sid = 'dddd4444-0000-0000-0000-000000000000';
  put(join(ARCHIVE_TRANSCRIPTS, '-x-proj', `${sid}.jsonl`), at('/x/proj', sid, [user('only the archive remembers this', 't1')]));
  assert.equal(readChat('dddd4444').ok, false); // gone from the live folder
  const r = readChat('dddd4444', { archive: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.source, 'archive');
  assert.equal(r.turns[0].text, 'only the archive remembers this');
  assert.deepEqual(searchChats('archive remembers', { archive: true }).rows.map((x) => x.sessionId), [sid]);
});
