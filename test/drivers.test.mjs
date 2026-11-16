// test/drivers.test.mjs — the agent-driver seam.
// Covers the no-op adapter path, the Claude reference adapter's seams, and
// the active-adapter resolution order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOOP, resolveActive, loadAdapter, listDriverNames, agentSession, currentSessionId } from '../core/drivers.mjs';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A stand-in for the agent CLI: it never calls anything, it just records the
// argv it was handed and answers in the CLI's own JSON envelope. That lets the
// invocation itself be asserted — which flags are passed, and how the result is
// read back — without spending money or needing the machine to be logged in.
// A stub that speaks the streaming protocol the adapter now reads: line-delimited
// events, the answer in a final `type:'result'` envelope. Shape verified against
// the real binary 2026-09-04 (see the run() comment in drivers/claude/adapter.mjs).
function stubAgent({ modelUsage, result = 'STUB OK' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cogyard-agent-stub-'));
  const argvOut = join(dir, 'argv.json');
  const bin = join(dir, 'claude');
  const lines = [
    { type: 'system', subtype: 'init' },
    { type: 'stream_event', event: {} },
    {
      type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01,
      modelUsage: modelUsage || { 'model-only': { outputTokens: 5 } },
    },
  ];
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    `require('fs').writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));`,
    `process.stdout.write(${JSON.stringify(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')});`,
  ].join('\n'));
  chmodSync(bin, 0o755);
  return { bin, argvOut };
}

// --- the no-op adapter: the engine must run with NO agent active --------------

test('no-op adapter: every seam returns its documented "off" value', () => {
  assert.equal(NOOP.name, 'none');
  assert.equal(NOOP.detect(), false);
  assert.equal(NOOP.worktree.detect('/any/.claude/worktrees/x'), null);
  assert.equal(NOOP.worktree.branchPrefix, null);
  assert.equal(NOOP.transcripts.supported, false);
  assert.equal(NOOP.transcripts.root(), null);
  assert.deepEqual(NOOP.transcripts.list(), []);
  assert.deepEqual(NOOP.transcripts.findBySession('s'), []);
  assert.equal(NOOP.transcripts.parseLine('{"type":"assistant"}'), null);
  assert.deepEqual(NOOP.pricing.versions, []);
  assert.deepEqual(NOOP.pricing.aliases, {});
  assert.equal(NOOP.sessions.supported, false);
  assert.equal(NOOP.sessions.root(), null);
  assert.equal(NOOP.agent.supported, false);
});

test('no-op adapter: agent.run reports no driver instead of throwing', async () => {
  const r = await NOOP.agent.run({ prompt: 'anything' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no agent driver active');
  assert.equal(r.text, '');
  assert.equal(r.cost, null);
});

// --- resolution order ---------------------------------------------------------

test('resolveActive honors COGYARD_DRIVER=none → no-op', async () => {
  const prev = process.env.COGYARD_DRIVER;
  process.env.COGYARD_DRIVER = 'none';
  try { assert.equal((await resolveActive()).name, 'none'); }
  finally { if (prev === undefined) delete process.env.COGYARD_DRIVER; else process.env.COGYARD_DRIVER = prev; }
});

test('resolveActive degrades to no-op for an unknown driver name', async () => {
  const prev = process.env.COGYARD_DRIVER;
  process.env.COGYARD_DRIVER = 'does-not-exist';
  try { assert.equal((await resolveActive()).name, 'none'); }
  finally { if (prev === undefined) delete process.env.COGYARD_DRIVER; else process.env.COGYARD_DRIVER = prev; }
});

test('the claude driver is discoverable on disk', () => {
  assert.ok(listDriverNames().includes('claude'));
});

// --- the Claude reference adapter: the three seams ----------------------------

test('claude.worktree.detect parses the worktree layout', async () => {
  const claude = await loadAdapter('claude');
  assert.deepEqual(
    claude.worktree.detect('/Users/x/proj/.claude/worktrees/task-9-foo/sub/dir'),
    { parentRepo: '/Users/x/proj', name: 'task-9-foo' },
  );
  assert.equal(claude.worktree.detect('/Users/x/proj'), null);
  assert.equal(claude.worktree.detect(null), null);
  assert.equal(claude.worktree.branchPrefix, 'claude/');
});

test('claude: both stores a chat archive copies have a root', async () => {
  const claude = await loadAdapter('claude');
  assert.match(claude.transcripts.root(), /\/\.claude\/projects$/);
  assert.match(claude.sessions.root(), /\/Claude\/claude-code-sessions$/);
});

test('claude.transcripts.parseLine: assistant turn → normalized usage', async () => {
  const claude = await loadAdapter('claude');
  const line = JSON.stringify({
    type: 'assistant', sessionId: 'S1', cwd: '/repo', requestId: 'r1', timestamp: '2026-06-19T00:00:00Z',
    message: { id: 'm1', model: 'claude-opus-4-8', usage: {
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 },
    } },
  });
  const p = claude.transcripts.parseLine(line);
  assert.equal(p.sessionId, 'S1');
  assert.equal(p.cwd, '/repo');
  assert.equal(p.usage.model, 'claude-opus-4-8');
  assert.equal(p.usage.dedupeKey, 'r1:m1');
  assert.deepEqual(p.usage.tokens, { input: 100, output: 50, cacheRead: 10, cacheWrite5m: 7, cacheWrite1h: 3 });
});

test('claude.transcripts.parseLine: non-assistant line → sessionId/cwd, no usage', async () => {
  const claude = await loadAdapter('claude');
  const p = claude.transcripts.parseLine(JSON.stringify({ type: 'user', sessionId: 'S2', cwd: '/r' }));
  assert.equal(p.sessionId, 'S2');
  assert.equal(p.cwd, '/r');
  assert.equal(p.usage, null);
});

test('claude.transcripts.parseLine: synthetic + torn lines are skipped/safe', async () => {
  const claude = await loadAdapter('claude');
  // <synthetic> model carries no billable usage.
  const synth = claude.transcripts.parseLine(JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: {} } }));
  assert.equal(synth.usage, null);
  // Unparseable line → null (collect loop skips it).
  assert.equal(claude.transcripts.parseLine('{not json'), null);
});

// worktreesTouched (2026-09-18): the worktrees a turn's OWN tool calls name.
// An autopilot orchestrator creates worktrees with `git worktree add` from the
// main checkout and drives them with `git -C …` — it never changes directory
// into them, so cwd says nothing. Its commands are the evidence.
test('claude.transcripts.parseLine: worktrees named in the turn\'s own tool calls', async () => {
  const claude = await loadAdapter('claude');
  const line = JSON.stringify({
    type: 'assistant', sessionId: 'S3', cwd: '/Users/b/gitroot/proj',
    message: { model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 }, content: [
      { type: 'text', text: 'making the integration worktree' },
      { type: 'tool_use', name: 'Bash', input: {
        command: 'R=/Users/b/gitroot/proj\ngit -C "$R" worktree add "$R/.claude/worktrees/autopilot-int-0909b" -b x main && cd .claude/worktrees/task-047-alert && npm test',
        description: 'create it' } },
      { type: 'tool_use', name: 'EnterWorktree', input: { name: 'task-099-nightly-database-backup' } },
    ] },
  });
  const p = claude.transcripts.parseLine(line);
  assert.deepEqual([...p.worktreesTouched].sort(), ['autopilot-int-0909b', 'task-047-alert', 'task-099-nightly-database-backup']);
});

test('claude.transcripts.parseLine: a tool RESULT naming worktrees does NOT count', async () => {
  // `git worktree list` output names every worktree on the machine, and a grep
  // echoes whatever it searched for. Results are the agent's INPUT, not its
  // actions — counting them would credit every chat with every worktree.
  const claude = await loadAdapter('claude');
  const result = JSON.stringify({
    type: 'user', sessionId: 'S3', cwd: '/r', toolUseResult: { ok: true },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1',
      content: '/Users/b/gitroot/proj/.claude/worktrees/autopilot-int-0909b  abc [x]\n/Users/b/gitroot/proj/.claude/worktrees/task-001-foo  def [y]' }] },
  });
  assert.deepEqual(claude.transcripts.parseLine(result).worktreesTouched, []);
  // And a plain assistant turn with no tool calls reports none.
  const plain = claude.transcripts.parseLine(JSON.stringify({ type: 'assistant', message: { model: 'm', usage: {}, content: [{ type: 'text', text: 'see .claude/worktrees/task-001-foo' }] } }));
  assert.deepEqual(plain.worktreesTouched, []);
});

test('claude.pricing: table + aliases present and well-formed', async () => {
  const claude = await loadAdapter('claude');
  assert.ok(claude.pricing.versions.length >= 1);
  assert.ok(claude.pricing.versions[0].models['claude-opus-4-8']);
  assert.equal(claude.pricing.aliases.opus, 'claude-opus-4-8');
});

// --- the agent seam -----------------------------------------------------------
// These deliberately never reach a live agent: a test suite must not spend money
// or depend on the machine being logged in. What IS the contract, and what these
// cover, is that every failure comes back as { ok: false, error } rather than a
// throw — the property a scheduled job depends on to survive a bad night.

test('claude.agent: declared supported with a callable run', async () => {
  const claude = await loadAdapter('claude');
  assert.equal(claude.agent.supported, true);
  assert.equal(typeof claude.agent.run, 'function');
});

test('claude.agent.run: empty prompt is rejected without spawning', async () => {
  const claude = await loadAdapter('claude');
  for (const prompt of [undefined, '', '   ']) {
    const r = await claude.agent.run({ prompt });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'empty prompt');
  }
  assert.equal((await claude.agent.run()).error, 'empty prompt');
});

test('claude.agent.run: an aborted signal terminates the call, no throw', async () => {
  const claude = await loadAdapter('claude');
  const r = await claude.agent.run({ prompt: 'hello', signal: AbortSignal.abort() });
  assert.equal(r.ok, false);
  // 'cancelled', not 'stalled' or 'no-response': the caller withdrew the request,
  // which says nothing about whether the agent was reachable.
  assert.equal(r.failure, 'cancelled');
  assert.equal(r.text, '');
});


// --- the invocation itself ----------------------------------------------------

test('claude.agent.run: the CLI is located even when PATH cannot reach it', async () => {
  // The failure this prevents: the always-on portal is a LaunchAgent, whose PATH
  // is a short fixed list that does not include ~/.local/bin, where Claude Code
  // installs itself. Bare spawn('claude') gave ENOENT in production while the
  // same call from a terminal worked (observed 2026-08-19). A missing binary
  // must say what to do about it, not surface a raw spawn error.
  const claude = await loadAdapter('claude');
  const prev = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = join(tmpdir(), 'definitely-not-installed-claude');
  try {
    const r = await claude.agent.run({ prompt: 'hello' });
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/i);
    assert.match(r.error, /CLAUDE_CODE_BIN/);
    assert.equal(r.cost, null);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = prev;
  }
});

test('claude.agent.run: runs with --safe-mode, so no CLAUDE.md can hijack the job', async () => {
  // Without it the CLI auto-discovers the user's CLAUDE.md and obeys it. Those
  // files instruct an interactive session with tools ("read the file first"),
  // which a tool-less job cannot do — so it answered with a tool call instead of
  // the answer, and the caller's parser discarded it as unparseable.
  const claude = await loadAdapter('claude');
  const { bin, argvOut } = stubAgent();
  const prev = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = bin;
  try {
    const r = await claude.agent.run({ prompt: 'hello' });
    assert.equal(r.ok, true);
    const argv = JSON.parse(await import('node:fs').then((m) => m.readFileSync(argvOut, 'utf8')));
    assert.ok(argv.includes('--safe-mode'), `--safe-mode missing from ${argv.join(' ')}`);
    assert.ok(argv.includes('--tools'), 'the tool-less contract must survive');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = prev;
  }
});

test('claude.agent.run: reports the model that ANSWERED, not the first one billed', async () => {
  // modelUsage routinely carries an auxiliary model alongside the one that wrote
  // the text, and the auxiliary one is often first. Reading key[0] reported a
  // sonnet answer as haiku (observed 2026-08-19).
  const claude = await loadAdapter('claude');
  const { bin } = stubAgent({
    modelUsage: {
      'aux-small-model': { outputTokens: 12 },
      'the-answering-model': { outputTokens: 480 },
    },
  });
  const prev = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = bin;
  try {
    const r = await claude.agent.run({ prompt: 'hello' });
    assert.equal(r.model, 'the-answering-model');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = prev;
  }
});

test('claude.agent.run: runs in the caller-named folder, else a neutral one', async () => {
  // Task 130: the transcript records the folder the call ran in, and that is how
  // the usage ledger files a scheduled job's call under the job. The stub writes
  // its own working directory where the test can read it.
  const { realpathSync, readFileSync, mkdirSync } = await import('node:fs');
  const claude = await loadAdapter('claude');
  const dir = mkdtempSync(join(tmpdir(), 'cogyard-agent-cwd-'));
  const bin = join(dir, 'claude');
  const cwdOut = join(dir, 'cwd.txt');
  const result = { type: 'result', is_error: false, result: 'OK', total_cost_usd: 0, modelUsage: { m: { outputTokens: 1 } } };
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    `require('fs').writeFileSync(${JSON.stringify(cwdOut)}, process.cwd());`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(result) + '\n')});`,
  ].join('\n'));
  chmodSync(bin, 0o755);
  const runDir = join(dir, 'run', 'some-job');
  mkdirSync(runDir, { recursive: true });
  const prev = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = bin;
  try {
    assert.equal((await claude.agent.run({ prompt: 'hello', cwd: runDir })).ok, true);
    assert.equal(readFileSync(cwdOut, 'utf8'), realpathSync(runDir));
    assert.equal((await claude.agent.run({ prompt: 'hello' })).ok, true);
    assert.equal(readFileSync(cwdOut, 'utf8'), realpathSync(tmpdir()));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = prev;
  }
});

// --- agentSession: is an agent running this process? (task 170) --------------

const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR'];
async function withSessionEnv(values, fn) {
  const prev = Object.fromEntries(SESSION_VARS.map((k) => [k, process.env[k]]));
  for (const k of SESSION_VARS) delete process.env[k];
  Object.assign(process.env, values);
  try { await fn(); } finally {
    for (const k of SESSION_VARS) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

test('no-op adapter: inSession is false', () => {
  assert.equal(NOOP.inSession(), false);
});

test('claude.inSession: true only when Claude Code started the process', async () => {
  const claude = await loadAdapter('claude');
  await withSessionEnv({}, () => assert.equal(claude.inSession(), false));
  for (const k of SESSION_VARS) {
    await withSessionEnv({ [k]: '1' }, () => assert.equal(claude.inSession(), true, k));
  }
});

test('agentSession names the agent, or null from a human shell — whatever the active driver is', async () => {
  const prevDriver = process.env.COGYARD_DRIVER;
  process.env.COGYARD_DRIVER = 'none';
  try {
    await withSessionEnv({}, async () => assert.equal(await agentSession(), null));
    await withSessionEnv({ CLAUDECODE: '1' }, async () => assert.equal(await agentSession(), 'claude'));
  } finally {
    if (prevDriver === undefined) delete process.env.COGYARD_DRIVER; else process.env.COGYARD_DRIVER = prevDriver;
  }
});

// --- currentSessionId: which chat is running this process? (task 225) ---------

async function withChatId(value, fn) {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  if (value === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = value;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
}

test('no-op adapter: sessionId is null', () => {
  assert.equal(NOOP.sessionId(), null);
});

test('claude.sessionId: the chat id Claude Code exports, else null', async () => {
  const claude = await loadAdapter('claude');
  await withChatId(undefined, () => assert.equal(claude.sessionId(), null));
  await withChatId('abc-123', () => assert.equal(claude.sessionId(), 'abc-123'));
});

test('currentSessionId answers whatever the active driver is, null from a human shell', async () => {
  const prevDriver = process.env.COGYARD_DRIVER;
  process.env.COGYARD_DRIVER = 'none';
  try {
    await withChatId(undefined, async () => assert.equal(await currentSessionId(), null));
    await withChatId('abc-123', async () => assert.equal(await currentSessionId(), 'abc-123'));
  } finally {
    if (prevDriver === undefined) delete process.env.COGYARD_DRIVER; else process.env.COGYARD_DRIVER = prevDriver;
  }
});
