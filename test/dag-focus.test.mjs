// Tests for the graph's FOCUS walk (core/git-views.mjs gitDag / computeDag /
// resolveFocus, task 175). The graph loads the newest `limit` commits across
// every ref, so an old branch's head can sit entirely outside that window; a
// focus asks for that commit's history as well. Integration-style: a throwaway
// git repo with more commits than the limit and one old branch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIMIT = 5;
let ROOT, REPO, OLD_HEAD, OLD_FORK, WT;
let gv, clearMemo;

const git = (args, env = {}) => execFileSync('git', ['-C', REPO, ...args], {
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'a@b.c', ...env },
}).trim();
// Strictly increasing dates, so the topo walk's order is deterministic.
let tick = 0;
const commit = (msg) => {
  const d = `2026-01-01T00:00:${String(tick++).padStart(2, '0')}Z`;
  git(['commit', '-q', '--allow-empty', '-m', msg], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  return git(['rev-parse', 'HEAD']);
};

before(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'cogyard-dagfocus-'));
  // Keep worktreesForProject off the real ~/.cogyard (port allocations).
  process.env.COGYARD_HOME = join(ROOT, 'home');
  ({ clearMemo } = await import('../core/memo.mjs'));
  gv = await import('../core/git-views.mjs');

  REPO = join(ROOT, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
  commit('m1');
  OLD_FORK = commit('m2');
  // The old branch: forked early, two commits, then left alone.
  git(['checkout', '-q', '-b', 'old-feature']);
  commit('old 1');
  OLD_HEAD = commit('old 2');
  git(['checkout', '-q', 'main']);
  // Enough newer work on main to push the old branch out of a LIMIT-commit window.
  for (let i = 3; i <= 12; i++) commit('m' + i);
});
after(() => { rmSync(ROOT, { recursive: true, force: true }); });

const proj = () => ({ slug: 'fixture', label: 'fixture', path: REPO });
const hashes = (dag) => dag.rows.map((r) => r.hash);

test('without a focus the old branch head is outside the window (the bug)', async () => {
  clearMemo();
  const dag = await gv.gitDag(proj(), LIMIT);
  assert.equal(dag.rows.length, LIMIT);
  assert.ok(!hashes(dag).includes(OLD_HEAD));
});

test('focus on the old branch puts its head in the rows, with its branch label', async () => {
  clearMemo();
  const plain = await gv.gitDag(proj(), LIMIT);
  const dag = await gv.gitDag(proj(), LIMIT, 'old-feature');
  const head = dag.rows.find((r) => r.hash === OLD_HEAD);
  assert.ok(head, 'focused head is a real row');
  assert.ok(head.refs.includes('old-feature'), `refs were ${JSON.stringify(head.refs)}`);
  assert.equal(head.subject, 'old 2');
  // The window itself is untouched: same rows, same order, then the focus walk.
  assert.deepEqual(hashes(dag).slice(0, LIMIT), hashes(plain));
  // Its own commits back to the fork point, in child-before-parent order.
  assert.deepEqual(dag.rows.slice(LIMIT).map((r) => r.subject), ['old 2', 'old 1', 'm2']);
  assert.equal(dag.rows.at(-1).hash, OLD_FORK);
  assert.ok(dag.rows.at(-1).onMain);
  assert.ok(!head.onMain);
  // The old branch's lane descends into the fork point's dot.
  const old1 = dag.rows.find((r) => r.subject === 'old 1');
  assert.equal(head.col, old1.col);
  assert.ok(dag.rows.at(-1).segs.some((s) => s.half === 'top' && s.from === old1.col));
});

test('a sha (short or full) focuses the same commit as the branch name', async () => {
  clearMemo();
  for (const f of [OLD_HEAD, OLD_HEAD.slice(0, 7)]) {
    const dag = await gv.gitDag(proj(), LIMIT, f);
    assert.ok(hashes(dag).includes(OLD_HEAD), f);
  }
});

test('the default view is unchanged after a focused request (cache keys do not collide)', async () => {
  clearMemo();
  const before = await gv.gitDag(proj(), LIMIT);
  await gv.gitDag(proj(), LIMIT, 'old-feature');
  const again = await gv.gitDag(proj(), LIMIT);
  assert.deepEqual(hashes(again), hashes(before));
  assert.equal(again.rows.length, LIMIT);
  // …and a different focus after the first is not served the first one's rows.
  const onMain = await gv.gitDag(proj(), LIMIT, OLD_FORK);
  assert.ok(hashes(onMain).includes(OLD_FORK));
  assert.ok(!hashes(onMain).includes(OLD_HEAD));
});

test('a focus already inside the window changes nothing', async () => {
  clearMemo();
  const plain = await gv.gitDag(proj(), LIMIT);
  const dag = await gv.gitDag(proj(), LIMIT, 'main');
  assert.deepEqual(hashes(dag), hashes(plain));
});

test('an unresolvable or hostile focus is ignored: default window, no crash, nothing run', async () => {
  clearMemo();
  const plain = await gv.gitDag(proj(), LIMIT);
  const marker = join(ROOT, 'pwned');
  const hostile = [
    'no-such-branch', 'deadbeef', '', '   ',
    `--output=${marker}`, '-n1', `$(touch ${marker})`, `x;touch ${marker}`, `x\`touch ${marker}\``,
    'main..old-feature', 'x\ny', 'a'.repeat(500),
  ];
  for (const f of hostile) {
    assert.equal(await gv.resolveFocus(REPO, f), null, JSON.stringify(f));
    const dag = await gv.gitDag(proj(), LIMIT, f);
    assert.deepEqual(hashes(dag), hashes(plain), JSON.stringify(f));
  }
  assert.ok(!existsSync(marker), 'no focus value reached a shell or became an option');
});

test('mergeFocusLog keeps the window lines in order and appends only new ones', () => {
  const L = (h) => [h, h.slice(0, 7), '', '', 's', 'a', 'd'].join('\x1f');
  const out = gv.mergeFocusLog([L('a1'), L('b2')].join('\n'), [L('c3'), L('b2'), L('d4')].join('\n'));
  assert.deepEqual(out.split('\n').map((l) => l.split('\x1f')[0]), ['a1', 'b2', 'c3', 'd4']);
});

test('a dirty worktree whose HEAD is the old focused head keeps its row', async () => {
  clearMemo();
  WT = join(ROOT, 'wt-old');
  git(['worktree', 'add', '-q', WT, 'old-feature']);
  writeFileSync(join(WT, 'uncommitted.txt'), 'x');
  try {
    const plain = await gv.gitDagWithStashesAndWorktrees(proj(), LIMIT);
    assert.ok(!plain.rows.some((r) => r.kind === 'worktree' && r.wtPath.endsWith('wt-old')),
      'without a focus the old HEAD is outside the window, so there is nothing to anchor to');
    const dag = await gv.gitDagWithStashesAndWorktrees(proj(), LIMIT, OLD_HEAD.slice(0, 7));
    const i = dag.rows.findIndex((r) => r.kind === 'worktree' && r.wtPath.endsWith('wt-old'));
    assert.notEqual(i, -1, 'the dirty worktree row is spliced in');
    assert.equal(dag.rows[i + 1].hash, OLD_HEAD, 'directly above its HEAD commit');
  } finally {
    git(['worktree', 'remove', '--force', WT]);
  }
});
