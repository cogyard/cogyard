// Settled boxes (task 171): an unticked box that was decided rather than done —
// (dropped: why) / (moved: <id>) / ~~struck~~, or left behind as (optional) — is read
// by checkboxSteps, skipped as anyone's next step, and checked by validate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkboxSteps, boxCounts, computeDerived } from '../core/frontmatter.mjs';
import { validateTasks } from '../core/validate.mjs';
import { boxReport } from '../core/close.mjs';
import { inferStatus } from '../core/analyze.mjs';

const steps = (body) => checkboxSteps(body).map(({ done, settled, settledArg, owner, text }) => ({ done, settled, settledArg, owner, text }));

test('each marker is read, with its argument, and stripped from the text', () => {
  assert.deepEqual(steps([
    '- [ ] (dropped: push not now) Watchers',
    '- [ ] (moved: 050) Fresh repo',
    '- [ ] (Optional) Icons',
    '- [ ] ~~Copy-path~~ dropped in the redesign',
    '- [ ] Plain pending box',
  ].join('\n')), [
    { done: false, settled: 'dropped', settledArg: 'push not now', owner: null, text: 'Watchers' },
    { done: false, settled: 'moved', settledArg: '050', owner: null, text: 'Fresh repo' },
    { done: false, settled: 'optional', settledArg: null, owner: null, text: 'Icons' },
    { done: false, settled: 'dropped', settledArg: null, owner: null, text: '~~Copy-path~~ dropped in the redesign' },
    { done: false, settled: null, settledArg: null, owner: null, text: 'Plain pending box' },
  ]);
});

// Task 238 (owner): (deferred) is retired — a box still wanted gets a task and
// is (moved: <id>); one left behind is (optional). An old one is an open box
// again, and validate says what to write instead.
test('a retired (deferred) box reads as an open box, and validate says what to write instead', () => {
  const [s] = checkboxSteps('- [ ] (deferred) Collapse context');
  assert.deepEqual([s.settled, s.text], [null, '(deferred) Collapse context']);
  const [w] = boxProblemsFor('- [ ] (deferred) Collapse context');
  assert.match(w, /"\(deferred\)" — that word is retired: write \(optional\) .* or file a task and write \(moved: <id>\)/);
});

test('an owner marker and a settled marker combine in either order', () => {
  const [a, b] = checkboxSteps('- [ ] (you: decision) (dropped: not needed) Pick a name\n- [ ] (moved: other-project#12) (you: credential) Log in');
  assert.deepEqual([a.owner, a.settled, a.text], [['decision'], 'dropped', 'Pick a name']);
  assert.deepEqual([b.owner, b.settled, b.settledArg, b.text], [['credential'], 'moved', 'other-project#12', 'Log in']);
});

test('a ticked box is done, never settled, whatever its text says', () => {
  const [s] = checkboxSteps('- [x] (optional) Did it anyway');
  assert.equal(s.done, true);
  assert.equal(s.settled, null);
});

test('a box shown as an example in a code block, or quoted in a table, is not a box', () => {
  const body = [
    '- [x] real one',
    '```markdown',
    '- [ ] (dropped: why) example inside a fence',
    '- [x] ticked example',
    '```',
    '~~~',
    '- [ ] tilde-fenced example',
    '~~~',
    '| `- [ ] (moved: <id>)` | table row |',
    '- [ ] real two',
  ].join('\n');
  assert.deepEqual(checkboxSteps(body).map((s) => s.text), ['real one', 'real two']);
  const task = { frontmatter: { status: 'OPEN' }, body };
  const d = computeDerived(task, [task], null, false);
  assert.deepEqual([d.checkedCount, d.totalCount], [1, 2]);
});

// The progress fraction agrees with `tasks close`: dropped / moved / struck
// leave the total; optional is a leftover and stays in as unfinished (task 238).
const MIXED = [
  '- [x] one', '- [x] two', '- [✓] three',
  '- [ ] (dropped: moot) four', '- [ ] (moved: 050) five', '- [ ] (optional) six',
  '- [ ] ~~seven~~', '- [ ] eight',
].join('\n');

test('progress counts dropped and moved boxes as neither done nor left; optional is left', () => {
  const task = { frontmatter: { status: 'OPEN' }, body: MIXED };
  const d = computeDerived(task, [task], null, false);
  assert.deepEqual([d.checkedCount, d.totalCount, d.progressPct], [3, 5, 60]);
  assert.deepEqual(boxCounts(checkboxSteps('- [x] a\n- [ ] (dropped: moot) b\n- [ ] ~~c~~')), { checkedCount: 1, totalCount: 1 });
  assert.deepEqual(boxCounts(checkboxSteps('- [x] a\n- [ ] (optional) b')), { checkedCount: 1, totalCount: 2 });
});

test('the doctor fraction and analyze use the same count', () => {
  const r = boxReport(MIXED);
  assert.deepEqual([r.done, r.counted, r.total], [3, 5, 8]);
  const a = inferStatus({ path: '/nonexistent/001-a.md', body: MIXED });
  assert.deepEqual([a.checkedCount, a.totalCount], [3, 5]);
});

test('a task whose open boxes are all dropped or moved reads complete', () => {
  const task = { frontmatter: { status: 'DONE' }, body: '- [x] a\n- [x] b\n- [ ] (dropped: moot) c\n- [ ] (moved: 050) d' };
  const d = computeDerived(task, [task], null, false);
  assert.deepEqual([d.checkedCount, d.totalCount, d.progressPct], [2, 2, 100]);
});

test('validate ignores marker examples inside a code block', () => {
  assert.deepEqual(boxProblemsFor('```\n- [ ] (moved: 999) example\n- [ ] (dropepd) example\n```'), []);
});

test('prose in parentheses is not a marker', () => {
  const [s] = checkboxSteps('- [ ] (Deferred v2, not this task) fuzzy nudge');
  assert.equal(s.settled, null);
});

test('a settled owner box is not the owner\'s next step', () => {
  const task = { frontmatter: { status: 'OPEN' }, body: '- [x] Built it\n- [ ] (you: decision) (dropped: moot) Choose\n- [ ] (you: device) Try on a phone\n' };
  const d = computeDerived(task, [task], null, false);
  assert.deepEqual(d.youNext, ['device']);
  assert.deepEqual(d.youOpen.map((y) => y.text), ['Try on a phone']);
});

const fm = { id: 1, slug: 'a', title: 'A', status: 'OPEN', type: 'feature', created: 'x', created_at_commit: 'x', last_reviewed_at_commit: 'x', last_touched_commit: 'x', depends_on: [], related: [], touches_paths: [] };
// A checkbox-marker problem is a validator ERROR (task 238, owner 2026-10-30:
// "I need something to call these out so tasks are written properly").
const boxProblemsFor = (body) => {
  const tasks = [
    { path: '/s/001-a.md', hasFrontmatter: true, frontmatter: fm, body },
    { path: '/s/050-b.md', hasFrontmatter: true, frontmatter: { ...fm, id: 50, slug: 'b' }, body: '' },
  ];
  const r = validateTasks(tasks).results[0];
  assert.deepEqual(r.warnings.filter((w) => w.startsWith('checkbox')), [], 'marker problems are errors, never warnings');
  return r.errors.filter((e) => e.startsWith('checkbox'));
};

test('validate: a known target passes; a missing one, a missing target and a missing reason are errors', () => {
  assert.deepEqual(boxProblemsFor('- [ ] (moved: 050) ok\n- [ ] (moved: other-project#12) ok\n- [ ] (dropped: moot) ok\n- [ ] (optional) ok'), []);
  const w = boxProblemsFor('- [ ] (moved: 999) a\n- [ ] (moved) b\n- [ ] (dropped) c');
  assert.equal(w.length, 3);
  assert.match(w[0], /no task 999/);
  assert.match(w[1], /say where/);
  assert.match(w[2], /say why/);
});

// After-merge checks (task 232): the agent's own box that waits for main.
test('(after merge) is read in any order with the other markers and stripped from the text', () => {
  const [a, b, c, d] = checkboxSteps([
    '- [ ] (after merge) Card reads idle',
    '- [ ] (you: device) (After Merge) Try on a phone',
    '- [ ] (after merge) (you: decision) Pick one',
    '- [ ] Plain box',
  ].join('\n'));
  assert.deepEqual([a.afterMerge, a.owner, a.text], [true, null, 'Card reads idle']);
  assert.deepEqual([b.afterMerge, b.owner, b.text], [true, ['device'], 'Try on a phone']);
  assert.deepEqual([c.afterMerge, c.owner, c.text], [true, ['decision'], 'Pick one']);
  assert.equal(d.afterMerge, false);
});

test('a ticked or settled (after merge) box is not one still to run', () => {
  const [t, s] = checkboxSteps('- [x] (after merge) Ran it\n- [ ] (after merge) (dropped: moot) Skip it');
  assert.deepEqual([t.done, t.afterMerge, t.text], [true, false, 'Ran it']);
  assert.deepEqual([s.settled, s.afterMerge, s.text], ['dropped', false, 'Skip it']);
});

test('validate: (after merge) passes; a near-miss is flagged; prose is not', () => {
  assert.deepEqual(boxProblemsFor('- [ ] (after merge) a\n- [ ] (after merge) (moved: 050) b\n- [ ] (after merging the branch) c'), []);
  const w = boxProblemsFor('- [ ] (post-merge) a\n- [ ] (after-merge) b\n- [ ] (you: device) (aftermerge) c');
  assert.equal(w.length, 3);
  for (const x of w) assert.match(x, /write it as \(after merge\)/);
});

test('validate: a settled marker after (after merge) is still checked', () => {
  const w = boxProblemsFor('- [ ] (after merge) (moved: 999) a');
  assert.equal(w.length, 1);
  assert.match(w[0], /no task 999/);
});

// Task 236: `device` is no longer offered to writers, but old files still pass.
test('validate: an old (you: device) box passes with no warning; the "(you)" hint offers only decision, credential, purchase', () => {
  assert.deepEqual(boxProblemsFor('- [ ] (you: device) The owner looks at it on their phone'), []);
  const [w] = boxProblemsFor('- [ ] (you) Do the thing');
  assert.match(w, /\(you: decision \| credential \| purchase\)/);
  assert.doesNotMatch(w, /device/);
});

test('validate: a misspelt marker word is flagged; ordinary parenthesised prose is not', () => {
  const w = boxProblemsFor('- [ ] (dropepd: x) a\n- [ ] (UI) tidy the header\n- [ ] (note: see below) b');
  assert.equal(w.length, 1);
  assert.match(w[0], /did you mean \(dropped\)/);
});
