// Tests for the Claude driver's PreToolUse worktree guard
// (drivers/claude/hooks/pretooluse-guard-worktree.mjs).
//
// Integration-style, like guard-branch-switch.test.mjs: a real throwaway repo
// with a real linked worktree, and the hook run as the separate process it
// actually is, fed real PreToolUse JSON on stdin.
//
// Both halves matter. Refusing a hand-made new-branch worktree is the point;
// ALLOWING the one task-worktree shape (cut from another task's unmerged
// branch) and a plain re-attach is what keeps building on an unmerged task and
// the pickup continuation working.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'drivers', 'claude', 'hooks', 'pretooluse-guard-worktree.mjs');

let ROOT, MAIN, LINKED, APP_WT;

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

function decide(toolName, toolInput, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'the guard must always exit 0 — it decides via stdout, never by failing');
  const out = (r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: null };
  const parsed = JSON.parse(out);
  return {
    decision: parsed.hookSpecificOutput.permissionDecision,
    reason: parsed.hookSpecificOutput.permissionDecisionReason,
  };
}

const bash = (command, cwd) => decide('Bash', { command }, cwd);
const denies = (cmd, cwd) => assert.equal(bash(cmd, cwd).decision, 'deny', `expected DENY: ${cmd}`);
const allows = (cmd, cwd) => assert.equal(bash(cmd, cwd).decision, 'allow', `expected ALLOW: ${cmd}`);

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cy-wt-guard-')));
  MAIN = join(ROOT, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', MAIN]);
  execFileSync('git', ['-C', MAIN, '-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'init']);
  mkdirSync(join(MAIN, '.claude', 'worktrees'), { recursive: true });

  // A worktree the app would make (branch worktree-<name>) and one on a plain branch.
  git(MAIN, 'branch', 'worktree-task-7-app');
  APP_WT = join(MAIN, '.claude', 'worktrees', 'task-7-app');
  git(MAIN, 'worktree', 'add', '-q', APP_WT, 'worktree-task-7-app');
  git(MAIN, 'branch', 'feature');
  LINKED = join(ROOT, 'linked');
  git(MAIN, 'worktree', 'add', '-q', LINKED, 'feature');
});

after(() => { rmSync(ROOT, { recursive: true, force: true }); });

// A task worktree cut from another task's unmerged branch — the one -b shape allowed.
const ON_OTHER_TASK = 'git worktree add .claude/worktrees/task-12-x -b worktree-task-12-x worktree-task-7-app';

// --- the acceptance table ------------------------------------------------------

test('denies the incident\'s hand-made new-branch worktree', () => {
  denies('git worktree add -b task-12-x .claude/worktrees/task-12-x main', MAIN);
});

test('allows a task worktree cut from another task\'s branch, from the main checkout', () => {
  allows(ON_OTHER_TASK, MAIN);
});

test('the allowed shape takes any base', () => {
  allows('git worktree add .claude/worktrees/task-12-x -b worktree-task-12-x main', MAIN);
});

test('denies that shape from inside a linked worktree', () => {
  denies(ON_OTHER_TASK, LINKED);
  denies(ON_OTHER_TASK, APP_WT);
  denies(`git -C ${MAIN} worktree add ${MAIN}/.claude/worktrees/task-12-x -b worktree-task-12-x worktree-task-7-app`, LINKED);
});

test('denies when the path and branch names differ', () => {
  denies('git worktree add .claude/worktrees/task-12-x -b worktree-task-13-y main', MAIN);
});

test('denies -B anywhere', () => {
  denies(`git -C ${MAIN} worktree add -B foo ${MAIN}/.claude/worktrees/foo`, MAIN);
});

test('allows re-attaching a branch that already exists', () => {
  allows(`git -C ${MAIN} worktree add ${MAIN}/.claude/worktrees/task-1-foo task-1-foo`, MAIN);
  allows(`git -C ${MAIN} worktree add ${MAIN}/.claude/worktrees/task-1-foo task-1-foo`, LINKED);
});

test('ignores the words inside a quoted string', () => {
  allows('git commit -m "git worktree add -b x"', MAIN);
});

test('ExitWorktree remove asks; keep is allowed', () => {
  assert.equal(decide('ExitWorktree', { action: 'remove' }, APP_WT).decision, 'ask');
  assert.equal(decide('ExitWorktree', { action: 'keep' }, APP_WT).decision, 'allow');
});

test('EnterWorktree path= allows an app worktree and asks for anything else', () => {
  assert.equal(decide('EnterWorktree', { path: APP_WT }, MAIN).decision, 'allow');
  assert.equal(decide('EnterWorktree', { path: MAIN }, MAIN).decision, 'ask');
  assert.equal(decide('EnterWorktree', { path: LINKED }, MAIN).decision, 'ask');
});

// --- the edges -----------------------------------------------------------------

test('the allowed shape holds for suffixed and dotted task ids', () => {
  allows('git worktree add .claude/worktrees/task-028b-x -b worktree-task-028b-x main', MAIN);
  allows('git worktree add .claude/worktrees/task-013.5-x -b worktree-task-013.5-x main', MAIN);
  allows(`git worktree add ${MAIN}/.claude/worktrees/task-9-x -b worktree-task-9-x main`, MAIN);
});

test('denies the allowed names outside .claude/worktrees, or not task-named', () => {
  denies('git worktree add ../task-12-x -b worktree-task-12-x main', MAIN);
  denies('git worktree add .claude/worktrees/scratch -b worktree-scratch main', MAIN);
});

test('denies --orphan and a glued -b', () => {
  denies('git worktree add --orphan -b worktree-task-12-x .claude/worktrees/task-12-x', MAIN);
  denies('git worktree add -btask-12-x .claude/worktrees/task-12-x main', MAIN);
});

test('follows cd: git that ends up inside a linked worktree is denied', () => {
  denies(`cd ${LINKED} && ${ON_OTHER_TASK}`, MAIN);
});

test('the deny says which shape is allowed and why this is not it', () => {
  const { reason } = bash('git worktree add -b task-12-x .claude/worktrees/task-12-x main', MAIN);
  assert.match(reason, /worktree-task-<id>-<slug>/);
  assert.match(reason, /not that shape/);
});

test('EnterWorktree name= and other tools pass untouched', () => {
  assert.equal(decide('EnterWorktree', { name: 'task-1-foo' }, MAIN).decision, 'allow');
  assert.equal(decide('Edit', { file_path: '/tmp/x' }, MAIN).decision, 'allow');
  allows('git worktree list', MAIN);
});
