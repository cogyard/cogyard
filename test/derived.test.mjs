// Tests for computeDerived — checkbox counting (the "dashboard fraction lies"
// bug class), dependency gating, claim state, and readiness.
// repoRoot is omitted / staleOverride passed so no git runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDerived } from '../core/frontmatter.mjs';

const mkTask = (fm, body = '') => ({ path: `/x/${fm?.id ?? 'n'}-t.md`, frontmatter: fm, body, hasFrontmatter: !!fm });

test('checkbox counting: tolerant checked marks, strict unchecked', () => {
  const body = [
    '- [x] ascii',
    '- [X] caps',
    '- [✓] unicode check',
    '- [✅] emoji',
    '- [ ] open one',
    '- [ ] open two',
    '- [?] ambiguous — ignored',
    '- [wip] also ignored',
  ].join('\n');
  const d = computeDerived(mkTask({ id: 1, status: 'OPEN' }, body), [], null);
  assert.equal(d.checkedCount, 4);
  assert.equal(d.totalCount, 6); // 4 checked + 2 unchecked; [?]/[wip] excluded
  assert.equal(d.progressPct, 67);
});

test('no checkboxes → progressPct null', () => {
  const d = computeDerived(mkTask({ id: 1, status: 'OPEN' }, 'prose only'), [], null);
  assert.equal(d.totalCount, 0);
  assert.equal(d.progressPct, null);
});

test('depsMet: only DONE dependencies satisfy', () => {
  const dep = mkTask({ id: 9, status: 'DONE' });
  const notDone = mkTask({ id: 10, status: 'OPEN' });
  const all = [dep, notDone];
  assert.equal(computeDerived(mkTask({ id: 2, status: 'OPEN', depends_on: [9] }), all, null).depsMet, true);
  assert.equal(computeDerived(mkTask({ id: 2, status: 'OPEN', depends_on: [9, 10] }), all, null).depsMet, false);
  assert.equal(computeDerived(mkTask({ id: 2, status: 'OPEN', depends_on: [99] }), all, null).depsMet, false);
});

test('depends_on coerced when parser yields a scalar', () => {
  const dep = mkTask({ id: 9, status: 'DONE' });
  const d = computeDerived(mkTask({ id: 2, status: 'OPEN', depends_on: 9 }), [dep], null);
  assert.equal(d.depsMet, true);
});

test('ready = OPEN + deps met + unclaimed', () => {
  const all = [mkTask({ id: 9, status: 'DONE' })];
  assert.equal(computeDerived(mkTask({ id: 2, status: 'OPEN', depends_on: [9] }), all, null).ready, true);
  assert.equal(computeDerived(mkTask({ id: 2, status: 'PARKED', depends_on: [9] }), all, null).ready, false);
  const claimed = mkTask({ id: 2, status: 'OPEN', env: { claimed_at: '2026-06-10T00:00:00Z', claimed_by_session: 's-1' } });
  const d = computeDerived(claimed, all, null);
  assert.equal(d.ready, false);
  assert.equal(d.claimed, true);
  assert.equal(d.claimedBy, 's-1');
});

test('staleOverride wins over any git fallback', () => {
  const fm = { id: 2, status: 'OPEN', last_reviewed_at_commit: 'abc1234', touches_paths: ['core/'] };
  assert.equal(computeDerived(mkTask(fm), [], null, true).stale, true);
  assert.equal(computeDerived(mkTask(fm), [], null, false).stale, false);
});

test('missing frontmatter → UNKNOWN status, nothing crashes', () => {
  const d = computeDerived(mkTask(null, '- [x] a\n- [ ] b'), [], null);
  assert.equal(d.status, 'UNKNOWN');
  assert.equal(d.checkedCount, 1);
});
