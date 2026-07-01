// Tests for dagFromLog — the pure lane-assignment half of gitDag.
// Input is the \x1f-delimited `git log --topo-order` shape:
//   %H \x1f %h \x1f %P \x1f %D \x1f %s \x1f %an \x1f %ad
// newest first, parent hashes space-separated in %P.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dagFromLog, spliceStashRows } from '../core/git-views.mjs';

const SEP = '\x1f';
const line = (hash, parents, refs = '', subject = 's') =>
  [hash, hash.slice(0, 7), parents.join(' '), refs, subject, 'ben', '06/10/2026 01:00 PM'].join(SEP);

// Hashes long enough that slice(0,7) is distinct.
const A = 'aaaaaaa0000000000000000000000000000000a';
const B = 'bbbbbbb0000000000000000000000000000000b';
const C = 'ccccccc0000000000000000000000000000000c';
const F = 'fffffff0000000000000000000000000000000f';
const M = 'mmmmmmm0000000000000000000000000000000d';

test('linear chain: one lane, every commit col 0', () => {
  const raw = [line(A, [B]), line(B, [C]), line(C, [])].join('\n');
  const { rows, laneCount } = dagFromLog(raw, new Set([A, B, C]));
  assert.equal(laneCount, 1);
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 0]);
  assert.ok(rows.every((r) => r.onMain));
  // top row has no incoming, one bottom seg into its parent's lane
  assert.deepEqual(rows[0].segs, [{ from: 0, to: 0, half: 'bottom', color: 0, main: true }]);
  // root has only the converging top seg
  assert.deepEqual(rows[2].segs, [{ from: 0, to: 0, half: 'top', color: 0, main: true }]);
});

test('feature branch off main: second lane merges into the lane already waiting for the fork point', () => {
  // F (feature, parent B) listed first, then main A (parent B), then shared B.
  // A's parent B is already tracked by lane 0 (F's line), so A merges into that
  // lane at its OWN row instead of tracking B twice — duplicate tracking made
  // every row in between redraw the diagonal with a dangling top end.
  const raw = [line(F, [B], 'wt/feature'), line(A, [B], 'main'), line(B, [])].join('\n');
  const { rows, laneCount } = dagFromLog(raw, new Set([A, B]));
  assert.equal(laneCount, 2);
  const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
  assert.equal(byHash[F].col, 0);       // first commit takes lane 0
  assert.equal(byHash[A].col, 1);       // main's tip opens lane 1
  assert.equal(byHash[B].col, 0);       // fork point lands on the lane waiting for it
  assert.equal(byHash[F].onMain, false);
  assert.equal(byHash[A].onMain, true);
  // A's row: lane 0 passes through (F→B flows past), and A's bottom seg is the
  // one-time merge diagonal into lane 0. The pass-through is F's descent toward the
  // fork point — F is NOT on main, so that lane stays lane-colored, not black.
  const pass = byHash[A].segs.filter((s) => s.half === 'full');
  assert.deepEqual(pass, [{ from: 0, to: 0, half: 'full', color: 0, main: false }]);
  const bottoms = byHash[A].segs.filter((s) => s.half === 'bottom');
  assert.deepEqual(bottoms.map((s) => [s.from, s.to]), [[1, 0]]);
  // Only the surviving lane converges into B's dot — no duplicate [1,0] strand.
  const tops = byHash[B].segs.filter((s) => s.half === 'top');
  assert.deepEqual(tops.map((s) => [s.from, s.to]), [[0, 0]]);
});

test('convergence keeps main spine in the lower column past a fork point', () => {
  // Reproduces the cogyard-repo bug: a merge (TIP) whose first parent is main's
  // spine (MN) and whose second parent is a feature tip (FEAT). FEAT and MN both
  // descend to a shared ancestor ANC (on main), then ANC->TL is a linear main tail.
  // --topo-order emits the feature side (FEAT) BEFORE main reaches ANC, so the
  // feature lane registers ANC in a higher column first. The buggy dedup then
  // freed main's col-0 lane at MN's row, dumping ANC + the whole linear tail into
  // col 1. Fixed: the lower column survives, so ANC and TL stay at col 0.
  const TIP = 'ttttttt0000000000000000000000000000000a';
  const FEAT = 'fffaaa00000000000000000000000000000000b';
  const MN = 'nnnnnnn0000000000000000000000000000000c';
  const ANC = 'aaa1110000000000000000000000000000000d0';
  const TL = 'tlllll00000000000000000000000000000000e';
  const raw = [
    line(TIP, [MN, FEAT], 'main'), // merge; first parent = main spine
    line(FEAT, [ANC]),             // feature side emitted FIRST -> registers ANC high
    line(MN, [ANC]),               // main's first-parent line reaches ANC second
    line(ANC, [TL]),               // shared ancestor, on main
    line(TL, []),                  // linear tail root, on main
  ].join('\n');
  const { rows } = dagFromLog(raw, new Set([TIP, MN, ANC, TL]));
  const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
  assert.equal(byHash[TIP].col, 0);
  assert.equal(byHash[FEAT].col, 1);  // feature rides the higher lane
  assert.equal(byHash[MN].col, 0);    // main's spine stays col 0
  assert.equal(byHash[ANC].col, 0);   // shared ancestor migrates back to col 0
  assert.equal(byHash[TL].col, 0);    // linear tail stays col 0 (the bug put it at 1)
  // No duplicate-tracked hash: only one lane converges into ANC's dot.
  const ancTops = byHash[ANC].segs.filter((s) => s.half === 'top');
  assert.deepEqual(ancTops.map((s) => [s.from, s.to]), [[0, 0]]);
  // MN's row carries the single migration diagonal (ANC moving from col 1 to col 0),
  // with no dangling end — it connects to ANC's col-0 dot below.
  const mnFull = byHash[MN].segs.filter((s) => s.half === 'full');
  assert.deepEqual(mnFull.map((s) => [s.from, s.to]), [[1, 0]]);
});

test('commits above main are not painted black (only the trunk at/below the tip is)', () => {
  // FX is a feature commit AHEAD of main, forked from main's tip A. Its line
  // descends to A — but because FX sits ABOVE the tip, that descent must stay
  // lane-colored, not black. Only A and below (the real trunk) are main-black.
  const raw = [line(F, [A], 'wt/x'), line(A, [B], 'main'), line(B, [])].join('\n');
  const { rows } = dagFromLog(raw, new Set([A, B]));
  const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
  // FX's descent toward main's tip: NOT black (it's above main).
  assert.ok(byHash[F].segs.every((s) => s.main === false));
  // A (the tip) and B (trunk) paint black.
  assert.ok(byHash[A].segs.some((s) => s.main === true));
  assert.ok(byHash[B].segs.every((s) => s.main === true));
});

test('main tip first in the walk: a later feature descent is still not black', () => {
  // The case a positional "have we passed main's tip yet" latch got wrong: when
  // main's tip (MT) sorts to the TOP of the topo walk, a feature commit (FX) that
  // forks from an older main commit (MO) appears AFTER it. Blackness must come from
  // both-endpoints-on-main, not walk position — FX's descent to MO stays colored.
  const MT = 'mt000000000000000000000000000000000000a';
  const MO = 'mo000000000000000000000000000000000000b';
  const FX = 'fx000000000000000000000000000000000000c';
  const raw = [line(MT, [MO], 'main'), line(FX, [MO], 'wt/x'), line(MO, [])].join('\n');
  const { rows } = dagFromLog(raw, new Set([MT, MO]));
  const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
  // FX's OWN line down to the fork point (its bottom seg) is colored, not black...
  const fxDescent = byHash[FX].segs.filter((s) => s.half === 'bottom');
  assert.ok(fxDescent.length && fxDescent.every((s) => s.main === false));
  // ...while main's trunk (MT->MO) legitimately passes BEHIND FX as a black lane.
  assert.ok(byHash[FX].segs.some((s) => s.half === 'full' && s.main === true));
  assert.ok(byHash[MT].segs.some((s) => s.main === true)); // trunk: black
  assert.ok(byHash[MO].segs.some((s) => s.main === true));
});

test('merge commit: second parent opens its own lane', () => {
  // M merges B into A-line: M(parents A,B), A(parent C), B(parent C), C(root)
  const raw = [line(M, [A, B]), line(A, [C]), line(B, [C]), line(C, [])].join('\n');
  const { rows, laneCount } = dagFromLog(raw, new Set([M, A, C]));
  assert.equal(laneCount, 2);
  const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
  assert.equal(byHash[M].col, 0);
  assert.equal(byHash[A].col, 0);  // first parent continues M's lane
  assert.equal(byHash[B].col, 1);  // second parent got lane 1
  assert.equal(byHash[C].col, 0);
  // M's dot diverges into both parents' lanes
  const bottoms = byHash[M].segs.filter((s) => s.half === 'bottom');
  assert.deepEqual(bottoms.map((s) => [s.from, s.to]).sort(), [[0, 0], [0, 1]]);
});

test('refs: HEAD-> prefix stripped, bare HEAD dropped, tags kept', () => {
  const raw = line(A, [], 'HEAD -> main, tag: v1, origin/main');
  const { rows } = dagFromLog(raw, new Set());
  assert.deepEqual(rows[0].refs, ['main', 'tag: v1', 'origin/main']);
});

test('row carries display fields through', () => {
  const raw = line(A, [], '', 'fix(core): something [#20]');
  const { rows } = dagFromLog(raw, new Set());
  assert.equal(rows[0].shortHash, A.slice(0, 7));
  assert.equal(rows[0].subject, 'fix(core): something [#20]');
  assert.equal(rows[0].author, 'ben');
});

const S = 'sssssss0000000000000000000000000000000e';

test('spliceStashRows: one collapsed stash row above its base commit', () => {
  // Chain A->B->C; a stash based on B. The stash collapses to ONE row, inserted
  // directly above B, borrowing B's lane — not expanded into plumbing commits.
  const dag = dagFromLog([line(A, [B]), line(B, [C]), line(C, [])].join('\n'), new Set([A, B, C]));
  const out = spliceStashRows(dag, [{ ref: 'stash@{0}', sha: S, base: B, message: 'wip thing' }]);
  const idxB = out.rows.findIndex((r) => r.hash === B);
  const stashRow = out.rows[idxB - 1];
  assert.equal(stashRow.kind, 'stash');
  assert.equal(stashRow.hash, S);            // keyed by the real stash commit sha
  assert.equal(stashRow.stashRef, 'stash@{0}');
  assert.equal(stashRow.message, 'wip thing');
  assert.equal(stashRow.base, B);
  assert.equal(stashRow.col, out.rows[idxB].col); // borrows the base commit's lane
  assert.equal(stashRow.segs.some((s) => s.stash), true);
  // Exactly one synthetic row added; real commits untouched.
  assert.equal(out.rows.filter((r) => r.kind === 'stash').length, 1);
  assert.equal(out.rows.filter((r) => !r.kind).length, 3);
});

test('spliceStashRows: stash whose base is outside the window is skipped', () => {
  const dag = dagFromLog([line(A, [B]), line(B, [])].join('\n'), new Set([A, B]));
  const out = spliceStashRows(dag, [{ ref: 'stash@{0}', sha: S, base: C, message: 'orphan' }]);
  assert.equal(out.rows.filter((r) => r.kind === 'stash').length, 0);
  assert.equal(out.rows.length, 2);
});
