// Tests for the behind-main note at the top of the SessionStart hook's briefing
// (task 142). A worktree is frozen at spawn time while main keeps moving; the
// hook counts the commits on the LOCAL base branch (main, else master) that the
// worktree lacks and prints that count first, in both the reserved-only and the
// full-wiring briefing. Up to date prints one line; a git failure prints nothing
// and the briefing still comes out.
//
// Integration-style: throwaway git repos with a real linked worktree under
// .claude/worktrees/, the hook run as a child the way the skill runs it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'worktree-session.mjs');

let ROOT, HOME, BIN;

const GIT_ENV = { GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'a@b.c' };
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

// A project repo on `base` with one linked worktree, `.claude/worktrees/<name>`.
// `config` true = a committed-style .cogyard/worktree.json (full wiring, no dev
// server so nothing else is written); false = the reserved-only path.
function project(name, { base = 'main', config = true } = {}) {
  const repo = join(ROOT, name);
  execFileSync('git', ['init', '-q', '-b', base, repo]);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'm1']);
  if (config) {
    mkdirSync(join(repo, '.cogyard'), { recursive: true });
    writeFileSync(join(repo, '.cogyard', 'worktree.json'), JSON.stringify({
      project_name: name,
      port_vars: { PORT: 'backend', FRONTEND_PORT: 'frontend' },
    }));
  }
  const wt = join(repo, '.claude', 'worktrees', `task-1-${name}`);
  git(repo, ['worktree', 'add', '-q', '-b', `wt-${name}`, wt]);
  return { repo, wt };
}

const advance = (repo, n) => { for (let i = 0; i < n; i++) git(repo, ['commit', '-q', '--allow-empty', '-m', `ahead ${i}`]); };

const hook = (wt) => execFileSync('node', [HOOK, wt], {
  env: { ...process.env, COGYARD_HOME: HOME, COGYARD_DRIVER: 'claude', PATH: `${BIN}:${process.env.PATH}` },
  encoding: 'utf8',
});

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-hook-behind-')));
  HOME = join(ROOT, 'cogyard-home');
  // The hook starts cli/driver-logo.mjs detached on every run, even outside a
  // worktree, and it downloads the logo into $COGYARD_HOME/drivers/claude/
  // after the hook has returned — which raced the cleanup below (ENOTEMPTY).
  // With a logo already there it only checks and exits: no write, no network.
  mkdirSync(join(HOME, 'drivers', 'claude'), { recursive: true });
  writeFileSync(join(HOME, 'drivers', 'claude', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  BIN = join(ROOT, 'bin');
  mkdirSync(BIN);
  writeFileSync(join(BIN, 'osascript'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(BIN, 'osascript'), 0o755);
});

// The last hook run's logo child may still be starting; give it time to see the
// logo and exit before the folder goes, then retry anything it raced.
after(async () => {
  if (!ROOT) return;
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('an up-to-date worktree opens with one "up to date" line, then the briefing', () => {
  const { wt } = project('fresh');
  const out = hook(wt);
  const lines = out.split('\n');
  assert.equal(lines[0], 'Worktree vs main: up to date.');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '=== Worktree dev environment ===');
  assert.doesNotMatch(out, /BEHIND/);
});

test('a worktree behind main opens with the count and the owner\'s wording, before the full briefing', () => {
  const { repo, wt } = project('stale');
  advance(repo, 3);
  const out = hook(wt);
  assert.ok(out.startsWith(`=== WORKTREE IS 3 COMMITS BEHIND MAIN ===
Never merge main into this worktree.
- Resuming a task that already owns this worktree: pickup-task rebases
  it onto main as the project's rebase switch says.
- Anything else: report this count and stop until the user picks a
  remedy, usually \`git rebase main\` (or pushing main first, when the
  missing commits were never pushed).

=== Worktree dev environment ===
`), out.slice(0, 600));
});

test('the reserved-only briefing carries the note too, with master as the base', () => {
  const { repo, wt } = project('legacy', { base: 'master', config: false });
  advance(repo, 1);
  const out = hook(wt);
  const lines = out.split('\n');
  assert.equal(lines[0], '=== WORKTREE IS 1 COMMIT BEHIND MASTER ===');
  assert.equal(lines[1], 'Never merge master into this worktree.');
  assert.match(out, /`git rebase master`/);
  assert.match(out, /\n\n=== Worktree ports \(reserved\) ===\n/);
});

test('a worktree folder git cannot read prints no note, and the briefing still comes out', () => {
  const wt = join(ROOT, 'not-git', '.claude', 'worktrees', 'task-1-plain');
  mkdirSync(wt, { recursive: true });
  const out = hook(wt);
  assert.ok(out.startsWith('=== Worktree ports (reserved) ==='), out.slice(0, 200));
  assert.doesNotMatch(out, /up to date|BEHIND/);
});

test('outside a worktree the explicit form still says nothing was wired, with no note', () => {
  const { repo } = project('outside');
  advance(repo, 2);
  const out = hook(repo);
  assert.ok(out.startsWith('cogyard: nothing to wire'), out.slice(0, 200));
  assert.doesNotMatch(out, /up to date|BEHIND/);
});
