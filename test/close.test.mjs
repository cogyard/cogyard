// Closeable (task 171): the rule `tasks close` and `tasks doctor` share. The
// awkward cases are the point — all ticked but unmerged, struck-through extras,
// no boxes at all, a branch with no commits, someone else's claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { closeability, closeableTasks, mergeState, boxReport, proseSettled, markerText, doneWithLeftovers } from '../core/close.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// A repo with: main; `merged` (a commit, merged into main); `unmerged` (a commit
// main doesn't have); `empty` (created, never committed on).
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'close-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 'Tester'], dir);
  const commit = (f) => { writeFileSync(join(dir, f), f); git(['add', f], dir); git(['commit', '-q', '-m', f], dir); };
  commit('a');
  git(['checkout', '-q', '-b', 'merged'], dir); commit('b');
  git(['checkout', '-q', 'main'], dir); git(['merge', '-q', '--no-ff', '-m', 'merge', 'merged'], dir);
  git(['checkout', '-q', '-b', 'unmerged'], dir); commit('c');
  git(['checkout', '-q', 'main'], dir);
  git(['branch', 'empty'], dir);
  return dir;
}
const R = repo();

const task = (body, env = {}, status = 'OPEN') => ({ frontmatter: { id: 1, status, env }, body });
const ALL = '- [x] one\n- [x] two\n';

test('merge state: merged, unmerged, never committed on, none recorded, not found', () => {
  assert.equal(mergeState('merged', R).state, 'merged');
  assert.equal(mergeState('unmerged', R).state, 'unmerged');
  assert.equal(mergeState('empty', R).state, 'no-commits');
  assert.equal(mergeState(null, R).state, 'no-branch');
  assert.equal(mergeState('gone', R).state, 'unknown');
});

test('all ticked + merged → suggested, and a plain close goes ahead', () => {
  const v = closeability(task(ALL, { branch: 'merged' }), { repoRoot: R, me: 'Tester' });
  assert.equal(v.suggest, true);
  assert.equal(v.done.ok, true);
});

test('all ticked but unmerged → not suggested; close refuses, naming the branch', () => {
  const v = closeability(task(ALL, { branch: 'unmerged' }), { repoRoot: R });
  assert.equal(v.suggest, false);
  assert.equal(v.done.ok, false);
  assert.match(v.done.reasons.join('\n'), /unmerged is not merged into main/);
  assert.equal(v.enough.ok, false); // unshipped work isn't "shipped enough" either
});

test('no branch recorded, or a branch never committed on (the 072 shape) → qualifies on boxes alone', () => {
  assert.equal(closeability(task(ALL), { repoRoot: R }).suggest, true);
  assert.equal(closeability(task(ALL, { branch: 'empty' }), { repoRoot: R }).suggest, true);
});

test('unticked boxes → not suggested; close refuses and lists exactly those boxes', () => {
  const v = closeability(task('- [x] done\n- [ ] still to do\n- [ ] and this'), { repoRoot: R });
  assert.equal(v.suggest, false);
  assert.deepEqual(v.boxes.pending, ['still to do', 'and this']);
  assert.match(v.done.reasons[0], /2 box\(es\) still open:[\s\S]*still to do[\s\S]*and this/);
  assert.equal(v.enough.ok, true); // ENOUGH = shipped enough, leftovers recorded
});

test('struck-through, dropped and moved boxes are settled → suggested', () => {
  const body = '- [x] built\n- [ ] ~~old idea~~\n- [ ] (dropped: moot) a\n- [ ] (moved: 50) b\n';
  const v = closeability(task(body), { repoRoot: R });
  assert.equal(v.suggest, true);
  assert.deepEqual(v.boxes.settled, { dropped: 2, moved: 1, optional: 0 });
});

// Task 238 (owner): DONE means nothing is left — an optional box left behind
// is a leftover.
test('an optional box → DONE refuses and points at --enough; ENOUGH goes ahead', () => {
  const v = closeability(task('- [x] built\n- [ ] (optional) later'), { repoRoot: R });
  assert.equal(v.suggest, false);
  assert.match(v.done.reasons.join('\n'), /left behind \(optional\) — a DONE task has nothing left; close with --enough:\n.*\(optional\) later/);
  assert.deepEqual(v.boxes.leftovers, [{ kind: 'optional', text: 'later' }]);
  assert.equal(v.enough.ok, true);
});

test('only (after merge) checks open → refuses with that reason alone, kept apart from other open boxes', () => {
  const v = closeability(task('- [x] built\n- [ ] (after merge) card reads idle', { branch: 'merged' }), { repoRoot: R, me: 'Tester' });
  assert.equal(v.suggest, false);
  assert.equal(v.done.ok, false);
  assert.equal(v.done.onlyAfterMerge, true);
  assert.deepEqual([v.boxes.afterMerge, v.boxes.pending], [['card reads idle'], []]);
  assert.equal(v.done.reasons.length, 1);
  assert.match(v.done.reasons[0], /1 check\(s\) waiting on the merge — run them[\s\S]*\(after merge\) card reads idle/);
});

test('(after merge) beside another blocker (an open box, or no merge yet) → not "only after merge"', () => {
  const both = closeability(task('- [ ] (after merge) a\n- [ ] b', { branch: 'merged' }), { repoRoot: R });
  assert.equal(both.done.onlyAfterMerge, false);
  assert.equal(both.done.reasons.length, 2);
  const unmerged = closeability(task('- [x] x\n- [ ] (after merge) a', { branch: 'unmerged' }), { repoRoot: R });
  assert.equal(unmerged.done.onlyAfterMerge, false);
});

test('a ticked (after merge) box is done → a plain close goes ahead', () => {
  const v = closeability(task('- [x] built\n- [x] (after merge) card reads idle', { branch: 'merged' }), { repoRoot: R, me: 'Tester' });
  assert.equal(v.done.ok, true);
  assert.equal(v.suggest, true);
});

test('no boxes at all → never suggested, but the owner may close it', () => {
  const v = closeability(task('Just prose.'), { repoRoot: R });
  assert.equal(v.suggest, false);
  assert.equal(v.done.ok, true);
});

test('claim: mine (any session) or unnamed is fine; someone else\'s refuses', () => {
  const env = (by) => ({ claimed_at: '2026-10-01', claimed_by: by, claimed_by_session: 'dead-session' });
  assert.equal(closeability(task(ALL, env('Tester')), { repoRoot: R, me: 'Tester' }).done.ok, true);
  assert.equal(closeability(task(ALL, env(null)), { repoRoot: R, me: 'Tester' }).done.ok, true);
  const v = closeability(task(ALL, env('Someone Else')), { repoRoot: R, me: 'Tester' });
  assert.equal(v.done.ok, false);
  assert.match(v.done.reasons[0], /claimed by Someone Else/);
});

test('status: only OPEN closes; an already-closed task is flagged as such', () => {
  assert.match(closeability(task(ALL, {}, 'DONE'), { repoRoot: R }).done.reasons[0], /already DONE/);
  assert.equal(closeability(task(ALL, {}, 'DONE'), { repoRoot: R }).alreadyClosed, true);
  // A parked task names unpark, not "close takes an OPEN task" (task 244: that
  // wording led a chat to set status to OPEN by hand), and refuses --enough too.
  const parked = closeability(task(ALL, {}, 'PARKED'), { repoRoot: R });
  assert.match(parked.done.reasons[0], /^status is PARKED — a parked task is un-parked before it closes: `cogyard tasks unpark .* "<what was seen that ends the wait>"`, then close it$/);
  assert.equal(parked.enough.ok, false);
  assert.equal(parked.park.live, true);
  assert.equal(closeability(task(ALL, {}, 'OBSOLETE'), { repoRoot: R }).park.live, false);
});

test('closeableTasks lists only the ready ones, and reading them changes no file', () => {
  const dir = join(R, '.cogyard', 'tasks');
  mkdirSync(dir, { recursive: true });
  const write = (id, body, status = 'OPEN', branch = 'null') => writeFileSync(join(dir, `00${id}-t.md`),
    `---\nid: ${id}\ntitle: t${id}\nstatus: ${status}\nenv:\n  branch: ${branch}\n  claimed_at: null\n---\n${body}\n`);
  write(1, ALL);                          // ready
  write(2, '- [x] a\n- [ ] b');           // open box
  write(3, ALL, 'OPEN', 'unmerged');      // unmerged
  write(4, ALL, 'DONE');                  // already closed
  write(5, 'no boxes');                   // no evidence
  const before = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'));
  const got = closeableTasks({ projects: [{ slug: 'p', path: R }], me: 'Tester' });
  assert.deepEqual(got.map((t) => `${t.slug}#${t.id}`), ['p#1']);
  assert.deepEqual(readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')), before);
});

test('boxReport counts Scope, Acceptance and every other box alike', () => {
  const r = boxReport('## Scope\n- [x] a\n## Acceptance\n- [ ] b\n## Notes\n- [✓] c\n');
  assert.deepEqual([r.total, r.done, r.pending], [3, 2, ['b']]);
});

// Task 238: boxes settled in prose before the markers existed. The phrases are
// real ones from closed tasks across the stores.
test('proseSettled reads the marker an old box already says, and nothing more', () => {
  const ids = new Set([16, 50, 63, 94]);
  const read = (t) => { const p = proseSettled(t, ids); return p && markerText(p); };
  assert.equal(read('**→ MOVED to task 050** GitHub: create FRESH repo'), '(moved: 050)');
  assert.equal(read('(→016) Wire the PCF8563 RTC'), '(moved: 016)');
  assert.equal(read('Owner-machine remainder → tracked in [task 63](063-x.md).'), '(moved: 63)');
  assert.equal(read('Update the README → carried by **task 094**.'), '(moved: 094)');
  assert.equal(read('**→ MOVED to task 999** a task that does not exist'), null);
  assert.equal(read('OBSOLETE (owner decision 2026-10-06: push not now) — Watchers'), '(dropped: owner decision 2026-10-06: push not now)');
  assert.equal(read('OBSOLETE — steps 1–13 above'), '(dropped: obsolete)');
  assert.equal(read("Skipped (Ben's call): syntax highlighting"), "(dropped: Ben's call)");
  assert.equal(read('[High] Inconsistent envelopes — DROPPED (TypeScript interfaces document shapes instead)'), '(dropped: TypeScript interfaces document shapes instead)');
  assert.equal(read('`link_clicks` grows unbounded — needs retention strategy (out of scope)'), '(dropped: out of scope)');
  // "Deferred" reads as left behind — (deferred) is retired (task 238)
  assert.equal(read("Deferred (Ben's call, cost vs value): collapse context"), '(optional)');
  assert.equal(read('*Deferred:* admin category editor'), '(optional)');
  assert.equal(read("Lock Screen widget. *(Deferred — Ben's call; not built yet.)*"), '(optional)');
  assert.equal(read('(deferred) polish later'), '(optional)');
  assert.equal(read('On-device walk. **Deferred to task 016** — code merged'), '(moved: 016)');
  assert.equal(read('Optional: category filter (deferred; not required)'), '(optional)');
  assert.equal(read('Allow manual adjustment of trim points (optional)'), '(optional)');
  // ordinary prose — an arrow, a lower-case word in passing — proposes nothing
  assert.equal(read('Rename `family_groups` → `families`'), null);
  assert.equal(read('All tests passing (no skipped/pending tests)'), null);
  assert.equal(read('Categories stay code-defined (per sub-task 3 deferred polish)'), null);
  assert.equal(read('Plain box nobody settled'), null);
});

test('doneWithLeftovers lists DONE tasks still holding open boxes, with proposals, and changes no file', () => {
  const proj = mkdtempSync(join(tmpdir(), 'leftovers-'));
  const dir = join(proj, '.cogyard', 'tasks');
  mkdirSync(dir, { recursive: true });
  const write = (id, body, status) => writeFileSync(join(dir, `0${id}-u.md`), `---\nid: ${id}\ntitle: u${id}\nstatus: ${status}\n---\n${body}\n`);
  write(10, '- [x] a\n- [ ] (dropped: moot) b\n- [ ] (moved: 11) c', 'DONE'); // nothing left — not listed
  write(11, '- [x] a\n- [ ] Deferred (owner): c\n- [ ] d', 'DONE');           // one settled in prose, one plain
  write(12, '- [x] a\n- [ ] (optional) e', 'DONE');                          // a marked leftover on DONE
  write(13, '- [ ] f\n- [ ] (optional) g', 'ENOUGH');                         // leftovers belong to ENOUGH — not listed
  write(14, '- [ ] h', 'OPEN');                                               // open task — not listed
  const before = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'));
  const got = doneWithLeftovers({ projects: [{ slug: 'p', path: proj }] });
  assert.deepEqual(got.map((t) => [t.id, t.open.map((o) => [o.kind, o.proposal && markerText(o.proposal)])]),
    [[11, [[null, '(optional)'], [null, null]]], [12, [['optional', null]]]]);
  assert.deepEqual(readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')), before);
});
