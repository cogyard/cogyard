// Tests for the PreToolUse task-store git guard (hooks/pretooluse-guard-task-store.mjs,
// task 228).
//
// Integration-style, like guard-branch-switch.test.mjs: a real throwaway project
// whose `.cogyard/tasks` link points at a real store repo, a real registry under
// a temp COGYARD_HOME, and the hook run as its own process on real PreToolUse
// JSON. The incident it answers: an agent ran `git revert` twice inside a task
// store to undo a close. Denying that is the point; allowing every read, and
// every write OUTSIDE a store, is what keeps the guard from being ripped out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'pretooluse-guard-task-store.mjs');

let ROOT, HOME, PROJECT, STORE, LOOSE;

function repo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return realpathSync(dir);
}

function decide(command, cwd, toolName = 'Bash') {
  const payload = toolName === 'Bash'
    ? { tool_name: 'Bash', tool_input: { command }, cwd }
    : { tool_name: toolName, tool_input: { file_path: '/tmp/x' }, cwd };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME } });
  assert.equal(r.status, 0, 'the guard must always exit 0 — it decides via stdout, never by failing');
  const out = (r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: null };
  const j = JSON.parse(out);
  return { decision: j.hookSpecificOutput.permissionDecision, reason: j.hookSpecificOutput.permissionDecisionReason };
}
const denies = (cmd, cwd) => assert.equal(decide(cmd, cwd).decision, 'deny', `expected DENY: ${cmd} (cwd ${cwd})`);
const allows = (cmd, cwd) => assert.equal(decide(cmd, cwd).decision, 'allow', `expected ALLOW: ${cmd} (cwd ${cwd})`);

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cy-store-guard-')));
  HOME = join(ROOT, 'home');
  mkdirSync(HOME, { recursive: true });
  STORE = repo(join(ROOT, '_tasks', 'proj'));
  mkdirSync(join(STORE, 'files', '7'), { recursive: true });
  PROJECT = repo(join(ROOT, 'proj'));
  mkdirSync(join(PROJECT, '.cogyard'));
  symlinkSync(STORE, join(PROJECT, '.cogyard', 'tasks'));
  LOOSE = repo(join(ROOT, 'loose'));     // a repo no project's link points at
  writeFileSync(join(HOME, 'projects.json'), JSON.stringify([{ slug: 'proj', path: PROJECT, label: 'proj' }]));
});

after(() => { rmSync(ROOT, { recursive: true, force: true }); });

test('denies the incident: git revert inside a store, reached by -C', () => {
  denies(`git -C ${STORE} revert --no-edit HEAD`, PROJECT);
});

test('denies every kind of write: commit, reset, rebase, checkout, restore, stash, merge, cherry-pick, rm, add, push, pull', () => {
  for (const c of ['commit -am x', 'reset --hard HEAD~1', 'rebase main', 'checkout -- a.md', 'restore a.md', 'stash',
    'stash push -m x', 'merge other', 'cherry-pick abc', 'rm a.md', 'add a.md', 'push', 'pull', 'commit --amend']) {
    denies(`git -C ${STORE} ${c}`, PROJECT);
  }
});

test('denies creating or deleting a branch or tag in a store', () => {
  denies(`git -C ${STORE} branch side`, PROJECT);
  denies(`git -C ${STORE} branch -D side`, PROJECT);
  denies(`git -C ${STORE} tag v1`, PROJECT);
  denies(`git -C ${STORE} tag -d v1`, PROJECT);
});

test('denies a write from a cwd inside the store, or inside one of its folders', () => {
  denies('git commit -am x', STORE);
  denies('git revert HEAD', join(STORE, 'files', '7'));
});

test('denies a write reached through a cd earlier in the command', () => {
  denies(`cd ${STORE} && git revert --no-edit HEAD`, PROJECT);
  denies(`cd ${ROOT}/_tasks && cd proj && git commit -am x`, PROJECT);
});

test('denies a write through the project\'s own task link', () => {
  denies(`git -C ${PROJECT}/.cogyard/tasks commit -am x`, PROJECT);
  denies('git -C .cogyard/tasks revert HEAD', PROJECT);
});

test('ALLOWS reading a store with git', () => {
  for (const c of ['log --oneline -5', 'show HEAD', 'status --short', 'diff', 'blame a.md', 'branch', 'branch --show-current',
    'branch --list', 'stash list', 'config --get user.name', 'worktree list', 'rev-parse HEAD', 'reflog', 'fetch', 'tag', 'tag -l']) {
    allows(`git -C ${STORE} ${c}`, PROJECT);
  }
  allows(`cd ${STORE} && git log -1 | head -1`, PROJECT);
});

test('ALLOWS writes outside any store: the project repo itself and an unrelated repo', () => {
  allows('git commit -am x', PROJECT);
  allows(`git -C ${LOOSE} revert HEAD`, PROJECT);
  allows(`cd ${PROJECT} && git commit -am x`, STORE);
});

test('ALLOWS --help on a write subcommand', () => {
  allows(`git -C ${STORE} revert --help`, PROJECT);
});

test('ignores non-Bash tools and commands with no git in them', () => {
  assert.equal(decide('', STORE, 'Edit').decision, 'allow');
  allows('ls -la', STORE);
});

test('fails open on junk input and unbalanced quotes', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME } });
  assert.equal(r.status, 0);
  assert.equal((r.stdout || '').trim(), '');
  allows(`git -C ${STORE} commit -m "unbalanced`, PROJECT);
});

test('the refusal names the store, the command, and the cogyard way to do it', () => {
  const r = decide(`git -C ${STORE} revert --no-edit 77bbff0`, PROJECT);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /`git revert --no-edit 77bbff0` would change the task store at/);
  assert.ok(r.reason.includes(STORE));
  assert.match(r.reason, /cogyard tasks sync push/);
  assert.match(r.reason, /cogyard tasks reopen <id>/);
  assert.match(r.reason, /log, show, status, diff, blame\) is always allowed/);
});

// --- task 197: git add on the project's task link -------------------------------
// The link is a gitignored symlink, so `git add` through it adds nothing; the
// guard says so and names `sync push`. Moved here from the owner's personal guard.

test('denies git add naming the task link, or a path through it, when the link is a symlink', () => {
  for (const c of ['git add .cogyard/tasks', 'git add .cogyard/tasks/', 'git add .cogyard/tasks/007-x.md', 'git add -f .cogyard/tasks',
    'git add src/a.js .cogyard/tasks/007-x.md', `git -C ${PROJECT} add .cogyard/tasks`, 'git add "./.cogyard/tasks/007-x.md"']) {
    denies(c, PROJECT);
  }
  denies(`cd ${PROJECT} && git add .cogyard/tasks`, LOOSE);
});

test('the git-add refusal says why and names sync push', () => {
  const r = decide('git add .cogyard/tasks', PROJECT);
  assert.match(r.reason, /Task-link guard/);
  assert.match(r.reason, /gitignored symlink/);
  assert.match(r.reason, /cogyard tasks sync push "<message>" -- <file>/);
});

test('ALLOWS other git adds, a repo whose task link is a real folder, and text that only mentions the link', () => {
  allows('git add src/a.js', PROJECT);
  allows('git add -A', PROJECT);
  allows('git add .cogyard/worktree.json', PROJECT);
  const plain = repo(join(ROOT, 'plain-folder'));
  mkdirSync(join(plain, '.cogyard', 'tasks'), { recursive: true });
  allows('git add .cogyard/tasks', plain);
  allows('git commit -m "never git add .cogyard/tasks"', PROJECT);
  allows('echo "git add .cogyard/tasks"', PROJECT);
});
