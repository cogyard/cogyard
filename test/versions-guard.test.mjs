// test/versions-guard.test.mjs — the change codes checked against the REAL
// endpoints, not against a list of what each endpoint is believed to read.
//
// core/versions.mjs gives each portal entry a code that must move whenever the
// entry's endpoint would answer differently — otherwise the browser keeps the old
// answer and that page goes stale with no warning. test/versions.test.mjs checks
// the codes against the author's own model of each endpoint's inputs; if that
// model is wrong, the tests are wrong with it. This guard asks the endpoints:
// it applies a broad set of real changes to a sandbox (task edits, commits,
// branches, worktrees, briefs, the registry, config, ledgers …), calls every
// coded endpoint through its real route handler before and after each, and
// FAILS when an answer changed while its code did not.
//
// A new endpoint input is caught as soon as one of these changes touches it.
// When you add an input of a NEW kind, add a change for it below.
//
// COGYARD_HOME is redirected to a throwaway dir BEFORE importing core/server, so
// this never touches the real ~/.cogyard.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, appendFileSync, utimesSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-versions-guard-'));
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = HOME;
process.env.GIT_OPTIONAL_LOCKS = '0'; // as the portal sets it (server/index.mjs)
after(() => rmSync(HOME, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'a@b.c' };
const gitIn = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'ignore', env: ENV });

// Two projects: Plan and Overview read across projects.
function makeProject(slug) {
  const repo = join(HOME, slug), store = join(HOME, '_tasks', slug);
  mkdirSync(repo, { recursive: true });
  mkdirSync(store, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, '.gitignore'), '.cogyard/tasks\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(join(repo, '.cogyard'), { recursive: true });
  symlinkSync(store, join(repo, '.cogyard', 'tasks'));
  writeFileSync(join(store, '001-x.md'), '---\nid: 1\nstatus: OPEN\ncategory: feature\n---\n# x\n');
  return { slug, repo, store };
}
const A = makeProject('alpha');
const B = makeProject('beta');
// alpha was once registered at HOME/alpha-old (task 195): its output written
// back then sits under the former slug `alpha-old`, and Daily reads it too.
const registry = (labelA = 'alpha') => JSON.stringify([
  { slug: 'alpha', path: A.repo, label: labelA, aliases: [join(HOME, 'alpha-old')] },
  { slug: 'beta', path: B.repo, label: 'beta' },
]);
mkdirSync(join(HOME, 'usage'), { recursive: true });
writeFileSync(join(HOME, 'projects.json'), registry());
writeFileSync(join(HOME, 'usage', 'usage.jsonl'), '');
writeFileSync(join(HOME, 'config.json'), '{}');
// The nightly jobs' output, which lives under HOME by slug (task 187).
for (const s of ['alpha', 'alpha-old']) for (const k of ['briefs', 'heartbeats']) mkdirSync(join(HOME, k, s), { recursive: true });
mkdirSync(join(HOME, 'drift'), { recursive: true });

const core = await import('../core/index.mjs');
const meta = await import('../server/routes/meta.mjs');
const project = await import('../server/routes/project.mjs');
const git = await import('../server/routes/git.mjs');
const usage = await import('../server/routes/usage.mjs');
const activity = await import('../server/routes/activity.mjs');
const config = await import('../server/routes/config.mjs');

// Every coded entry → how the portal fetches it (the same path entries.ts uses).
const ENTRIES = {
  'tasks|alpha': ['project', '/api/tasks'],
  'branches|alpha': ['git', '/api/branches'],
  'daily|alpha': ['project', '/api/daily'],
  'plan|alpha': ['project', '/api/plan'],
  'recent|alpha': ['project', '/api/recently-done'],
  'usage|alpha': ['global', '/api/usage/project/alpha'],
  'usage': ['global', '/api/usage'],
  'activity': ['global', '/api/activity'],
  'overview': ['global', '/api/overview'],
  'in-progress': ['global', '/api/in-progress'],
  'projects': ['global', '/api/projects'],
  'config': ['global', '/api/config'],
};
const KEYS = Object.keys(ENTRIES);

// A stand-in for http.ServerResponse — json()/errJson() call these two.
function fakeRes() {
  return { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b ?? ''; } };
}
async function call(kind, path) {
  const projects = core.discoverProjects();
  const u = new URL(`http://localhost${path}?p=alpha`);
  const res = fakeRes();
  if (kind === 'global') {
    for (const r of [meta, usage, activity, config]) if (await r.handle(path, u, projects, res) !== false) break;
  } else {
    const proj = projects.find((p) => p.slug === 'alpha');
    await (kind === 'git' ? git : project).handle(path, u, proj, res);
  }
  assert.equal(res.code, 200, `${path} answered ${res.code}: ${res.body}`);
  // Compared as data: object keys sorted (per-project maps fill in whichever
  // order their git calls finish), and relative ages ("3 seconds ago") blanked —
  // they move with the clock, not with any file, and the task-list code bounds
  // them with a clock bucket on purpose.
  return canon(JSON.parse(res.body.replace(/\b\d+ (second|minute|hour|day|week|month|year)s? ago\b/g, '<ago>')));
}
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
async function snapshot() {
  const codes = core.versionsFor(KEYS, core.discoverProjects());
  const answers = {};
  for (const k of KEYS) answers[k] = await call(...ENTRIES[k]);
  return { codes, answers };
}

let bump = 0;
const touch = (p) => { bump += 10; const t = new Date(Date.UTC(2030, 0, 1) + bump * 1000); utimesSync(p, t, t); };
const write = (p, s) => { writeFileSync(p, s); touch(p); };

// One real change of each kind the portal's pages read.
const CHANGES = [
  ['claim a task (frontmatter edit)', () => write(join(A.store, '001-x.md'), '---\nid: 1\nstatus: OPEN\ncategory: feature\nenv:\n  claimed_at: 2030-01-01T00:00:00Z\n  claimed_by_session: s1\n---\n# x\n')],
  ['add a task file', () => write(join(A.store, '002-y.md'), '---\nid: 2\nstatus: OPEN\ncategory: bug\ndepends_on: [1]\n---\n# y\n')],
  ['close a task', () => write(join(A.store, '002-y.md'), '---\nid: 2\nstatus: DONE\ncategory: bug\n---\n# y\n')],
  ['give the closed task a done date', () => write(join(A.store, '002-y.md'), '---\nid: 2\nstatus: DONE\ncategory: bug\ndone_date: 2030-01-01\n---\n# y\n- [x] one\n')],
  ['commit on main', () => { writeFileSync(join(A.repo, 'a.txt'), 'b\n'); gitIn(A.repo, 'commit', '-qam', '[#1] work on x'); }],
  ['create a branch', () => gitIn(A.repo, 'branch', 'task-001-x')],
  ['commit on a branch', () => { gitIn(A.repo, 'checkout', '-q', 'task-001-x'); writeFileSync(join(A.repo, 'b.txt'), 'b\n'); gitIn(A.repo, 'add', '-A'); gitIn(A.repo, 'commit', '-qm', '[#1] branch work'); gitIn(A.repo, 'checkout', '-q', 'main'); }],
  ['add a worktree', () => gitIn(A.repo, 'worktree', 'add', '-q', join(HOME, 'wt-alpha'), 'task-001-x')],
  ['commit in the worktree', () => { const w = join(HOME, 'wt-alpha'); writeFileSync(join(w, 'c.txt'), 'c\n'); gitIn(w, 'add', '-A'); gitIn(w, 'commit', '-qm', '[#1] wt work'); }],
  ['remove the worktree', () => gitIn(A.repo, 'worktree', 'remove', '--force', join(HOME, 'wt-alpha'))],
  ['merge the branch', () => gitIn(A.repo, 'merge', '-q', '--no-ff', '-m', 'merge task-001-x', 'task-001-x')],
  ['stage a change', () => { writeFileSync(join(A.repo, 'a.txt'), 'staged\n'); gitIn(A.repo, 'add', 'a.txt'); }],
  ['a remote-tracking ref', () => gitIn(A.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')],
  ['a tag', () => gitIn(A.repo, 'tag', 'v1')],
  ['pack refs', () => gitIn(A.repo, 'pack-refs', '--all')],
  // Under the former slug first: alpha's own heartbeat (below) ends the old
  // drift report's say, which is itself an answer change the codes must see.
  ['add a brief under a former slug', () => write(join(HOME, 'briefs', 'alpha-old', '2029-12-01.md'), '---\ndate: 2029-12-01\nstatus: ok\n---\n\n# brief\n\nBefore the move.\n')],
  ['add a heartbeat under a former slug', () => write(join(HOME, 'heartbeats', 'alpha-old', 'doc-drift.md'), '---\njob: doc-drift\nchecked: 2029-12-01\noutcome: written\n---\n\nLooked.\n')],
  ['a drift report appears under a former slug', () => write(join(HOME, 'drift', 'alpha-old.md'), '---\nfindings: 3\nexamined: 3\n---\n\n# Doc drift\n')],
  ['add a brief', () => write(join(HOME, 'briefs', 'alpha', '2030-01-01.md'), '---\ndate: 2030-01-01\nstatus: ok\n---\n\n# brief\n\nA paragraph.\n')],
  ['add a heartbeat', () => write(join(HOME, 'heartbeats', 'alpha', 'project-brief.md'), '---\njob: project-brief\nchecked: 2030-01-01\noutcome: written\n---\n\nLooked.\n')],
  ['a drift report appears', () => write(join(HOME, 'drift', 'alpha.md'), '---\nfindings: 1\nexamined: 1\n---\n\n# Doc drift\n')],
  ['the drift report is cleared', () => { unlinkSync(join(HOME, 'drift', 'alpha.md')); touch(join(HOME, 'drift')); }],
  ['shared label axes', () => write(join(HOME, 'axes.json'), JSON.stringify({ axes: [{ id: 'surface', values: ['ui'] }] }))],
  ['project label axes', () => write(join(A.store, 'axes.json'), JSON.stringify({ axes: [{ id: 'area', values: ['x'] }] }))],
  ['rename a project in the registry', () => write(join(HOME, 'projects.json'), registry('Alpha'))],
  ['change config', () => write(join(HOME, 'config.json'), JSON.stringify({ ui: { hiddenTabs: ['stats'] } }))],
  ['append to the usage ledger', () => {
    const row = { capturedAt: '2030-01-01T00:00:00Z', sessionId: 's1', project: 'alpha', worktree: null, taskId: 1, model: 'm',
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, costUSD: 0.01, pricingVersion: null,
      backfilled: false, firstTs: '2030-01-01T00:00:00Z', lastTs: '2030-01-01T00:01:00Z', messages: 2 };
    appendFileSync(join(HOME, 'usage', 'usage.jsonl'), JSON.stringify(row) + '\n'); touch(join(HOME, 'usage', 'usage.jsonl'));
  }],
  ['another project gains a task that depends on ours', () => write(join(B.store, '001-z.md'), '---\nid: 1\nstatus: OPEN\ncategory: feature\ndepends_on: [alpha#1]\n---\n# z\n')],
  ['remove a task file', () => { unlinkSync(join(A.store, '002-y.md')); touch(A.store); }],
];

test('with no change, every answer and every code is stable (the guard has no noise)', async () => {
  // Warm-up: the first /api/config read seeds open-targets.json with defaults
  // (core/open-targets.mjs) — a one-time write on a fresh machine, not noise.
  await snapshot();
  const a = await snapshot(), b = await snapshot();
  for (const k of KEYS) {
    assert.equal(b.codes[k], a.codes[k], `${k}: code moved with no change`);
    assert.equal(b.answers[k], a.answers[k], `${k}: answer moved with no change`);
  }
});

test('whenever an endpoint answers differently, its change code moved', async () => {
  const misses = [];
  for (const [what, apply] of CHANGES) {
    const before = await snapshot();
    apply();
    const after = await snapshot();
    for (const k of KEYS) {
      assert.notEqual(after.codes[k], null, `${k} has no code after "${what}"`);
      if (after.answers[k] !== before.answers[k] && after.codes[k] === before.codes[k]) misses.push(`"${what}" changed ${k} but not its code`);
    }
  }
  assert.deepEqual(misses, [], 'a page would go stale:\n  ' + misses.join('\n  '));
});
