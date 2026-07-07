// test/drivers.test.mjs — the agent-driver seam.
// Covers the no-op adapter path, the Claude reference adapter's three seams, and
// the active-adapter resolution order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOOP, resolveActive, loadAdapter, listDriverNames } from '../core/drivers.mjs';

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

test('claude.pricing: table + aliases present and well-formed', async () => {
  const claude = await loadAdapter('claude');
  assert.ok(claude.pricing.versions.length >= 1);
  assert.ok(claude.pricing.versions[0].models['claude-opus-4-8']);
  assert.equal(claude.pricing.aliases.opus, 'claude-opus-4-8');
});
