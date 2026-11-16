// Tests for the PreToolUse branch-switch guard (hooks/pretooluse-guard-branch-switch.mjs).
//
// Integration-style, like default-branch.test.mjs: real throwaway git repos in a
// temp dir, a real registry under a temp COGYARD_HOME, and the hook run as the
// separate process it actually is, fed real PreToolUse JSON on stdin. Nothing is
// mocked, because every interesting decision the guard makes is a question it
// asks git or the registry.
//
// The two halves matter equally. Denying the switch is the point; ALLOWING the
// merge sequence's own `git checkout <base>`, file restores, and every linked
// worktree is what keeps the guard from being ripped out a week later.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'pretooluse-guard-branch-switch.mjs');

let ROOT, HOME, REGISTERED, UNREGISTERED, LINKED;

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

function repo(name) {
  const dir = join(ROOT, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'init']);
  git(dir, 'branch', 'feature');
  return realpathSync(dir);
}

// Run the hook exactly as Claude Code does: JSON in, decision out.
function decide(command, cwd, toolName = 'Bash') {
  const payload = toolName === 'Bash'
    ? { tool_name: 'Bash', tool_input: { command }, cwd }
    : { tool_name: toolName, tool_input: { file_path: '/tmp/x' }, cwd };
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, COGYARD_HOME: HOME },
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

const denies = (cmd, cwd) => assert.equal(decide(cmd, cwd).decision, 'deny', `expected DENY: ${cmd}`);
const allows = (cmd, cwd) => assert.equal(decide(cmd, cwd).decision, 'allow', `expected ALLOW: ${cmd}`);

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cy-guard-')));
  HOME = join(ROOT, 'home');
  mkdirSync(HOME, { recursive: true });

  REGISTERED = repo('registered');
  UNREGISTERED = repo('unregistered');

  // A linked worktree of the registered repo — the shape the guard must leave alone.
  LINKED = join(ROOT, 'linked-wt');
  git(REGISTERED, 'worktree', 'add', '-q', LINKED, 'feature');
  LINKED = realpathSync(LINKED);

  writeFileSync(join(HOME, 'projects.json'), JSON.stringify([
    { slug: 'registered', path: REGISTERED, label: 'registered' },
  ]));
});

after(() => { rmSync(ROOT, { recursive: true, force: true }); });

test('denies a switch to another branch in the main working tree', () => {
  denies('git checkout feature', REGISTERED);
  denies('git switch feature', REGISTERED);
});

test('denies create-and-switch — the shape that caused the wrong-branch merge', () => {
  denies('git checkout -b sessionB-feature', REGISTERED);
  denies('git switch -c sessionB-feature', REGISTERED);
  denies('git checkout -B sessionB-feature', REGISTERED);
});

test('denies detaching HEAD and switching to a raw ref', () => {
  denies('git checkout --detach', REGISTERED);
  denies('git switch --detach', REGISTERED);
  denies('git checkout feature^', REGISTERED);
});

test('denies `-`, which is a ref and not an option', () => {
  denies('git checkout -', REGISTERED);
  denies('git switch -', REGISTERED);
});

test('denies a switch reached via -C from outside', () => {
  denies(`git -C ${REGISTERED} checkout feature`, ROOT);
  denies(`git -C ${REGISTERED} switch -c another`, ROOT);
});

test('ALLOWS returning to the default branch — the merge sequence re-asserts it every run', () => {
  allows('git checkout main', REGISTERED);
  allows('git switch main', REGISTERED);
  allows(`git -C ${REGISTERED} checkout main`, ROOT);
});

test('ALLOWS file restores, which do not move HEAD', () => {
  allows('git checkout -- README.md', REGISTERED);
  allows('git checkout feature -- README.md', REGISTERED);
  allows('git checkout -p', REGISTERED);
});

test('ALLOWS every other git command', () => {
  allows('git merge feature', REGISTERED);
  allows('git branch --show-current', REGISTERED);
  allows('git status', REGISTERED);
  allows(`git -C ${REGISTERED} worktree add /tmp/whatever feature`, REGISTERED);
});

test('ALLOWS linked worktrees — each already has its own HEAD', () => {
  allows('git checkout -b anything', LINKED);
  allows('git switch main', LINKED);
  allows(`git -C ${LINKED} checkout -b anything`, REGISTERED);
});

test('ALLOWS unregistered repos — an unrelated clone is none of its business', () => {
  allows('git checkout -b anything', UNREGISTERED);
  allows('git checkout feature', UNREGISTERED);
});

test('stands down when the command cds first — better silent than wrongly refusing', () => {
  allows(`cd /tmp && git checkout -b anything`, REGISTERED);
});

test('ignores non-Bash tools', () => {
  assert.equal(decide(null, REGISTERED, 'Edit').decision, 'allow');
});

test('fails open on junk input rather than blocking the shell', () => {
  for (const junk of ['', 'not json', '{"tool_name":"Bash"}', '{"tool_name":"Bash","tool_input":{}}']) {
    const r = spawnSync(process.execPath, [HOOK], { input: junk, encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME } });
    assert.equal(r.status, 0);
    assert.equal((r.stdout || '').trim(), '', `junk input must allow: ${junk}`);
  }
});

test('the refusal says where, what, and how to proceed', () => {
  const { reason } = decide('git checkout -b sessionB-feature', REGISTERED);
  assert.match(reason, /permanent home of `main`/);
  assert.match(reason, /sessionB-feature/);
  assert.match(reason, /worktree add/);
  assert.match(reason, /git checkout main` is always allowed/);
});
