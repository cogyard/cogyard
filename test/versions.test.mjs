// test/versions.test.mjs — /api/versions change codes (task 173).
//
// The contract that keeps the portal fresh: an entry's code MUST change when
// anything its endpoint reads changes (or the entry goes stale on screen), and
// SHOULD stay put otherwise (or the browser re-downloads for nothing). Each test
// changes one input and checks which codes moved. Also locks the two safety
// rules: unknown entries are null ("poll it"), and computing codes never runs git.
//
// COGYARD_HOME is redirected to a throwaway dir BEFORE importing core, so this
// never touches the real ~/.cogyard.

import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, appendFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-versions-'));
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

const REPO = join(HOME, 'proj');
const STORE = join(HOME, '_tasks', 'proj');
const git = (...args) => execFileSync('git', ['-C', REPO, '-c', 'core.hooksPath=/dev/null', ...args], {
  stdio: 'ignore',
  env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'a@b.c' },
});

mkdirSync(REPO, { recursive: true });
mkdirSync(STORE, { recursive: true });
mkdirSync(join(HOME, 'usage'), { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
writeFileSync(join(REPO, 'a.txt'), 'a\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');
mkdirSync(join(REPO, '.cogyard'), { recursive: true });
symlinkSync(STORE, join(REPO, '.cogyard', 'tasks'));
writeFileSync(join(STORE, '001-x.md'), '---\nid: 1\nstatus: OPEN\n---\n# x\n');
writeFileSync(join(HOME, 'projects.json'), JSON.stringify([{ slug: 'proj', path: REPO, label: 'proj' }]));
writeFileSync(join(HOME, 'usage', 'usage.jsonl'), '');
writeFileSync(join(HOME, 'config.json'), '{}');

// Fix the clock: the task-list code folds in a 5-minute bucket.
mock.method(Date, 'now', () => 1_800_000_000_000);

const { versionsFor, discoverProjects } = await import('../core/index.mjs');

const KEYS = ['tasks|proj', 'branches|proj', 'daily|proj', 'plan|proj', 'usage|proj', 'usage', 'activity', 'overview', 'projects', 'config'];
const codes = () => versionsFor(KEYS, discoverProjects());
// Mtimes have ms resolution on most filesystems, but two writes in the same
// tick can still collide; push each touched file's mtime forward explicitly.
let bump = 0;
const touch = (p) => { bump += 10; const t = new Date(Date.UTC(2030, 0, 1) + bump * 1000); utimesSync(p, t, t); };

// Which keys changed between two snapshots.
const moved = (a, b) => KEYS.filter((k) => a[k] !== b[k]).sort();

test('every listed entry gets a code, and it is stable when nothing changes', () => {
  const a = codes(), b = codes();
  for (const k of KEYS) assert.match(a[k], /^[0-9a-f]{16}$/, k);
  assert.deepEqual(a, b);
});

test('entries without a code, and unknown projects, are null (= poll them)', () => {
  const v = versionsFor(['graph|proj', 'graph|proj|abc123', 'worktrees|proj', 'tree|proj|', 'wt-activity|proj', 'tasks|nope', 'bogus'], discoverProjects());
  for (const [k, code] of Object.entries(v)) assert.equal(code, null, k);
});

test('codes are computed without running git', () => {
  const prev = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try { for (const [k, code] of Object.entries(codes())) assert.notEqual(code, null, k); }
  finally { process.env.PATH = prev; }
});

// Not Daily: since task 187 /api/daily reads nothing in the store — its briefs,
// heartbeats and drift report live under $COGYARD_HOME by slug.
test('a task-file edit (a claim) moves the task list, branches, Plan, Overview and the project list', () => {
  const a = codes();
  writeFileSync(join(STORE, '001-x.md'), '---\nid: 1\nstatus: OPEN\nenv:\n  claimed_at: now\n---\n# x\n');
  touch(join(STORE, '001-x.md'));
  assert.deepEqual(moved(a, codes()), ['branches|proj', 'overview', 'plan|proj', 'projects', 'tasks|proj']);
});

test('a commit moves every entry that reads refs, and nothing else', () => {
  const a = codes();
  writeFileSync(join(REPO, 'a.txt'), 'b\n');
  git('commit', '-q', '-am', '[#1] change');
  assert.deepEqual(moved(a, codes()), ['activity', 'branches|proj', 'overview', 'plan|proj', 'projects', 'tasks|proj']);
});

test('adding a worktree moves the task list (worktree names) and the project list', () => {
  const a = codes();
  git('worktree', 'add', '-q', '-b', 'feat', join(HOME, 'proj-wt'));
  const m = moved(a, codes());
  assert.ok(m.includes('tasks|proj') && m.includes('projects') && m.includes('branches|proj') && m.includes('plan|proj'), m.join(','));
});

test('staging moves Overview only (its dirty count is index-gated)', () => {
  const a = codes();
  writeFileSync(join(REPO, 'a.txt'), 'c\n');
  git('add', 'a.txt');
  assert.deepEqual(moved(a, codes()), ['overview']);
});

test('a usage-ledger write moves both usage entries and Activity only', () => {
  const a = codes();
  appendFileSync(join(HOME, 'usage', 'usage.jsonl'), '{"sessionId":"s"}\n');
  touch(join(HOME, 'usage', 'usage.jsonl'));
  assert.deepEqual(moved(a, codes()), ['activity', 'usage', 'usage|proj']);
});

test('a new brief moves Daily and Overview', () => {
  const a = codes();
  mkdirSync(join(HOME, 'briefs', 'proj'), { recursive: true });
  writeFileSync(join(HOME, 'briefs', 'proj', '2030-01-01.md'), '# brief\n');
  assert.deepEqual(moved(a, codes()), ['daily|proj', 'overview']);
});

test('a heartbeat moves Daily only', () => {
  const a = codes();
  mkdirSync(join(HOME, 'heartbeats', 'proj'), { recursive: true });
  writeFileSync(join(HOME, 'heartbeats', 'proj', 'project-brief.md'), '---\njob: project-brief\n---\n');
  assert.deepEqual(moved(a, codes()), ['daily|proj']);
});

test('a drift report appearing, and being cleared, moves Daily only', () => {
  const a = codes();
  mkdirSync(join(HOME, 'drift'), { recursive: true });
  writeFileSync(join(HOME, 'drift', 'proj.md'), '---\nfindings: 1\n---\n');
  const b = codes();
  assert.deepEqual(moved(a, b), ['daily|proj']);
  rmSync(join(HOME, 'drift', 'proj.md'));
  assert.deepEqual(moved(b, codes()), ['daily|proj']);
});

test('job output left in the store moves nothing it used to', () => {
  // A stray pre-187 brief folder in a store is not read by anything any more.
  const a = codes();
  mkdirSync(join(STORE, 'briefs'), { recursive: true });
  writeFileSync(join(STORE, 'briefs', '2030-02-02.md'), '# old\n');
  const m = moved(a, codes());
  assert.ok(!m.includes('daily|proj') && !m.includes('overview'), m.join(','));
});

test('the shared label axes move the task list only', () => {
  const a = codes();
  writeFileSync(join(HOME, 'axes.json'), '{"axes":[]}');
  assert.deepEqual(moved(a, codes()), ['tasks|proj']);
});

test('config.json moves config only', () => {
  const a = codes();
  writeFileSync(join(HOME, 'config.json'), '{"ui":{"hiddenTabs":["stats"]}}');
  touch(join(HOME, 'config.json'));
  assert.deepEqual(moved(a, codes()), ['config']);
});

test('the registry moves every entry that reads it', () => {
  const a = codes();
  writeFileSync(join(HOME, 'projects.json'), JSON.stringify([{ slug: 'proj', path: REPO, label: 'Proj renamed' }]));
  touch(join(HOME, 'projects.json'));
  assert.deepEqual(moved(a, codes()), ['activity', 'config', 'daily|proj', 'overview', 'plan|proj', 'projects', 'tasks|proj', 'usage', 'usage|proj']);
});

test('the task list re-checks after the 5-minute clock bucket (server-made "N minutes ago")', () => {
  const a = codes();
  Date.now.mock.mockImplementation(() => 1_800_000_000_000 + 5 * 60 * 1000);
  assert.deepEqual(moved(a, codes()), ['tasks|proj']);
});
