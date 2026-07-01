// Tests for inferStatus — the heuristic backfill for pre-frontmatter tasks.
// Fake paths are fine: statSync calls are wrapped in try/catch and only used
// as last-resort signals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferStatus } from '../core/analyze.mjs';

const mk = (body) => ({ path: '/nonexistent/task.md', body });

test('prose status line wins', () => {
  assert.equal(inferStatus(mk('**Status: DONE.** shipped')).status, 'DONE');
  assert.equal(inferStatus(mk('**Status: PARKED.**')).status, 'PARKED');
});

test('done date extracted from body', () => {
  const r = inferStatus(mk('# 5: thing\n\nDONE (2026-01-15)'));
  assert.equal(r.status, 'DONE');
  assert.equal(r.doneDate, '2026-01-15');
});

test('checkbox ratios drive status', () => {
  assert.equal(inferStatus(mk('- [x] a\n- [x] b\n- [x] c')).status, 'DONE');       // all ticked, ≥3
  assert.equal(inferStatus(mk('- [ ] a\n- [ ] b\n- [ ] c')).status, 'OPEN');       // none ticked
  assert.equal(inferStatus(mk('- [x] a\n- [ ] b\n- [ ] c')).status, 'OPEN');       // partial
});

test('title extracted from heading, id prefix stripped', () => {
  const r = inferStatus(mk('# 12: Working-tree file actions\n\n- [ ] x\n- [ ] y\n- [ ] z'));
  assert.equal(r.title, 'Working-tree file actions');
});

test('path hints harvested and trimmed of punctuation', () => {
  const r = inferStatus(mk('Touch `server/routes/git.mjs`, and (frontend/src/app/graph/graph.ts).'));
  assert.ok(r.paths.includes('server/routes/git.mjs'));
  assert.ok(r.paths.includes('frontend/src/app/graph/graph.ts'));
});

test('no signal defaults to OPEN with a reason', () => {
  const r = inferStatus(mk('just prose, nothing else'));
  assert.equal(r.status, 'OPEN');
  assert.ok(r.reasons.length > 0);
});
