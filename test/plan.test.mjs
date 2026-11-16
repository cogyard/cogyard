// Tests for computePlan (task 179) — the rules behind the Plan view, over
// in-memory task fixtures so no git or filesystem runs.
//
// COGYARD_HOME points at a throwaway dir holding a registry with one other
// project ('other', task 5 OPEN, task 6 DONE), so cross-project deps resolve
// for real without touching ~/.cogyard. Set BEFORE the imports resolve it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-plan-'));
process.env.COGYARD_HOME = HOME;
const OTHER = join(HOME, 'other-repo');
mkdirSync(join(OTHER, '.cogyard', 'tasks'), { recursive: true });
writeFileSync(join(OTHER, '.cogyard', 'tasks', '005-open.md'), '---\nid: 5\nstatus: OPEN\n---\n');
writeFileSync(join(OTHER, '.cogyard', 'tasks', '006-done.md'), '---\nid: 6\nstatus: DONE\n---\n');
writeFileSync(join(HOME, 'projects.json'), JSON.stringify([{ slug: 'other', path: OTHER }]));

const { computePlan, parseDep } = await import('../core/plan.mjs');
const { computeDerived } = await import('../core/frontmatter.mjs');
const { waitingWhyOf } = await import('../core/status.mjs');
const { validateTask } = await import('../core/validate.mjs');

// A task: id, status, files it touches, extra frontmatter, open/ticked boxes.
function mk(id, { status = 'OPEN', paths = [], deps = [], open = 1, ticked = 0, env = {}, ...fm } = {}) {
  const body = [...Array(ticked).fill('- [x] done'), ...Array(open).fill('- [ ] todo')].join('\n');
  return { path: `/x/${id}.md`, hasFrontmatter: true, body,
    frontmatter: { id, title: `Task ${id} — detail`, status, touches_paths: paths, depends_on: deps, env, ...fm } };
}
function plan(tasks, extra = {}) {
  for (const t of tasks) t.derived = computeDerived(t, tasks, null, false);
  return computePlan({ slug: 'proj', tasks, tracked: extra.tracked || [], isDir: extra.isDir || ((p) => p.endsWith('/')), ...extra });
}

test('parseDep reads plain ids and cross-project ids', () => {
  assert.deepEqual(parseDep(7), { slug: null, id: '7' });
  assert.deepEqual(parseDep('007'), { slug: null, id: '7' });
  assert.deepEqual(parseDep('040e'), { slug: null, id: '40e' });
  assert.deepEqual(parseDep('cogyard#166'), { slug: 'cogyard', id: '166' });
  assert.equal(parseDep('nonsense'), null);
});

const where = (p, id) => {
  for (const k of ['progress', 'can', 'look']) if (p.groups[k].includes(String(id))) return k;
  for (const k of ['dep', 'other']) for (const g of p.groups[k]) if (g.tasks.includes(String(id))) return `${k}:${g.after.join(',')}`;
  return p.parked.includes(String(id)) ? 'parked' : null;
};

test('a hard block: the dependent waits for that task; the blocker lists it under unblocks and frees', () => {
  const p = plan([mk(1, { paths: ['a.js'] }), mk(2, { paths: ['b.js'], deps: [1] })]);
  assert.equal(where(p, 1), 'can');
  assert.equal(where(p, 2), 'dep:1');
  assert.deepEqual(p.tasks[1].unblocks, ['2']);
  assert.deepEqual(p.tasks[1].waitedOnBy, ['2']);
  assert.deepEqual(p.tasks[2].unmet, ['1']);
});

test('two tasks editing the same code file both can start; each names the other and the file in clash (task 239)', () => {
  const p = plan([mk(1, { paths: ['core/x.mjs'] }), mk(2, { paths: ['core/x.mjs', 'y.js'] }), mk(3, { paths: ['z.js'] })]);
  assert.equal(where(p, 1), 'can');
  assert.equal(where(p, 2), 'can');
  assert.equal(where(p, 3), 'can');
  assert.equal(p.groups.code, undefined, 'there is no shared-code group any more');
  assert.deepEqual(p.tasks[1].clash, [{ id: '2', files: ['core/x.mjs'], resources: [] }]);
  assert.deepEqual(p.tasks[2].clash, [{ id: '1', files: ['core/x.mjs'], resources: [] }]);
  assert.deepEqual(p.tasks[1].waitedOnBy, [], 'sharing a file is not waiting');
});

test('sharing a file never makes a task wait: "can" is ordered by depends_on waiters only', () => {
  const p = plan([
    mk(1, { paths: ['core/x.mjs'] }),                  // lower number, nothing waits on it
    mk(2, { paths: ['core/x.mjs'] }),                  // task 3 depends on it
    mk(3, { paths: ['b.js'], deps: [2] }),
  ]);
  assert.deepEqual(p.groups.can, ['2', '1']);
  assert.equal(where(p, 3), 'dep:2');
  assert.deepEqual(p.tasks[2].waitedOnBy, ['3']);
});

test('two tasks naming the same resource clash with no shared file; neither waits (task 239)', () => {
  const p = plan([
    mk(1, { paths: ['a.js'], resources: ['prod-db'] }),
    mk(2, { paths: ['b.js'], resources: ['prod-db', 'dns'] }),
    mk(3, { paths: ['c.js'], resources: ['dns-other'] }),
  ]);
  assert.deepEqual(p.groups.can, ['1', '2', '3']);
  assert.deepEqual(p.tasks[1].clash, [{ id: '2', files: [], resources: ['prod-db'] }]);
  assert.deepEqual(p.tasks[2].clash, [{ id: '1', files: [], resources: ['prod-db'] }]);
  assert.deepEqual(p.tasks[3].clash, []);
  assert.deepEqual(p.tasks[2].resources, ['prod-db', 'dns']);
});

test('a file and a resource shared with the same task make one clash entry naming both', () => {
  const p = plan([mk(1, { paths: ['a.js'], resources: ['prod-db'] }), mk(2, { paths: ['a.js'], resources: ['prod-db'] })]);
  assert.deepEqual(p.tasks[1].clash, [{ id: '2', files: ['a.js'], resources: ['prod-db'] }]);
});

test('"can start" is sorted by how many tasks wait on each', () => {
  const p = plan([mk(1, { paths: ['a.js'] }), mk(2, { paths: ['b.js'] }), mk(3, { paths: ['c.js'], deps: [2] })]);
  assert.deepEqual(p.groups.can, ['2', '1']);
});

test('a shared Markdown doc is a soft clash: shown, but it holds nothing back', () => {
  const p = plan([mk(1, { paths: ['docs/A.md', 'a.js'] }), mk(2, { paths: ['docs/A.md', 'b.js'] })]);
  assert.equal(where(p, 1), 'can');
  assert.equal(where(p, 2), 'can');
  assert.deepEqual(p.tasks[1].clash, []);
  assert.deepEqual(p.tasks[1].softClash.map((c) => c.id), ['2']);
});

test('broad folders are ignored for clashes, and the task is flagged "files unknown"', () => {
  const tracked = Array.from({ length: 50 }, (_, i) => `frontend/src/app/f${i}.ts`);
  const p = plan([
    mk(1, { paths: ['docs/', 'core/'] }),
    mk(2, { paths: ['frontend/src/app/'] }),
    mk(3, { paths: ['core/x.mjs'] }),
  ], { tracked });
  assert.equal(p.tasks[1].filesUnknown, true);
  assert.equal(p.tasks[2].filesUnknown, true); // > 40 tracked files under it
  assert.deepEqual(p.tasks[3].clash, []);      // core/ was ignored, so no clash with 1
  assert.ok(p.problems.some((x) => x.id === '1' && x.kind === 'broad-paths'));
  assert.ok(p.problems.some((x) => x.id === '2' && x.kind === 'broad-paths'));
});

test('skippedPaths names what the clash check ignores — whole folders and paths outside the repo (task 239)', () => {
  const p = plan([mk(1, { paths: ['docs/', 'core/x.mjs', '~/.claude/CLAUDE.md'] }), mk(2, { paths: ['a.js'] })]);
  assert.deepEqual(p.tasks[1].skippedPaths, ['docs/', '~/.claude/CLAUDE.md']);
  assert.equal(p.tasks[1].filesUnknown, false, 'it still names one file');
  assert.deepEqual(p.tasks[2].skippedPaths, []);
});

test('a narrow folder entry clashes with a file under it', () => {
  const p = plan([mk(1, { paths: ['frontend/src/app/plan/'] }), mk(2, { paths: ['frontend/src/app/plan/plan.component.ts'] })],
    { tracked: ['frontend/src/app/plan/plan.component.ts'] });
  assert.deepEqual(p.tasks[1].clash.map((c) => c.id), ['2']);
});

test('in progress = claimed, worktree or not; a claim whose worktree is missing is flagged, never moved (task 189)', () => {
  const p = plan([
    mk(1, { paths: ['a.js'], env: { claimed_at: '2026-10-01T00:00:00Z', worktree: 'wt-1' } }),
    mk(2, { paths: ['b.js'], env: { claimed_at: '2026-08-18T00:00:00Z', worktree: 'wt-missing' } }),
  ], { liveWorktrees: new Set(['wt-1']) });
  assert.deepEqual(p.groups.progress, ['1', '2']);
  assert.equal(p.tasks[1].worktreeMissing, false);
  assert.equal(p.tasks[2].worktreeMissing, true);
  assert.ok(p.problems.some((x) => x.id === '2' && x.kind === 'stale-claim'));
});

test('a claim is valid only on an OPEN task: a claimed closed or parked task is a validator error, and the plan leaves it out', () => {
  // A task with follow-up work is reopened (OPEN again), so the plan places it;
  // a claim left on a closed or parked task is an error that names the fix.
  const p = plan([
    mk(1, { status: 'DONE', paths: ['a.js'], env: { claimed_at: '2026-10-12T01:59:47Z', worktree: 'wt-1', branch: 'b-1' } }),
    mk(2, { status: 'OPEN', paths: ['b.js'], env: { claimed_at: '2026-10-12T01:59:47Z', worktree: 'wt-1' } }),
  ], { liveWorktrees: new Set(['wt-1']) });
  assert.equal(where(p, 1), null, 'the closed task is not in the plan');
  assert.equal(where(p, 2), 'progress', 'a reopened (OPEN) claimed task is in progress');

  const v = (status, env) => validateTask({ path: '/x/001-t.md', hasFrontmatter: true, body: '',
    frontmatter: { id: 1, slug: 't', status, type: 'bug', env } }, {}).errors.filter((e) => e.startsWith('env.claimed_at'));
  const claimed = { claimed_at: '2026-10-12T01:59:47Z', claimed_by: 'Tester' };
  assert.match(v('DONE', claimed).join(), /status is DONE — a claim is valid only on an OPEN task; reopen it \(`cogyard tasks reopen 1/);
  assert.match(v('ENOUGH', claimed).join(), /reopen it/);
  assert.match(v('PARKED', claimed).join(), /status is PARKED .*release the claim/);
  assert.match(v('OBSOLETE', claimed).join(), /status is OBSOLETE/);
  assert.deepEqual(v('OPEN', claimed), []);
  assert.deepEqual(v('DONE', { claimed_at: null }), []);
  assert.deepEqual(v('DONE', { claimed_at: 'null' }), []);
  assert.deepEqual(v('DONE', undefined), []);
});

test('a claimed task whose worktree is missing stays in progress and still shows in the clash of a task sharing its file (task 189)', () => {
  const p = plan([
    mk(1, { paths: ['core/x.mjs'], env: { claimed_at: '2026-08-18T00:00:00Z', worktree: 'wt-missing' } }),
    mk(2, { paths: ['core/x.mjs'] }),
    mk(3, { paths: ['b.js'], deps: [2] }),
  ]);
  assert.equal(where(p, 1), 'progress');
  assert.equal(where(p, 2), 'can');
  assert.deepEqual(p.tasks[2].clash.map((c) => c.id), ['1']);
});

test('work in progress sharing a file is named in clash (what autopilot and the Autopilot filter read), never a wait', () => {
  const p = plan([
    mk(1, { paths: ['a.js'], env: { claimed_at: 'x', worktree: 'wt-1' } }),
    mk(2, { paths: ['a.js'] }),
  ], { liveWorktrees: new Set(['wt-1']) });
  assert.equal(where(p, 2), 'can');
  assert.deepEqual(p.tasks[2].clash, [{ id: '1', files: ['a.js'], resources: [] }]);
  assert.deepEqual(p.tasks[1].waitedOnBy, []);
});

test('parked tasks split into "built — needs your look" and parked by choice', () => {
  const p = plan([
    mk(1, { status: 'PARKED', open: 1, ticked: 9 }),                                  // 90% ticked
    mk(2, { status: 'PARKED', open: 5, ticked: 0, env: { branch: 'task-2' } }),        // unmerged commits
    mk(3, { status: 'PARKED', open: 5, ticked: 1 }),                                  // neither
  ], { branchAhead: new Map([['task-2', 3]]) });
  assert.deepEqual(p.groups.look, ['1', '2']);
  assert.deepEqual(p.parked, ['3']);
});

test('quick-look facts: type, and the opening of "What this is" as plain words', () => {
  const t = { path: '/x/1.md', hasFrontmatter: true, frontmatter: { id: 1, title: 'T', type: 'bug', status: 'OPEN', touches_paths: ['a.js'], depends_on: [], env: {} },
    body: '> **Status: OPEN.** note\n\n## What this is\n\n**The bug.** It `breaks` things.\n\n- a list\n\n## Scope\n- [ ] x' };
  const p = plan([t]);
  assert.equal(p.tasks[1].type, 'bug');
  assert.equal(p.tasks[1].what, 'The bug. It breaks things.');
});

test('card facts: labels from frontmatter (task 227) — [] when none, a scalar or junk entries dropped', () => {
  const p = plan([
    mk(1, { paths: ['a.js'], labels: ['frontend', 'store'] }),
    mk(2, { paths: ['b.js'] }),
    mk(3, { paths: ['c.js'], labels: 'security' }),
    mk(4, { paths: ['d.js'], labels: ['cli', '', null, 7] }),
  ]);
  assert.deepEqual(p.tasks[1].labels, ['frontend', 'store']);
  assert.deepEqual(p.tasks[2].labels, []);
  assert.deepEqual(p.tasks[3].labels, []);
  assert.deepEqual(p.tasks[4].labels, ['cli']);
});

test('owner steps: a box marked (you: kind) is the owner\'s; next vs later; ticking it clears it', () => {
  const t = (id, body) => ({ path: `/x/${id}.md`, hasFrontmatter: true, body, frontmatter: { id, title: `T${id}`, status: 'OPEN', touches_paths: [`f${id}.js`], depends_on: [], env: {} } });
  const p = plan([
    t(1, '- [ ] plain step\n- [ ] another'),                                                     // nothing marked
    t(2, '- [x] done\n- [ ] (you: credential) Log in to Cloudflare\n- [ ] move configs'),        // next is yours
    t(3, '- [ ] write code\n- [ ] (you: decision, purchase) Pick a plan'),                      // later is yours
    t(4, '- [x] (you: device) Test on the phone\n- [ ] ship'),                                   // ticked → cleared
  ]);
  assert.equal(p.tasks[1].youNext, null);
  assert.deepEqual(p.tasks[1].youLater, []);
  assert.deepEqual(p.tasks[2].youNext, ['credential']);
  assert.deepEqual(p.tasks[2].youSteps, [{ kinds: ['credential'], text: 'Log in to Cloudflare' }]);
  assert.equal(p.tasks[3].youNext, null);
  assert.deepEqual(p.tasks[3].youLater, ['decision', 'purchase']);
  assert.equal(p.tasks[4].youNext, null);
  assert.deepEqual(p.tasks[4].youSteps, []);
});

test('cross-project: an open dep in another project is unmet, a done one is met, and dependents mark what we block', () => {
  const p = plan([mk(1, { deps: ['other#5'] }), mk(2, { paths: ['a.js'] }), mk(3, { deps: ['other#006'] }), mk(4, { deps: ['ghost#1'] })], {
    dependents: [{ project: 'other', id: 76, title: 'Restore tunnel', status: 'PARKED', dep: 2 }],
  });
  assert.deepEqual(p.tasks[1].unmet, ['other#5']);
  assert.deepEqual(p.tasks[3].unmet, []);
  assert.deepEqual(p.tasks[4].unmet, ['ghost#1']); // unknown project = dangling = unmet
  assert.equal(p.tasks[2].touchesOther, true);
  assert.deepEqual(p.tasks[2].blocksOther.map((b) => `${b.project}#${b.id}`), ['other#76']);
});

test('a dep on a task that will never run is reported, not silently scheduled last', () => {
  const p = plan([mk(1, { status: 'PARKED', paths: ['a.js'] }), mk(2, { deps: [1], paths: ['b.js'] })]);
  assert.ok(p.problems.some((x) => x.id === '2' && x.kind === 'blocked-by-unscheduled'));
});

test('a task with a status the plan does not know is a problem, never silently dropped (task 186)', () => {
  const tasks = [
    mk(1, { paths: ['a.js'] }), mk(2, { status: 'PARKED', paths: ['b.js'] }),
    mk(3, { status: 'BLOCKED_ON', paths: ['c.js'] }), mk(4, { status: null, paths: ['d.js'] }),
    mk(5, { status: 'DONE', paths: ['e.js'] }),
  ];
  const p = plan(tasks);
  assert.equal(where(p, 3), null);
  assert.ok(p.problems.some((x) => x.id === '3' && x.kind === 'unknown-status' && x.text.includes('BLOCKED_ON')));
  assert.ok(p.problems.some((x) => x.id === '4' && x.kind === 'unknown-status'));
  // Every task that isn't closed is either placed or reported.
  const placedOrReported = tasks.filter((t) => t.frontmatter.status !== 'DONE')
    .every((t) => where(p, t.frontmatter.id) || p.problems.some((x) => x.id === String(t.frontmatter.id) && x.kind === 'unknown-status'));
  assert.ok(placedOrReported);
  assert.equal(where(p, 5), null);
  assert.ok(!p.problems.some((x) => x.id === '5'));
});

test('waitingWhyOf names a cross-project dep as <slug>#<id>, a local one as #<id>', () => {
  assert.equal(waitingWhyOf({ status: 'OPEN', depsMet: false, unmetDeps: ['other#5', 12] }, true), 'waiting on other#5, #12');
});

test('validate: owner-step kinds are a closed list (an error since task 238); a cross-project dep is not "dangling"', () => {
  const v = (fm, body = '') => validateTask({ path: '/x/001-t.md', hasFrontmatter: true, body, frontmatter: { id: 1, slug: 't', status: 'OPEN', type: 'feature', ...fm } }, { allIds: new Set(['1']) });
  assert.ok(!v({}, '- [ ] (you: credential, decision) Log in').errors.some((w) => /\(you/.test(w)));
  assert.ok(v({}, '- [ ] (you: coffee) Brew').errors.some((w) => /"coffee" not one of/.test(w)));
  assert.ok(v({}, '- [ ] (you) Something').errors.some((w) => /say what for/.test(w)));
  assert.ok(!v({}, '- [ ] (you: coffee) Brew').warnings.some((w) => /\(you/.test(w))); // never a warning any more
  const cross = v({ depends_on: ['other#5'] });
  assert.deepEqual(cross.errors, []);
  assert.ok(!cross.warnings.some((w) => /no matching task/.test(w)));
  assert.match(v({ depends_on: ['other#abc'] }).errors.join(), /expected <project-slug>#<id>/);
});

test('validate: a whole top-level folder in touches_paths is a warning, a file or narrow folder is not', () => {
  const v = (paths) => validateTask({ path: '/x/001-t.md', hasFrontmatter: true, frontmatter: { id: 1, slug: 't', status: 'OPEN', type: 'feature', touches_paths: paths } }, {}).warnings;
  assert.ok(v(['docs/']).some((w) => /whole top-level folder/.test(w)));
  assert.ok(!v(['docs/A.md', 'frontend/src/app/plan/']).some((w) => /whole top-level folder/.test(w)));
});

test('ids are text: a letter-suffixed id (040e) is placed, depended on, and sorted, never NaN', () => {
  const p = plan([mk('040e', { paths: ['a.js'] }), mk(41, { paths: ['a.js'], deps: ['40e'] }), mk(9, { paths: ['z.js'] })]);
  assert.ok(p.tasks['40e'], 'task 40e is in the plan under its own id');
  assert.equal(where(p, '40e'), 'can');
  assert.equal(where(p, 41), 'dep:40e');
  assert.deepEqual(p.tasks['40e'].unblocks, ['41']);
  assert.ok(!JSON.stringify(p).includes('null,') || !Object.keys(p.tasks).includes('NaN'));
  for (const k of ['dep', 'other']) for (const g of p.groups[k]) for (const id of g.tasks) assert.ok(p.tasks[id], `id ${id} resolves to a task`);
});

// ---- where the code is (task 251) -------------------------------------------
// A task with a body of its own: the boxes in the order given.
function mkBody(id, body, { status = 'OPEN', env = {}, ...fm } = {}) {
  return { path: `/x/${id}.md`, hasFrontmatter: true, body,
    frontmatter: { id, title: `Task ${id}`, status, touches_paths: ['a.js'], depends_on: [], env, ...fm } };
}
// M = ticked, on main · B = ticked, branch only · g = ticked, no state · . = unticked
const squares = (t) => t.boxes.map((b) => (!b.done ? '.' : b.onMain === true ? 'M' : b.onMain === false ? 'B' : 'g')).join('');
const HOUR = 3600 * 1000;

test('no branch and no [#N] commit on main: state none, ticked squares grey (onMain null), no counts', () => {
  const p = plan([mkBody(1, '- [x] a\n- [ ] b\n- [x] c')]);
  assert.deepEqual(p.tasks[1].code, { state: 'none', ahead: 0, behind: 0, branch: null });
  assert.equal(squares(p.tasks[1]), 'g.g');
  assert.ok(p.tasks[1].boxes.every((b) => b.onMain === null));
});

test('a recorded branch that no longer exists reads as none (it is missing from branchAhead)', () => {
  const p = plan([mkBody(1, '- [x] a\n- [ ] b', { env: { branch: 'gone' } })]);
  assert.deepEqual(p.tasks[1].code, { state: 'none', ahead: 0, behind: 0, branch: null });
});

test('merged: a [#N] commit on main and nothing on the branch main lacks — every ticked square on main', () => {
  const p = plan([mkBody(1, '- [x] a\n- [ ] b\n- [x] c', { env: { branch: 'b1' } })],
    { branchAhead: new Map([['b1', 0]]), branchBehind: new Map([['b1', 7]]), lastMerge: new Map([['1', 1000]]) });
  assert.deepEqual(p.tasks[1].code, { state: 'merged', ahead: 0, behind: 7, branch: 'b1' });
  assert.equal(squares(p.tasks[1]), 'M.M');
});

test('merged with the branch removed: still merged (the [#N] commit decides)', () => {
  const p = plan([mkBody(1, '- [x] a', { env: { branch: 'gone' } })], { lastMerge: new Map([['1', 1000]]) });
  assert.equal(p.tasks[1].code.state, 'merged');
  assert.equal(squares(p.tasks[1]), 'M');
});

test('a branch with 0 ahead and no [#N] commit on main is none, not merged (a branch never committed to)', () => {
  const p = plan([mkBody(1, '- [x] a\n- [ ] b', { env: { branch: 'b1' } })], { branchAhead: new Map([['b1', 0]]), branchBehind: new Map([['b1', 3]]) });
  assert.equal(p.tasks[1].code.state, 'none');
  assert.equal(squares(p.tasks[1]), 'g.');
});

test('ahead, never merged: every ticked square is branch-only, with ahead and behind counts', () => {
  const p = plan([mkBody(1, '- [ ] a\n- [x] b\n- [x] c', { env: { branch: 'b1' } })],
    { branchAhead: new Map([['b1', 4]]), branchBehind: new Map([['b1', 2]]) });
  assert.deepEqual(p.tasks[1].code, { state: 'ahead', ahead: 4, behind: 2, branch: 'b1' });
  assert.equal(squares(p.tasks[1]), '.BB');
});

test('ahead and merged before: ticked at or before the last merge (or inside the grace window) on main, after it branch-only', async () => {
  const { MERGE_GRACE_MS } = await import('../core/plan.mjs');
  const merged = 100 * HOUR;
  // body lines: 0 before, 1 at the merge, 2 inside the grace window, 3 after it, 4 unticked, 5 not committed yet (= now)
  const body = '- [x] before\n- [x] at\n- [x] grace\n- [x] after\n- [ ] open\n- [x] uncommitted';
  const ticks = new Map([[0, merged - HOUR], [1, merged], [2, merged + MERGE_GRACE_MS - 1000], [3, merged + MERGE_GRACE_MS + HOUR]]);
  const p = plan([mkBody(1, body, { env: { branch: 'b1' } })], {
    branchAhead: new Map([['b1', 2]]), branchBehind: new Map([['b1', 0]]),
    lastMerge: new Map([['1', merged]]), tickTimes: new Map([['1', ticks]]), now: merged + 10 * HOUR });
  assert.equal(p.tasks[1].code.state, 'ahead');
  assert.equal(squares(p.tasks[1]), 'MMMB.B');
});

test('lastMergeByTask: the newest [#N] commit per id, matched by the whole id ([#23] says nothing about 239)', async () => {
  const { lastMergeByTask } = await import('../core/plan.mjs');
  const log = ['300\x01[#23] feat: newest for 23', '200\x01[#023] fix: older 23', '150\x01[#028b] x', '100\x01chore: no task', '50\x01mention [#239] mid-subject'].join('\n');
  const m = lastMergeByTask(log);
  assert.deepEqual([...m], [['23', 300000], ['28b', 150000]]);
  assert.equal(m.has('239'), false);
  const p = plan([mkBody(239, '- [x] a', { env: { branch: 'b' } })], { branchAhead: new Map([['b', 0]]), lastMerge: m });
  assert.equal(p.tasks[239].code.state, 'none');
});

test('bodyLineTimes: blame times by BODY line, frontmatter skipped the way taskFromContent splits it', async () => {
  const { bodyLineTimes } = await import('../core/plan.mjs');
  const { taskFromContent, checkboxSteps } = await import('../core/frontmatter.mjs');
  const file = ['---', 'id: 1', '---', '# T', '- [x] one', '- [ ] two'];
  const porcelain = file.map((text, i) => `abc${i} ${i + 1} ${i + 1} 1\nauthor-time ${1000 + i}\nsummary s\n\t${text}`).join('\n');
  const times = bodyLineTimes(porcelain);
  const steps = checkboxSteps(taskFromContent('/x/1.md', file.join('\n')).body);
  assert.deepEqual(steps.map((s) => times.get(s.line)), [1004000, 1005000]);
});

test('boxes are in file order, and their length equals total with dropped, moved, optional and after-merge boxes in the file', () => {
  const body = [
    '- [ ] first open', '- [x] ticked', '- [ ] (dropped: moot) gone', '- [ ] (moved: 99) elsewhere',
    '- [ ] (optional) maybe', '- [ ] ~~struck~~', '```', '- [x] in a code block', '```', '- [x] last', '- [ ] (after merge) check',
  ].join('\n');
  const p = plan([mkBody(1, body)]);
  assert.equal(p.tasks[1].total, 5);
  assert.equal(p.tasks[1].boxes.length, p.tasks[1].total);
  assert.deepEqual(p.tasks[1].boxes.map((b) => b.done), [false, true, false, true, false]);
});

test('the "look" group still reads ahead as before: a parked task with commits ahead is built, an open one is not', () => {
  const p = plan([
    mkBody(1, '- [ ] a\n- [ ] b', { status: 'PARKED', env: { branch: 'b1' } }),
    mkBody(2, '- [ ] a', { env: { branch: 'b2' } }),
  ], { branchAhead: new Map([['b1', 1], ['b2', 5]]) });
  assert.deepEqual(p.groups.look, ['1']);
  assert.equal(where(p, 2), 'can');
});
