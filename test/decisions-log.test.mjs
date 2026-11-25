// test/decisions-log.test.mjs — the decisions-log merge check (task 276).
//
// A project names its decisions log in the `decisions_log` switch; then
// `cogyard tasks validate <id>` — the merge gate — refuses an OPEN task that
// records a decision (a ticked `(you: decision)` box, or a heading that starts
// with "Decision") until an entry in the log cites it in its heading, unless
// the task carries a line `(not for the log: <why>)`. With the switch off it
// never fires; it never turns a closed task red; and only `validate <id>` runs
// it, so `validate --all` and the edit-time regression rule are unchanged.
//
// End to end on a throwaway local-only store linked from a throwaway repo
// (the shape park-cli.test.mjs uses), with COGYARD_HOME a scratch dir.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { taskFromContent } from '../core/frontmatter.mjs';
import { validateTask, introducedErrors, decisionLogProblems, decisionMarks, logCitesTask } from '../core/validate.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const LOG = 'docs/DECISIONS.md';
const LOG_HEAD = '# Decisions log\n\nNewest first.\n\n---\n\n## 2026-06-10 — An old decision (task 9)\n\nWhy.\n';

function content(id, { status = 'OPEN', body = '- [x] built', doneDate = null } = {}) {
  return [
    '---', `id: ${id}`, `slug: t${id}`, `title: t${id}`, `status: ${status}`, 'type: feature', `done_date: ${doneDate || 'null'}`,
    'env:', '  branch: null', '  claimed_at: null', '  claimed_by: null',
    '---', '', `# ${id}: t${id}`, '', '## Scope', '', body, '',
  ].join('\n');
}
const parse = (id, opts) => taskFromContent(`/s/00${id}-t${id}.md`, content(id, opts));

// The bodies the CLI cases use, by task id.
const BODIES = {
  1: { body: '- [x] (you: decision) Pick the store layout\n- [x] built' },                 // ticked decision box
  2: { body: '## Decision (owner, 2026-11-01)\n\nThe owner chose B.\n\n- [ ] build it' }, // a Decision heading
  3: { body: '### Decisions\n\nThe badge is blue.\n\n(not for the log: a colour pick)\n\n- [x] built' },
  4: { body: '- [x] built\n- [ ] the rest' },                                               // records nothing
  5: { status: 'DONE', doneDate: '2026-11-02', body: '## Decision\n\nClosed long ago.\n\n- [x] built' },
  6: { body: '- [ ] (you: decision) Pick one later\n- [ ] build it' },                       // decision box NOT ticked
};

function fixture({ switchOn = true, log = LOG_HEAD } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-declog-')));
  dirs.push(root);
  const store = join(root, 'store'), repo = join(root, 'repo'), home = join(root, 'home');
  mkdirSync(store); mkdirSync(repo); mkdirSync(home);
  for (const d of [store, repo]) {
    git(d, ['init', '-q', '-b', 'main']);
    git(d, ['config', 'user.email', 'test@example.com']);
    git(d, ['config', 'user.name', 'Tester']);
  }
  for (const [id, opts] of Object.entries(BODIES)) writeFileSync(join(store, `00${id}-t${id}.md`), content(Number(id), opts));
  if (switchOn) writeFileSync(join(store, 'switches.json'), JSON.stringify({ decisions_log: LOG }));
  git(store, ['add', '-A']); git(store, ['commit', '-qm', 'seed']);
  writeFileSync(join(repo, '.gitignore'), '.cogyard/tasks\n');
  if (log != null) { mkdirSync(join(repo, 'docs')); writeFileSync(join(repo, LOG), log); }
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'seed']);
  mkdirSync(join(repo, '.cogyard'));
  symlinkSync(store, join(repo, '.cogyard', 'tasks'));
  return { store, repo, home };
}

const AGENT_VARS = ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID'];
function validate(fx, ...args) {
  const env = { ...process.env, COGYARD_HOME: fx.home, COGYARD_USER: 'Tester' };
  for (const k of AGENT_VARS) delete env[k];
  const r = spawnSync('node', [CLI, 'validate', ...args], { cwd: fx.repo, encoding: 'utf8', env });
  return { status: r.status, out: r.stdout + r.stderr, log: r.stdout.split('\n').filter((l) => l.includes('✗ decisions log:')) };
}
const addEntry = (fx, heading) => writeFileSync(join(fx.repo, LOG), LOG_HEAD.replace('---\n\n', `---\n\n${heading}\n\nThe decision, why, what was rejected, where.\n\n`));

test('check on: a ticked (you: decision) box with no entry exits 1, naming the log and the entry shape', () => {
  const fx = fixture();
  const r = validate(fx, '1');
  assert.equal(r.status, 1, r.out);
  assert.equal(r.log.length, 1, r.out);
  assert.match(r.log[0], /a ticked \(you: decision\) box "Pick the store layout"/);
  assert.match(r.log[0], new RegExp(`${LOG} has no entry whose heading cites it`));
  assert.match(r.log[0], /"## <YYYY-MM-DD, the day it was decided> — <the decision, in a few words> \(task 1\)"/);
  assert.match(r.log[0], /\(not for the log: <why>\)/);
});

test('check on: a heading that starts with "Decision" triggers it too', () => {
  const fx = fixture();
  const r = validate(fx, '2');
  assert.equal(r.status, 1, r.out);
  assert.match(r.log[0], /the heading "## Decision \(owner, 2026-11-01\)"/);
});

test('check on: exits 0 once an entry heading cites the task — "(task N)", padded, or in a "(tasks …)" list', () => {
  const fx = fixture();
  addEntry(fx, '## 2026-11-01 — The store layout (task 001)');
  assert.equal(validate(fx, '1').status, 0);
  addEntry(fx, '## 2026-11-01 — Two at once (tasks 7, 002)');
  assert.equal(validate(fx, '2').status, 0);
  // Mentioned only in an entry's text, not its heading: still refused.
  writeFileSync(join(fx.repo, LOG), LOG_HEAD + '\nSee task 2 for more.\n');
  assert.equal(validate(fx, '2').status, 1);
});

test('check on: a task marked (not for the log: why) passes; so does one that records nothing, a closed one, and an unticked decision box', () => {
  const fx = fixture();
  for (const id of ['3', '4', '5', '6']) {
    const r = validate(fx, id);
    assert.equal(r.status, 0, `task ${id}: ${r.out}`);
    assert.equal(r.log.length, 0, `task ${id}`);
  }
});

test('check on, log file missing: the message says the file does not exist', () => {
  const fx = fixture({ log: null });
  const r = validate(fx, '1');
  assert.equal(r.status, 1);
  assert.match(r.log[0], new RegExp(`\\(${LOG} does not exist yet\\)`));
});

test('check off (no switch): every task passes, decision or not', () => {
  const fx = fixture({ switchOn: false });
  for (const id of Object.keys(BODIES)) assert.equal(validate(fx, id).status, 0, `task ${id}`);
});

test('validate --all (and so doctor, the portal, the edit hook) never runs it — only validate <id>, the merge gate', () => {
  const fx = fixture();
  const r = validate(fx);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /decisions log:/);
});

test('ticking a (you: decision) box is never refused for want of the entry — the edit-time regression rule ignores the check', () => {
  const before = parse(1, { body: '- [ ] (you: decision) Pick the store layout' });
  const after = parse(1, { body: '- [x] (you: decision) Pick the store layout' });
  assert.deepEqual(introducedErrors([], before, after), []);
});

test('decisionMarks: ticked decision boxes and Decision headings, outside code blocks, in body order', () => {
  const body = '\n## Decisions made at pickup\n\n- [x] (you: decision, credential) x\n- [x] (you: credential) y\n- [ ] (you: decision) z\n\n```\n## Decision in an example\n- [x] (you: decision) example\n```\n#### **Decision** (owner)\n## Not a decision heading\n';
  assert.deepEqual(decisionMarks(body).map((m) => m.line), [1, 3, 11]);
  assert.deepEqual(decisionMarks('## Background\n\nWe decided things.\n- [x] built\n'), []);
});

test('logCitesTask: reads only headings, compares ids however they are padded', () => {
  const log = '# Log\n\n## 2026-10-06 — A thing (task 159)\n\n## 2026-06-19+ — Ports (tasks 042, 046)\n\nBody mentions task 300.\n\n## 2026-06-22 / 2026-06-13 — Read-mostly (tasks 012 and 026)\n';
  for (const id of [159, '0159', 42, 46, '046', 12, 26]) assert.equal(logCitesTask(log, id), true, String(id));
  for (const id of [300, 15, 2026, 6]) assert.equal(logCitesTask(log, id), false, String(id));
  assert.equal(logCitesTask(null, 1), false);
});

test('decisionLogProblems: pure — off without a path, quiet for closed and parked tasks', () => {
  const t = parse(1, { body: '- [x] (you: decision) x' });
  assert.deepEqual(decisionLogProblems(t, { path: null, text: '' }), []);
  assert.equal(decisionLogProblems(t, { path: LOG, text: LOG_HEAD }).length, 1);
  for (const status of ['DONE', 'ENOUGH', 'PARKED', 'OBSOLETE']) {
    assert.deepEqual(decisionLogProblems(parse(1, { status, body: '- [x] (you: decision) x' }), { path: LOG, text: LOG_HEAD }), [], status);
  }
});

test('the way-out marker: a badly written one is an error everywhere; a quoted one mid-line is prose', () => {
  const errs = (body) => validateTask(parse(1, { body })).errors.filter((e) => e.startsWith('decisions log:'));
  assert.deepEqual(errs('(not for the log: a colour pick)\n- [x] built'), []);
  assert.deepEqual(errs('- (not for the log: a colour pick)\n> (not for the log: a size)'), []);
  assert.deepEqual(errs('Mark it with `(not for the log: <why>)` on its own line.'), []);
  assert.match(errs('(not for the log)')[0], /say why/);
  assert.match(errs('(not for the log: )')[0], /say why/);
  assert.match(errs('(not in the log: a colour)')[0], /write it as \(not for the log: <why>\)/);
  assert.match(errs('(not for decisions log: x)')[0], /write it as \(not for the log: <why>\)/);
  // A badly written one does not count as the way out.
  assert.equal(decisionLogProblems(parse(1, { body: '## Decision\n\n(not for the log)' }), { path: LOG, text: LOG_HEAD }).length, 1);
});
