// `cogyard tasks park` / `unpark` end to end (task 244), on a throwaway
// local-only store linked from a throwaway repo, the same shape as
// close-cli.test.mjs: status and the text's park note change together, the
// claim is released, each step is one commit — and `close` refuses a task
// whose park is still live, so nobody is pushed into editing `status` by hand
// again (a phone app's task 158). Also: a task whose status and park note disagree
// is reported by `validate` and carries the error the Tasks tab flags.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTaskFile, loadTasks } from '../core/frontmatter.mjs';
import { tasksToData } from '../core/project.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function task(store, id, { status = 'OPEN', head = '', body = '- [x] built', claimedBy = null, doneDate = null } = {}) {
  const file = join(store, `00${id}-t${id}.md`);
  writeFileSync(file, [
    '---', `id: ${id}`, `slug: t${id}`, `title: t${id}`, `status: ${status}`, 'type: bug', `done_date: ${doneDate || 'null'}`,
    'env:', '  branch: null',
    `  claimed_at: ${claimedBy ? '2026-10-01T00:00:00.000Z' : 'null'}`,
    `  claimed_by: ${claimedBy || 'null'}`,
    '---', '', `# ${id}: t${id}`, '', ...(head ? [head, ''] : []), `> **Status: ${status}.** The task.`, '', '## Scope', '', body, '',
  ].join('\n'));
  return file;
}

// Task 158's shape: a hand-written live note on an OPEN task.
const NOTE_158 = '> **PARKED 2026-10-20 — waiting for an App Store release with 1.30.0 or later, then the check on\n'
  + '> the test phone** (owner: "merge it"). All three parts are merged.';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-park-')));
  dirs.push(root);
  const store = join(root, 'store'), repo = join(root, 'repo'), home = join(root, 'home');
  mkdirSync(store); mkdirSync(repo); mkdirSync(home);
  for (const d of [store, repo]) {
    git(d, ['init', '-q', '-b', 'main']);
    git(d, ['config', 'user.email', 'test@example.com']);
    git(d, ['config', 'user.name', 'Tester']);
  }
  const files = {
    open: task(store, 1, { claimedBy: 'Tester' }),                                   // a plain OPEN task, claimed
    like158: task(store, 2, { head: NOTE_158 }),                                       // OPEN + live note
    doneWithNote: task(store, 3, { status: 'DONE', doneDate: '2026-10-18', head: '> **PARKED 2026-10-12 — waiting for the test phone on 1.8.0** (owner: "release and park them").' }),
    parkedNoNote: task(store, 4, { status: 'PARKED' }),                                // PARKED, nothing recorded
  };
  git(store, ['add', '-A']); git(store, ['commit', '-qm', 'seed']);
  writeFileSync(join(repo, '.gitignore'), '.cogyard/tasks\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'seed']);
  mkdirSync(join(repo, '.cogyard'));
  symlinkSync(store, join(repo, '.cogyard', 'tasks'));
  return { store, repo, home, files };
}

const AGENT_VARS = ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID'];
function run(fx, sub, ...args) {
  const env = { ...process.env, COGYARD_HOME: fx.home, COGYARD_USER: 'Tester' };
  for (const k of AGENT_VARS) delete env[k];
  return spawnSync('node', [CLI, sub, ...args], { cwd: fx.repo, encoding: 'utf8', env });
}
const lastCommit = (fx) => git(fx.store, ['log', '-1', '--format=%s']);
const parkErrors = (fx, file) => {
  const r = run(fx, 'validate', String(readTaskFile(file).frontmatter.id));
  return { status: r.status, park: r.stdout.split('\n').filter((l) => l.includes('✗ park:')) };
};

test('park: OPEN → PARKED, the live note under the title, the status line true, the claim released — one commit, file only', () => {
  const fx = fixture();
  const r = run(fx, 'park', '1', 'waiting for the vendor reply');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`#1 parked \\(since ${today()}\\), claim released\\.`));
  const t = readTaskFile(fx.files.open);
  assert.equal(t.frontmatter.status, 'PARKED');
  assert.equal(t.frontmatter.env.claimed_at, null);
  assert.ok(t.body.includes(`# 1: t1\n\n> **PARKED ${today()} — waiting for the vendor reply**\n\n> **Status: PARKED.** The task.`), t.body);
  assert.equal(lastCommit(fx), 'park #1 — waiting for the vendor reply');
  assert.deepEqual(git(fx.store, ['show', '--name-only', '--format=', 'HEAD']).split('\n'), ['001-t1.md']);
  assert.equal(git(fx.store, ['status', '--porcelain']), '');
  assert.deepEqual(parkErrors(fx, fx.files.open), { status: 0, park: [] });
});

test('park → close refused, even with --force, naming unpark; park → unpark → close goes through', () => {
  const fx = fixture();
  assert.equal(run(fx, 'park', '1', 'waiting for the vendor reply').status, 0);
  const before = readFileSync(fx.files.open, 'utf8');
  for (const args of [['1'], ['1', '--force'], ['1', '--enough']]) {
    const r = run(fx, 'close', ...args);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /Not closing #1: status is PARKED \("PARKED \d{4}-\d{2}-\d{2} — waiting for the vendor reply"\) — a parked task is un-parked before it closes: `cogyard tasks unpark 1 "<what was seen that ends the wait>"`, then close it\./);
    assert.match(r.stderr, /--enough and --force don't override this\. Never set the status by hand to get past it\./);
    assert.equal(readFileSync(fx.files.open, 'utf8'), before);
  }
  const u = run(fx, 'unpark', '1', 'the vendor replied');
  assert.equal(u.status, 0, u.stderr);
  const t = readTaskFile(fx.files.open);
  assert.equal(t.frontmatter.status, 'OPEN');
  assert.ok(t.body.includes(`> Parked ${today()} – ${today()}: waiting for the vendor reply.\n> Un-parked ${today()}: the vendor replied.\n\n> **Status: OPEN.**`), t.body);
  assert.equal(lastCommit(fx), 'unpark #1 (PARKED → OPEN) — the vendor replied');
  const c = run(fx, 'close', '1');
  assert.equal(c.status, 0, c.stderr);
  assert.equal(readTaskFile(fx.files.open).frontmatter.status, 'DONE');
  assert.deepEqual(git(fx.store, ['log', '-3', '--format=%s']).split('\n'),
    ['close #1 as DONE', 'unpark #1 (PARKED → OPEN) — the vendor replied', 'park #1 — waiting for the vendor reply']);
  // The closed task keeps only the ended record.
  assert.ok(readFileSync(fx.files.open, 'utf8').includes('> Parked '));
  assert.doesNotMatch(readFileSync(fx.files.open, 'utf8'), /^> \*\*PARKED/m);
});

test('park refuses a task that isn\'t OPEN, and one with no reason; unpark refuses an OPEN task with no note — nothing changes', () => {
  const fx = fixture();
  const done = task(fx.store, 5, { status: 'DONE', doneDate: '2026-10-01' });
  git(fx.store, ['add', '-A']); git(fx.store, ['commit', '-qm', 'add 5']);
  const cases = [
    { args: ['park', '5', 'x'], file: done, why: /#5 is DONE — park takes an OPEN task\. To park a closed task, reopen it first/ },
    { args: ['park', '1'], file: fx.files.open, why: /Say what #1 waits for/ },
    { args: ['unpark', '1', 'x'], file: fx.files.open, why: /#1 is OPEN and its text has no live park note — unpark takes a PARKED task/ },
    { args: ['park', '1', 'x', '--on', '2999-01-01'], file: fx.files.open, why: /--on 2999-01-01 is in the future/ },
    { args: ['park', '1', 'x', '--on', '2026-02-30'], file: fx.files.open, why: /--on 2026-02-30: expected a date YYYY-MM-DD/ },
  ];
  for (const c of cases) {
    const before = readFileSync(c.file, 'utf8');
    const r = run(fx, ...c.args);
    assert.equal(r.status, 1, `${c.args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, c.why);
    assert.equal(readFileSync(c.file, 'utf8'), before);
  }
  assert.equal(lastCommit(fx), 'add 5');
  // A second park of a parked task is refused, naming unpark.
  assert.equal(run(fx, 'park', '1', 'x').status, 0);
  assert.match(run(fx, 'park', '1', 'y').stderr, /#1 is already PARKED \("PARKED \d{4}-\d{2}-\d{2} — x"\)\. When the wait is over: `cogyard tasks unpark 1/);
  // unpark before the park began is refused.
  assert.match(run(fx, 'unpark', '1', 'x', '--on', '2020-01-01').stderr, /--on 2020-01-01 is before the park began/);
});

// --- the contradictions this task catches, and the command that fixes each ----

test('OPEN with a live note (158): validate reports it, close refuses naming unpark, and the Tasks tab row carries the error', () => {
  const fx = fixture();
  const v = parkErrors(fx, fx.files.like158);
  assert.equal(v.status, 1);
  assert.equal(v.park.length, 1);
  assert.match(v.park[0], /park: the text says "PARKED 2026-10-20 — waiting for an App Store release with 1\.30\.0 or later, then the check on the test phone" \(a live park note\) but status is OPEN/);
  const c = run(fx, 'close', '2', '--force');
  assert.equal(c.status, 1);
  assert.match(c.stderr, /Not closing #2: its text still has a live park note \("PARKED 2026-10-20 — waiting for/);
  // The Tasks tab's flag reads schemaErrors (frontend tasks.component.html) —
  // the same rows the portal's /api project route sends.
  const rows = tasksToData(loadTasks(fx.store), fx.store);
  const row = rows.find((x) => String(x.id) === '2');
  assert.equal(row.schemaErrors.length, 1);
  assert.match(row.schemaErrors[0], /^park: the text says "PARKED 2026-10-20/);
  assert.deepEqual(rows.find((x) => String(x.id) === '1').schemaErrors, []);
});

test('OPEN with a live note: `park <id>` (no reason) sets PARKED and keeps the note; with a reason it refuses', () => {
  const fx = fixture();
  const refused = run(fx, 'park', '2', 'something else');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already has a live park note \("PARKED 2026-10-20 — waiting for/);
  const r = run(fx, 'park', '2');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /#2 status set to PARKED; its note of 2026-10-20 kept\./);
  const t = readTaskFile(fx.files.like158);
  assert.equal(t.frontmatter.status, 'PARKED');
  assert.ok(t.body.includes(NOTE_158), 'the hand-written note is kept as it was');
  assert.match(t.body, /^> \*\*Status: PARKED\.\*\*/m);
  assert.match(lastCommit(fx), /^park #2 \(keeps its note of 2026-10-20\) — waiting for an App Store release/);
  assert.deepEqual(parkErrors(fx, fx.files.like158), { status: 0, park: [] });
});

test('DONE with a live note: reopen refuses naming unpark; unpark --on ends the note, the status stays DONE, validate is clean', () => {
  const fx = fixture();
  assert.match(parkErrors(fx, fx.files.doneWithNote).park[0], /but status is DONE; a DONE task keeps only an ended record — `cogyard tasks unpark 3 "<what was seen>" --on <the day the wait ended>`/);
  const before = readFileSync(fx.files.doneWithNote, 'utf8');
  const re = run(fx, 'reopen', '3', '--why', 'more work');
  assert.equal(re.status, 1);
  assert.match(re.stderr, /#3 is DONE but its text still has a live park note \("PARKED 2026-10-12 — waiting for the test phone on 1\.8\.0"\)\. Reopening would leave an OPEN task saying it is parked/);
  assert.equal(readFileSync(fx.files.doneWithNote, 'utf8'), before);
  const u = run(fx, 'unpark', '3', 'checked on 1.15.0, passed', '--on', '2026-10-18');
  assert.equal(u.status, 0, u.stderr);
  const t = readTaskFile(fx.files.doneWithNote);
  assert.equal(t.frontmatter.status, 'DONE');
  assert.equal(String(t.frontmatter.done_date), '2026-10-18');
  assert.ok(t.body.includes('> Parked 2026-10-12 – 2026-10-18: waiting for the test phone on 1.8.0 (owner: "release and park them").\n> Un-parked 2026-10-18: checked on 1.15.0, passed.'), t.body);
  assert.equal(lastCommit(fx), 'unpark #3 (ends the park note; status stays DONE) — checked on 1.15.0, passed');
  assert.deepEqual(parkErrors(fx, fx.files.doneWithNote), { status: 0, park: [] });
  // Now reopen goes through.
  assert.equal(run(fx, 'reopen', '3').status, 0);
});

test('PARKED with no note: validate reports it; `park <id> "<reason>" --on <date>` records it, status stays PARKED', () => {
  const fx = fixture();
  assert.match(parkErrors(fx, fx.files.parkedNoNote).park[0], /park: status is PARKED but the text has no live park note saying what it waits for/);
  const r = run(fx, 'park', '4', 'waiting on task 012', '--on', '2026-07-17');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /#4 park note written \(since 2026-07-17\); status stays PARKED\./);
  const t = readTaskFile(fx.files.parkedNoNote);
  assert.equal(t.frontmatter.status, 'PARKED');
  assert.ok(t.body.includes('> **PARKED 2026-07-17 — waiting on task 012**'));
  assert.equal(lastCommit(fx), 'park #4 (records what it waits for, since 2026-07-17) — waiting on task 012');
  assert.deepEqual(parkErrors(fx, fx.files.parkedNoNote), { status: 0, park: [] });
});
