// Tests for the SessionStart hook's env_files wiring (tasks 143, 211).
//
// Every env_files entry becomes a LINK in the worktree to the project root's
// file — there is no copy option (task 211): a copy is one more place a secret
// drifts, and writing one (temp file + rename) silently replaced a link the
// owner had put at the target. A config still naming `copy` or `merge` is
// refused. The ports never go into an env file (task 143); they reach
// launch.json and the briefing. Runs the real hook against throwaway projects
// with their own COGYARD_HOME, so no real allocation is touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync,
  lstatSync, readlinkSync, symlinkSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'worktree-session.mjs');

let ROOT, BIN;

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-hook-env-')));
  // A no-op osascript ahead of the real one, so the run pops no notification.
  BIN = join(ROOT, 'bin');
  mkdirSync(BIN);
  writeFileSync(join(BIN, 'osascript'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(BIN, 'osascript'), 0o755);
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

// One throwaway project + worktree + COGYARD_HOME per case; returns the paths
// and the hook's stdout.
//
// `how` picks the way the hook is told its folder. Default: the path as an
// argument, as `cogyard hook session-start .` does. `{ automatic: true }` runs it
// the way Claude Code's automatic SessionStart run does — no argument,
// $CLAUDE_PROJECT_DIR set to `projectDir` (default: the main checkout, as the
// desktop app sets it, task 233), and the hook's JSON on stdin with `cwd` set to
// `cwd` (a function of the paths) — or `stdin` given raw.
function runHook(name, envFiles, setup = () => {}, how = {}) {
  const project = join(ROOT, name);
  const wt = join(project, '.claude', 'worktrees', 'task-1-alpha');
  const home = join(ROOT, `${name}-home`);
  mkdirSync(wt, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, '.cogyard'), { recursive: true });
  writeFileSync(join(project, '.cogyard', 'worktree.json'), JSON.stringify({
    project_name: name,
    dev_script: 'npm run dev',
    env_files: envFiles,
    port_vars: { PORT: 'backend', FRONTEND_PORT: 'frontend' },
    preview_port_var: 'FRONTEND_PORT',
  }));
  writeFileSync(join(project, '.env.development'), 'SHARED_FLAG=1\n');
  setup({ project, wt, home });
  const paths = { project, wt, home };
  const env = { ...process.env, COGYARD_HOME: home, COGYARD_DRIVER: 'claude', PATH: `${BIN}:${process.env.PATH}` };
  delete env.CLAUDE_PROJECT_DIR;
  let args = [HOOK, wt];
  if (how.automatic) {
    args = [HOOK];
    env.CLAUDE_PROJECT_DIR = how.projectDir ? how.projectDir(paths) : project;
  }
  const input = how.stdin ?? (how.cwd ? JSON.stringify({
    session_id: 'test-session', cwd: how.cwd(paths), hook_event_name: 'SessionStart', source: 'startup',
  }) : '');
  const briefing = execFileSync('node', args, { env, input, encoding: 'utf8' });
  return { ...paths, briefing };
}

const allocation = (briefing) => {
  const m = briefing.match(/backend\s+port = (\d+)\s+frontend port = (\d+)/);
  assert.ok(m, `briefing names no ports:\n${briefing}`);
  return { backend: Number(m[1]), frontend: Number(m[2]) };
};

test('an env_files entry becomes a link to the project root file, not a copy', () => {
  const { project, wt } = runHook('linked', [{ source: '.env.development', target: '.env.development' }]);
  const target = join(wt, '.env.development');
  assert.ok(lstatSync(target).isSymbolicLink(), 'the worktree gets a link');
  assert.equal(readlinkSync(target), join(project, '.env.development'));
  assert.doesNotMatch(readFileSync(target, 'utf8'), /^\s*(PORT|FRONTEND_PORT)=/m, 'no port is written');
});

test('"strategy": "symlink" is still accepted and means the same', () => {
  const { project, wt } = runHook('explicit', [{ source: '.env.development', target: '.env.development', strategy: 'symlink' }]);
  assert.equal(readlinkSync(join(wt, '.env.development')), join(project, '.env.development'));
});

test('a link already at the target is relinked, never replaced by a real file', () => {
  const { project, wt } = runHook('prelinked', [{ source: '.env.development', target: '.env.development' }], ({ wt: w }) => {
    // The owner's own link, e.g. to a secrets folder outside the repo.
    const elsewhere = join(ROOT, 'elsewhere.env');
    writeFileSync(elsewhere, 'SHARED_FLAG=1\n');
    symlinkSync(elsewhere, join(w, '.env.development'));
  });
  const target = join(wt, '.env.development');
  assert.ok(lstatSync(target).isSymbolicLink(), 'still a link after the hook ran');
  assert.equal(readlinkSync(target), join(project, '.env.development'));
});

for (const strategy of ['copy', 'merge']) {
  test(`a config naming strategy "${strategy}" is refused and writes nothing at the target`, () => {
    const { wt, home, briefing } = runHook(`refused-${strategy}`, [{ source: '.env.development', target: '.env.development', strategy }]);
    assert.equal(existsSync(join(wt, '.env.development')), false, 'no file is written');
    assert.doesNotMatch(briefing, /Worktree dev environment/, 'the hook does not report the worktree as wired');
    const log = readFileSync(join(home, 'logs', 'worktree-hook.log'), 'utf8');
    assert.match(log, new RegExp(`strategy '${strategy}' is no longer supported`));
    assert.match(log, /Delete "strategy"/, 'the failure names the fix');
  });
}

test('the ports still reach launch.json', () => {
  const { project, briefing } = runHook('ports', [{ source: '.env.development', target: '.env.development' }]);
  const launch = JSON.parse(readFileSync(join(project, '.claude', 'launch.json'), 'utf8'));
  const entry = launch.configurations.find((c) => c.name === 'wt-task-1-alpha');
  assert.ok(entry, 'the worktree entry is registered');
  assert.equal(entry.port, allocation(briefing).frontend);
});

// Task 230: the preview tool reads only the chat's current folder's file, so a
// chat inside the worktree needs the worktree's own — and it must hold ONLY this
// worktree's entry, replacing the copy of the main checkout's file the app drops
// into a worktree it creates.
test('the worktree gets its own launch.json holding only its entry, replacing the app\'s copy', () => {
  const { wt, briefing } = runHook('own-file', [], ({ project, wt: w }) => {
    const appCopy = JSON.stringify({ version: '0.0.1', configurations: [
      { name: 'api', runtimeExecutable: 'npm', runtimeArgs: ['run', 'api'], port: 7440 },
    ] });
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude', 'launch.json'), appCopy);
    mkdirSync(join(w, '.claude'), { recursive: true });
    writeFileSync(join(w, '.claude', 'launch.json'), appCopy);
  });
  const own = JSON.parse(readFileSync(join(wt, '.claude', 'launch.json'), 'utf8'));
  assert.deepEqual(own.configurations.map((c) => c.name), ['wt-task-1-alpha']);
  assert.equal(own.configurations[0].port, allocation(briefing).frontend);
  assert.equal(own.configurations[0].cogyardWorktree, wt);
  assert.ok(briefing.includes(`${wt}/.claude/launch.json`), 'the briefing names the worktree\'s file');
  assert.doesNotMatch(briefing, /resolves it from the main checkout/, 'the August rule is gone from the briefing');
});

// Task 233: a chat the desktop app starts inside its own worktree runs the
// automatic hook with $CLAUDE_PROJECT_DIR = the main checkout (probed
// 2026-11-09, desktop 4.23118.1). Only the `cwd` in the hook's stdin JSON names
// the worktree.
const ENV_FILE = [{ source: '.env.development', target: '.env.development' }];
const isWired = ({ project, wt, briefing }) => {
  assert.match(briefing, /=== Worktree dev environment ===/, 'the briefing is printed');
  assert.ok(briefing.includes(`Worktree path : ${wt}\n`), `the briefing names the worktree:\n${briefing}`);
  allocation(briefing);
  assert.equal(readlinkSync(join(wt, '.env.development')), join(project, '.env.development'));
  const own = JSON.parse(readFileSync(join(wt, '.claude', 'launch.json'), 'utf8'));
  assert.deepEqual(own.configurations.map((c) => c.name), ['wt-task-1-alpha']);
};

test('automatic run in an app-started worktree chat: wired from the stdin cwd, though $CLAUDE_PROJECT_DIR is the main checkout', () => {
  isWired(runHook('app-started', ENV_FILE, undefined, { automatic: true, cwd: ({ wt }) => wt }));
});

test('automatic run whose stdin cwd is a folder inside the worktree wires the worktree itself', () => {
  isWired(runHook('app-started-subdir', ENV_FILE, ({ wt }) => mkdirSync(join(wt, 'frontend')), {
    automatic: true, cwd: ({ wt }) => join(wt, 'frontend'),
  }));
});

test('automatic run in a plain main-checkout chat prints nothing and writes nothing', () => {
  const { project, wt, home, briefing } = runHook('main-chat', ENV_FILE, undefined, { automatic: true, cwd: ({ project: p }) => p });
  assert.equal(briefing, '', 'no output at all');
  assert.equal(existsSync(join(wt, '.env.development')), false, 'nothing wired in the worktree');
  assert.equal(existsSync(join(project, '.claude', 'launch.json')), false, 'no launch entry');
  assert.equal(existsSync(join(home, 'ports.json')), false, 'no ports reserved');
});

test('automatic run with no stdin still uses $CLAUDE_PROJECT_DIR, as before', () => {
  isWired(runHook('no-stdin', ENV_FILE, undefined, { automatic: true, projectDir: ({ wt }) => wt }));
});

test('automatic run with unreadable stdin falls back to $CLAUDE_PROJECT_DIR', () => {
  isWired(runHook('bad-stdin', ENV_FILE, undefined, { automatic: true, stdin: 'not json{', projectDir: ({ wt }) => wt }));
});

test('automatic run whose stdin cwd is not a worktree keeps $CLAUDE_PROJECT_DIR when that one is', () => {
  isWired(runHook('cwd-elsewhere', ENV_FILE, undefined, {
    automatic: true, cwd: ({ project }) => project, projectDir: ({ wt }) => wt,
  }));
});

test('a path given by hand wins over the stdin cwd', () => {
  // stdin names a different worktree of the same project; the argument must win.
  isWired(runHook('explicit-wins', ENV_FILE, ({ project }) => mkdirSync(join(project, '.claude', 'worktrees', 'task-2-beta')), {
    cwd: ({ project }) => join(project, '.claude', 'worktrees', 'task-2-beta'),
  }));
});

test('the briefing names `cogyard env ports`, not .env.worktree, as where ports come from', () => {
  const { briefing } = runHook('briefing', [{ source: '.env.development', target: '.env.development' }]);
  allocation(briefing);
  assert.match(briefing, /cogyard env ports/);
  assert.doesNotMatch(briefing, /they come from \.env\.worktree/);
});
