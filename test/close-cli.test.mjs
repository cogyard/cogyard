// `cogyard tasks close` end to end (task 171) on a throwaway local-only store:
// it writes status + done_date, releases the claim through `env release`, and
// commits — or refuses, says why, and leaves the file untouched.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTaskFile } from '../core/frontmatter.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function task(store, id, body, { claimedBy = null, branch = null } = {}) {
  const file = join(store, `00${id}-t${id}.md`);
  writeFileSync(file, [
    '---', `id: ${id}`, `slug: t${id}`, `title: t${id}`, 'status: OPEN', 'type: bug', 'done_date: null',
    'env:', '  worktree: null', `  branch: ${branch || 'null'}`,
    `  claimed_at: ${claimedBy ? '2026-10-01T00:00:00.000Z' : 'null'}`,
    `  claimed_by: ${claimedBy || 'null'}`,
    `  claimed_by_session: ${claimedBy ? 'a-dead-session' : 'null'}`,
    '---', '', `# ${id}`, '', body, '',
  ].join('\n'));
  return file;
}

// A local-only store (no remote) linked from a project repo — the shape `close`
// must work on, where sync push can only commit.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-close-')));
  dirs.push(root);
  const store = join(root, 'store');
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(store); mkdirSync(repo); mkdirSync(home);
  for (const d of [store, repo]) {
    git(d, ['init', '-q', '-b', 'main']);
    git(d, ['config', 'user.email', 'test@example.com']);
    git(d, ['config', 'user.name', 'Tester']);
  }
  const files = {
    done: task(store, 1, '- [x] built\n- [ ] ~~dropped idea~~\n- [ ] (moved: 2) the rest', { claimedBy: 'Tester', branch: 'task-1' }),
    open: task(store, 2, '- [x] built\n- [ ] still to do'),
    leftover: task(store, 3, '- [x] built\n- [ ] (optional) polish later'),
    theirs: task(store, 4, '- [x] built', { claimedBy: 'Someone Else' }),
  };
  git(store, ['add', '-A']); git(store, ['commit', '-qm', 'seed']);
  writeFileSync(join(repo, '.gitignore'), '.cogyard/tasks\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'seed']);
  // Task 1's branch: a commit of its own, merged into main.
  git(repo, ['checkout', '-q', '-b', 'task-1']);
  writeFileSync(join(repo, 'feature.txt'), 'built\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'build it']);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge task-1', 'task-1']);
  mkdirSync(join(repo, '.cogyard'));
  symlinkSync(store, join(repo, '.cogyard', 'tasks'));
  return { store, repo, home, files };
}

// The owner's shell by default: these tests often run inside an agent, whose
// variables would make every owner-only path refuse (task 228). `asAgent` puts
// one back to see the refusal.
const AGENT_VARS = ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID'];
// `said`: what the owner typed in the agent's chat (task 237) — written as that
// chat's transcript under a throwaway HOME, where the Claude driver reads it.
// `agentWrote`: lines the agent itself put in that chat (its text, a skill's
// expanded ARGUMENTS) — present in the transcript, never the owner's.
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function run(fx, sub, args, { asAgent = false, said = null, agentWrote = [] } = {}) {
  const env = { ...process.env, COGYARD_HOME: fx.home, COGYARD_USER: 'Tester' };
  for (const k of AGENT_VARS) delete env[k];
  if (asAgent) env.CLAUDECODE = '1';
  if (said) {
    const home = join(dirname(fx.home), 'claude-home');
    const dir = join(home, '.claude', 'projects', '-repo');
    mkdirSync(dir, { recursive: true });
    const lines = [
      ...said.map((text, i) => ({ type: 'user', sessionId: SID, uuid: `o${i}`, origin: { kind: 'human' }, message: { content: text } })),
      ...agentWrote.map((text, i) => ({ type: 'user', sessionId: SID, uuid: `m${i}`, isMeta: true, message: { content: [{ type: 'text', text }] } })),
      ...agentWrote.map((text, i) => ({ type: 'assistant', sessionId: SID, uuid: `a${i}`, message: { content: [{ type: 'text', text }] } })),
    ];
    writeFileSync(join(dir, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    env.HOME = home;
    env.CLAUDE_CODE_SESSION_ID = SID;
  }
  return spawnSync('node', [CLI, sub, ...args], { cwd: fx.repo, encoding: 'utf8', env });
}
const close = (fx, ...args) => run(fx, 'close', args);
const reopen = (fx, ...args) => run(fx, 'reopen', args);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('a closeable task (boxes settled, branch merged, my claim): DONE + today, claim released, committed (the task file only) — on a store with no remote', () => {
  const fx = fixture();
  const r = close(fx, '1');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Committed locally; skipping push \(no remote configured\)/);
  assert.match(r.stdout, /#1 closed as DONE .*claim released/);
  const fm = readTaskFile(fx.files.done).frontmatter;
  assert.equal(fm.status, 'DONE');
  assert.equal(String(fm.done_date), today());
  assert.equal(fm.env.claimed_at, null);
  assert.equal(fm.env.claimed_by_session, null);
  assert.equal(git(fx.store, ['log', '-1', '--format=%s']), 'close #1 as DONE');
  assert.deepEqual(git(fx.store, ['show', '--name-only', '--format=', 'HEAD']).split('\n').sort(), ['001-t1.md']);
  assert.equal(git(fx.store, ['status', '--porcelain']), '');
  // `find` still resolves it — to the same store file, now DONE.
  const found = spawnSync('node', [CLI, 'find', '1'], { cwd: fx.repo, encoding: 'utf8' }).stdout.trim();
  assert.equal(found, fx.files.done);
  assert.equal(readTaskFile(found).frontmatter.status, 'DONE');
});

test('an open box: refuses, names the box, and the file is untouched', () => {
  const fx = fixture();
  const before = readFileSync(fx.files.open, 'utf8');
  const r = close(fx, '2');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1 box\(es\) still open:[\s\S]*still to do/);
  assert.match(r.stderr, /--enough/);
  assert.equal(readFileSync(fx.files.open, 'utf8'), before);
  assert.equal(git(fx.store, ['log', '-1', '--format=%s']), 'seed');
});

// Task 238 (owner, 2026-10-30): a badly written marker is called out at the
// close a merge runs, for DONE and ENOUGH alike, and nothing is written.
test('a badly written marker — retired, or moved to a missing task — refuses DONE and ENOUGH, naming it; the file is untouched', () => {
  const fx = fixture();
  const file = task(fx.store, 5, '- [x] built\n- [ ] (deferred) polish later\n- [ ] (moved: 999) the rest');
  git(fx.store, ['add', '-A']); git(fx.store, ['commit', '-qm', 'add 5']);
  const before = readFileSync(file, 'utf8');
  for (const args of [['5'], ['5', '--enough']]) {
    const r = close(fx, ...args);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /2 badly written checkbox marker\(s\) — fix each first/);
    assert.match(r.stderr, /checkbox "\(deferred\)" — that word is retired: write \(optional\)/);
    assert.match(r.stderr, /checkbox "\(moved: 999\)" — no task 999 in this project; file that task first/);
  }
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(git(fx.store, ['log', '-1', '--format=%s']), 'add 5');
  // `validate <id>` — what /merge-to-main runs before merging — names both and exits 1;
  // a clean task passes with 0.
  const v = run(fx, 'validate', ['5']);
  assert.equal(v.status, 1);
  assert.match(v.stdout, /✗ 005-t5\.md — 2 error\(s\)/);
  assert.match(v.stdout, /✗ checkbox "\(deferred\)"[\s\S]*✗ checkbox "\(moved: 999\)"/);
  assert.equal(run(fx, 'validate', ['1']).status, 0);
});

test('an optional box: DONE refuses and points at --enough; --enough closes it as ENOUGH', () => {
  const fx = fixture();
  assert.match(close(fx, '3').stderr, /left behind \(optional\) — a DONE task has nothing left; close with --enough/);
  const r = close(fx, '3', '--enough');
  assert.equal(r.status, 0, r.stderr);
  const fm = readTaskFile(fx.files.leftover).frontmatter;
  assert.equal(fm.status, 'ENOUGH');
  assert.equal(String(fm.done_date), today());
});

test('someone else\'s claim: refuses; --force closes it and says so in the commit', () => {
  const fx = fixture();
  assert.match(close(fx, '4').stderr, /claimed by Someone Else/);
  const r = close(fx, '4', '--force');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readTaskFile(fx.files.theirs).frontmatter.status, 'DONE');
  assert.equal(git(fx.store, ['log', '-1', '--format=%s']), 'close #4 as DONE (--force)');
});

test('an already-closed task is refused even with --force, and the refusal names reopen', () => {
  const fx = fixture();
  close(fx, '1');
  const r = close(fx, '1', '--force');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already DONE\. To undo that close: cogyard tasks reopen 1 --why/);
});

// --- task 228: undoing a close, and the owner's calls ------------------------

test('reopen undoes a wrong ENOUGH close; then --force closes it DONE — no hand edit, every step committed', () => {
  const fx = fixture();
  assert.equal(close(fx, '3', '--enough').status, 0);
  const r = reopen(fx, '3');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /#3 reopened \(was ENOUGH\)/);
  const fm = readTaskFile(fx.files.leftover).frontmatter;
  assert.equal(fm.status, 'OPEN');
  assert.equal(fm.done_date, null);
  assert.equal(git(fx.store, ['log', '-1', '--format=%s']), 'reopen #3 (was ENOUGH)');
  assert.equal(close(fx, '3', '--force').status, 0);
  assert.equal(readTaskFile(fx.files.leftover).frontmatter.status, 'DONE');
  assert.deepEqual(git(fx.store, ['log', '-3', '--format=%s']).split('\n'),
    ['close #3 as DONE (--force)', 'reopen #3 (was ENOUGH)', 'close #3 as ENOUGH']);
  assert.equal(git(fx.store, ['status', '--porcelain']), '');
});

test('reopen refuses a task that is not DONE or ENOUGH, and changes nothing', () => {
  const fx = fixture();
  const before = readFileSync(fx.files.open, 'utf8');
  const r = reopen(fx, '2');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /#2 is OPEN — reopen takes a DONE or ENOUGH task/);
  assert.equal(readFileSync(fx.files.open, 'utf8'), before);
});

test('an agent may not run close --enough or close --force on its own: refused with the owner command, file untouched', () => {
  const fx = fixture();
  const cases = [
    { args: ['close', ['3', '--enough']], file: fx.files.leftover, cmd: 'cogyard tasks close 3 --enough' },
    { args: ['close', ['4', '--force']], file: fx.files.theirs, cmd: 'cogyard tasks close 4 --force' },
  ];
  for (const c of cases) {
    const before = readFileSync(c.file, 'utf8');
    const r = run(fx, ...c.args, { asAgent: true });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /is the owner's call, and this was started by/);
    assert.match(r.stderr, /--asked "<what they typed>"/);
    assert.ok(r.stderr.includes(`cd ${fx.repo} && ${c.cmd}`), r.stderr);
    assert.equal(readFileSync(c.file, 'utf8'), before);
  }
});

// --- task 237: the owner telling the agent counts as the owner running it ------

test('the owner said "close it as enough": the agent\'s --enough --asked goes through, and the commit carries their words', () => {
  const fx = fixture();
  const r = run(fx, 'close', ['3', '--enough', '--asked', 'close it as enough'], { asAgent: true, said: ['ok. close it as enough'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readTaskFile(fx.files.leftover).frontmatter.status, 'ENOUGH');
  assert.equal(git(fx.store, ['log', '-1', '--format=%s']), 'close #3 as ENOUGH — owner said: "close it as enough"');
});

test('the owner said "close it as done": the agent\'s --force --asked goes through', () => {
  const fx = fixture();
  const r = run(fx, 'close', ['4', '--force', '--asked', 'Close it as DONE'], { asAgent: true, said: ['close it as done'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readTaskFile(fx.files.theirs).frontmatter.status, 'DONE');
  assert.equal(git(fx.store, ['log', '-1', '--format=%s']), 'close #4 as DONE (--force) — owner said: "Close it as DONE"');
});

test('words the owner did not type, or that don\'t say the outcome, are refused with the reason — nothing changes', () => {
  const fx = fixture();
  const cases = [
    // invented
    { args: ['3', '--enough', '--asked', 'close 3 as enough'], said: ['close it'], file: fx.files.leftover, why: /not in any message the owner typed/ },
    // a bare "close it" is not "enough"
    { args: ['3', '--enough', '--asked', 'close it'], said: ['close it'], file: fx.files.leftover, why: /must say "close" and "enough"/ },
    // "enough" is not "done": --force needs "done"
    { args: ['4', '--force', '--asked', 'close it as enough'], said: ['close it as enough'], file: fx.files.theirs, why: /must say "close" and "done"/ },
    // "when it's done" is a plain close later
    { args: ['4', '--force', '--asked', "close it when it's done"], said: ["close it when it's done"], file: fx.files.theirs, why: /once the work is done/ },
  ];
  for (const c of cases) {
    const before = readFileSync(c.file, 'utf8');
    const r = run(fx, 'close', c.args, { asAgent: true, said: c.said });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, c.why);
    assert.equal(readFileSync(c.file, 'utf8'), before);
  }
  assert.equal(git(fx.store, ['log', '-1', '--format=%s']), 'seed');
});

test('the agent cannot quote itself — words it wrote, or put in a skill\'s arguments, are not the owner\'s', () => {
  const fx = fixture();
  const before = readFileSync(fx.files.leftover, 'utf8');
  const r = run(fx, 'close', ['3', '--enough', '--asked', 'close it as enough'],
    { asAgent: true, said: ['wrap this up'], agentWrote: ['Base directory for this skill\n\nARGUMENTS: close it as enough'] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not in any message the owner typed/);
  assert.equal(readFileSync(fx.files.leftover, 'utf8'), before);
});

test('the owner\'s own shell needs no --asked, and the commit is as before', () => {
  const fx = fixture();
  assert.equal(close(fx, '3', '--enough').status, 0);
  assert.equal(git(fx.store, ['log', '-1', '--format=%s']), 'close #3 as ENOUGH');
});

test('an agent may reopen a closed task; the commit says why and names the chat', () => {
  const fx = fixture();
  assert.equal(close(fx, '1').status, 0);
  const r = run(fx, 'reopen', ['1', '--why', 'owner: put this back in 1'], { asAgent: true, said: ['this should go back to 1'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readTaskFile(fx.files.done).frontmatter.status, 'OPEN');
  assert.equal(git(fx.store, ['log', '-1', '--format=%s']), `reopen #1 (was DONE) — owner: put this back in 1 [chat ${SID}]`);
});

test('an agent may still run a plain close of a fully settled task (the autopilot path)', () => {
  const fx = fixture();
  const r = run(fx, 'close', ['1'], { asAgent: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readTaskFile(fx.files.done).frontmatter.status, 'DONE');
});

test('a refused close tells an agent to leave the task open and report — never to ask or offer the flags (task 236)', () => {
  const fx = fixture();
  const r = run(fx, 'close', ['2'], { asAgent: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Leave #2 OPEN with its claim and tell the owner what's left\. Don't ask them anything, and don't offer --enough or --force\./);
  assert.doesNotMatch(r.stderr, /closes it as ENOUGH|ask them which/);
});

test('the owner, running a refused close themself, still gets the --enough / --force hints', () => {
  const fx = fixture();
  const r = close(fx, '2');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /`--enough` closes it as ENOUGH \(partly done; the open and \(optional\) boxes are the leftovers you chose to leave\)/);
  assert.match(r.stderr, /`--force` closes it as DONE anyway/);
});

// --- task 232: checks that waited on the merge -------------------------------

test('only (after merge) checks left: the agent is told to run them, offered no owner flags; ticked, its plain close goes through', () => {
  const fx = fixture();
  const withCheck = readFileSync(fx.files.done, 'utf8').replace('- [x] built\n', '- [x] built\n- [ ] (after merge) the card reads idle on main\n');
  writeFileSync(fx.files.done, withCheck);
  git(fx.store, ['commit', '-qam', 'add an after-merge check']);
  const r = run(fx, 'close', ['1'], { asAgent: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1 check\(s\) waiting on the merge — run them[\s\S]*\(after merge\) the card reads idle on main/);
  assert.match(r.stderr, /This is not a question for the owner/);
  assert.doesNotMatch(r.stderr, /--enough|--force|owner's call/);
  assert.equal(readFileSync(fx.files.done, 'utf8'), withCheck);
  writeFileSync(fx.files.done, withCheck.replace('- [ ] (after merge)', '- [x] (after merge)'));
  git(fx.store, ['commit', '-qam', 'ran it']);
  const ok = run(fx, 'close', ['1'], { asAgent: true });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readTaskFile(fx.files.done).frontmatter.status, 'DONE');
});

test('an (after merge) check beside another open box: both listed, and the owner flags still offered', () => {
  const fx = fixture();
  writeFileSync(fx.files.open, readFileSync(fx.files.open, 'utf8').replace('- [ ] still to do', '- [ ] still to do\n- [ ] (after merge) look on main'));
  const r = close(fx, '2');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1 check\(s\) waiting on the merge[\s\S]*1 box\(es\) still open:[\s\S]*still to do/);
  assert.match(r.stderr, /--enough/);
  assert.doesNotMatch(r.stderr, /This is not a question for the owner/);
});

test('close and reopen keep the "> **Status:**" line in the text true; a file without one is untouched', () => {
  const fx = fixture();
  const withLine = readFileSync(fx.files.done, 'utf8').replace('# 1\n', '# 1\n\n> **Status: OPEN.** Built and merged; the rest moved.\n');
  writeFileSync(fx.files.done, withLine);
  git(fx.store, ['commit', '-qam', 'status line']);
  assert.equal(close(fx, '1').status, 0);
  assert.match(readFileSync(fx.files.done, 'utf8'), /^> \*\*Status: DONE\.\*\* Built and merged; the rest moved\.$/m);
  assert.equal(reopen(fx, '1').status, 0);
  assert.match(readFileSync(fx.files.done, 'utf8'), /^> \*\*Status: OPEN\.\*\* Built and merged; the rest moved\.$/m);
  const plainBody = readFileSync(fx.files.leftover, 'utf8').split('\n---\n')[1];
  assert.equal(close(fx, '3', '--enough').status, 0);
  assert.equal(readFileSync(fx.files.leftover, 'utf8').split('\n---\n')[1], plainBody);
});

test('close clears the id reservation next-id left in claims.json, and keeps the rest of the record', () => {
  const fx = fixture();
  const claims = join(fx.home, 'claims.json');
  const key = `${fx.store}#1`;
  writeFileSync(claims, JSON.stringify({ [key]: { reservedBy: 'chat-that-filed-it', reservedAt: '2026-10-01T00:00:00.000Z', worktree: 'task-1' } }));
  assert.equal(close(fx, '1').status, 0);
  const rec = JSON.parse(readFileSync(claims, 'utf8'))[key];
  assert.equal(rec.reservedBy, undefined);
  assert.equal(rec.reservedAt, undefined);
  assert.equal(rec.worktree, 'task-1');
});
