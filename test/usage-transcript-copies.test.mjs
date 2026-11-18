// test/usage-transcript-copies.test.mjs — a chat whose transcript exists in two
// project folders is counted once (task 257).
//
// When a chat moves from a project's main folder into a worktree mid-way,
// Claude Code keeps one transcript file under EACH project folder: the second
// starts as a copy of the first and carries on. The collector tracked each file
// on its own, so every message in the shorter copy was charged twice (77 chats,
// ~$2,030, measured 2026-11-16). Helper-agent transcripts also carry the chat's
// session id but hold different messages; they must still count.
//
// Real CLI runs against a throwaway HOME (the claude driver finds transcripts
// under $HOME/.claude/projects) and a throwaway COGYARD_HOME.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'cli', 'usage.mjs');

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-transcript-copies-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));

// Each case gets its own HOME and COGYARD_HOME, so cases never share a ledger.
function sandbox(name) {
  const home = join(ROOT, name);
  const cogyard = join(home, '.cogyard');
  const projects = join(home, '.claude', 'projects');
  mkdirSync(join(cogyard, 'usage'), { recursive: true });
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(cogyard, 'projects.json'), '[]');
  const env = { ...process.env, HOME: home, COGYARD_HOME: cogyard, COGYARD_DRIVER: 'claude' };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const ledger = () => {
    const p = join(cogyard, 'usage', 'usage.jsonl');
    return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { projects, run, ledger };
}

// Lines of a chat: message i of chat `sid`, from helper `agent` (null = the chat itself).
function lines(sid, from, to, agent = null) {
  const out = [];
  for (let i = from; i < to; i++) {
    const tag = agent ? `${agent}-${i}` : String(i);
    out.push(JSON.stringify({
      type: 'assistant', sessionId: sid, cwd: '/somewhere', requestId: `req-${sid}-${tag}`,
      timestamp: `2026-11-16T12:${String(i).padStart(2, '0')}:00Z`,
      message: { id: `msg-${sid}-${tag}`, model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } },
    }));
  }
  return out;
}
// A resumed or forked chat `to` replaying chat `from`'s messages i..to-1: the
// same request and message ids, re-stamped with the new chat's id.
function replay(from, to, start, end) {
  return lines(from, start, end).map((l) => JSON.stringify({ ...JSON.parse(l), sessionId: to }));
}
const write = (file, ls) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ls.join('\n') + '\n'); };
// Make `file` look older than files written after it, on any filesystem.
const age = (file, secondsAgo) => { const t = new Date(Date.now() - secondsAgo * 1000); utimesSync(file, t, t); };
const counted = (rows, sid) => rows.filter((r) => r.sessionId === sid).reduce((n, r) => n + r.messages, 0);

test('a copy that appears after the original was counted adds only its new messages', () => {
  const { projects, run, ledger } = sandbox('later-copy');
  const main = join(projects, '-repo', 'chat-a.jsonl');
  write(main, lines('chat-a', 0, 10));
  run('collect');
  assert.equal(counted(ledger(), 'chat-a'), 10);

  // The chat moves into a worktree: its folder gets a copy that carries on.
  write(join(projects, '-repo--claude-worktrees-task-1', 'chat-a.jsonl'), lines('chat-a', 0, 15));
  run('collect');
  assert.equal(counted(ledger(), 'chat-a'), 15, 'messages 0–9 are in both files and count once');
});

test('two copies found in the same run count once, whichever is read first', () => {
  const { projects, run, ledger } = sandbox('same-run');
  write(join(projects, '-repo', 'chat-b.jsonl'), lines('chat-b', 0, 12));
  write(join(projects, '-repo--claude-worktrees-task-2', 'chat-b.jsonl'), lines('chat-b', 0, 12));
  write(join(projects, '-repo', 'chat-c.jsonl'), lines('chat-c', 0, 4));
  write(join(projects, '-repo--claude-worktrees-task-3', 'chat-c.jsonl'), lines('chat-c', 0, 9));
  run('collect');
  assert.equal(counted(ledger(), 'chat-b'), 12, 'identical copies');
  assert.equal(counted(ledger(), 'chat-c'), 9, 'one copy longer than the other');
});

test("a helper agent's transcript under the chat's session id still counts", () => {
  const { projects, run, ledger } = sandbox('helper');
  write(join(projects, '-repo', 'chat-d.jsonl'), lines('chat-d', 0, 5));
  write(join(projects, '-repo--claude-worktrees-task-4', 'chat-d.jsonl'), lines('chat-d', 0, 5));
  write(join(projects, '-repo', 'chat-d', 'subagents', 'agent-x.jsonl'), lines('chat-d', 0, 7, 'x'));
  run('collect');
  assert.equal(counted(ledger(), 'chat-d'), 5 + 7);
});

test('repair recounts a chat in two folders once', () => {
  const { projects, run, ledger } = sandbox('repair');
  write(join(projects, '-repo', 'chat-e.jsonl'), lines('chat-e', 0, 6));
  write(join(projects, '-repo--claude-worktrees-task-5', 'chat-e.jsonl'), lines('chat-e', 0, 8));
  run('repair');
  assert.equal(counted(ledger(), 'chat-e'), 8);
  run('collect');
  assert.equal(counted(ledger(), 'chat-e'), 8, 'a collect after the repair adds nothing');
});

// --- resumed and forked chats (task 257, Phase 3) ---------------------------
// A resumed chat's new file, under a NEW name, replays the earlier messages
// with the new chat's id. Nothing in it names the old chat; the request ids are
// the only link, so each billed request is counted once across all transcripts.

test('a resumed chat replaying earlier messages adds only its new ones, across runs', () => {
  const { projects, run, ledger } = sandbox('resumed-later');
  write(join(projects, '-repo', 'old-chat.jsonl'), lines('old-chat', 0, 8));
  run('collect');
  write(join(projects, '-repo', 'new-chat.jsonl'), [...replay('old-chat', 'new-chat', 0, 8), ...lines('new-chat', 8, 12)]);
  run('collect');
  const rows = ledger();
  assert.equal(counted(rows, 'old-chat'), 8, 'the first chat keeps its messages');
  assert.equal(counted(rows, 'new-chat'), 4, 'the resumed chat is charged only for what it added');
});

test('both files found in one run: the replayed messages stay with the older chat', () => {
  const { projects, run, ledger } = sandbox('resumed-same-run');
  // Named so the resumed file sorts FIRST; the older file must still win.
  const older = join(projects, '-repo', 'zz-old.jsonl');
  write(older, lines('zz-old', 0, 8));
  age(older, 3600);
  write(join(projects, '-repo', 'aa-new.jsonl'), [...replay('zz-old', 'aa-new', 0, 8), ...lines('aa-new', 8, 11)]);
  run('collect');
  assert.equal(counted(ledger(), 'zz-old'), 8);
  assert.equal(counted(ledger(), 'aa-new'), 3);
});

test('a helper log copied into both folders counts once', () => {
  const { projects, run, ledger } = sandbox('helper-copy');
  write(join(projects, '-repo', 'chat-h.jsonl'), lines('chat-h', 0, 3));
  write(join(projects, '-repo', 'chat-h', 'subagents', 'agent-y.jsonl'), lines('chat-h', 0, 6, 'y'));
  write(join(projects, '-repo--claude-worktrees-task-6', 'chat-h', 'subagents', 'agent-y.jsonl'), lines('chat-h', 0, 6, 'y'));
  run('collect');
  assert.equal(counted(ledger(), 'chat-h'), 3 + 6);
});

test('the index of counted requests is rebuilt when missing, so nothing is counted again', () => {
  const { projects, run, ledger } = sandbox('index-missing');
  write(join(projects, '-repo', 'first.jsonl'), lines('first', 0, 5));
  run('collect');
  const index = join(projects, '..', '..', '.cogyard', 'usage', 'counted-keys');
  assert.ok(existsSync(index), 'collect writes the index');
  rmSync(index); // as on the first run after upgrading
  write(join(projects, '-repo', 'second.jsonl'), [...replay('first', 'second', 0, 5), ...lines('second', 5, 7)]);
  run('collect');
  assert.equal(counted(ledger(), 'first'), 5);
  assert.equal(counted(ledger(), 'second'), 2);
});

test('repair charges replayed messages once, to the older chat', () => {
  const { projects, run, ledger } = sandbox('resumed-repair');
  const older = join(projects, '-repo', 'zz-orig.jsonl');
  write(older, lines('zz-orig', 0, 6));
  age(older, 3600);
  write(join(projects, '-repo', 'aa-fork.jsonl'), [...replay('zz-orig', 'aa-fork', 0, 6), ...lines('aa-fork', 6, 9)]);
  run('repair');
  assert.equal(counted(ledger(), 'zz-orig'), 6);
  assert.equal(counted(ledger(), 'aa-fork'), 3);
  run('collect');
  assert.equal(counted(ledger(), 'zz-orig') + counted(ledger(), 'aa-fork'), 9, 'a collect after the repair adds nothing');
});

test('repair drops the old rows of a resumed chat that only replayed, even with no recount rows of its own', () => {
  const { projects, run, ledger } = sandbox('replay-only');
  const older = join(projects, '-repo', 'zz-first.jsonl');
  write(older, lines('zz-first', 0, 6));
  age(older, 3600);
  write(join(projects, '-repo', 'aa-replay.jsonl'), replay('zz-first', 'aa-replay', 0, 6));
  // The ledger as the old collector left it: the replay counted a second time.
  writeFileSync(join(projects, '..', '..', '.cogyard', 'usage', 'usage.jsonl'), JSON.stringify({
    capturedAt: '2026-11-01T00:00:00Z', sessionId: 'aa-replay', project: null, worktree: null, taskId: null,
    model: 'claude-opus-4-8', tokens: { input: 600, output: 300, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    costUSD: 1, pricingVersion: 'v', backfilled: false, firstTs: '2026-11-16T12:00:00Z', lastTs: '2026-11-16T12:05:00Z', messages: 6,
  }) + '\n');
  run('repair');
  assert.equal(counted(ledger(), 'aa-replay'), 0, "the replay-only chat's old row is gone");
  assert.equal(counted(ledger(), 'zz-first'), 6);
});
