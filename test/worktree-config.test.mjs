// Tests for where a project's worktree config is read from (task 159).
//
// It lives at .cogyard/worktree.json. The old .claude/worktree-config.json is no
// longer read anywhere (task 183 removed that fallback): a project with only the
// old file is treated as having no config. The resolver is tested directly,
// then through the two readers that act on it end to end: the SessionStart hook
// and `cogyard env ports`. Each runs against a throwaway
// project with its own COGYARD_HOME, so no real allocation is touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorktreeConfig } from '../core/worktree-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', 'hooks', 'worktree-session.mjs');
const ENV_CLI = join(HERE, '..', 'cli', 'env.mjs');
const COGYARD_CLI = join(HERE, '..', 'cli', 'cogyard.mjs');

let ROOT, HOME, BIN;

const NEW = ['.cogyard', 'worktree.json'];
const OLD = ['.claude', 'worktree-config.json'];

function writeConfigAt(project, parts, portVars = { PORT: 'backend', FRONTEND_PORT: 'frontend' }) {
  mkdirSync(join(project, parts[0]), { recursive: true });
  writeFileSync(join(project, ...parts), JSON.stringify({
    project_name: 'demo',
    dev_script: 'npm run dev',
    port_vars: portVars,
    preview_port_var: 'FRONTEND_PORT',
  }));
}

// A git repo with one linked worktree under the Claude layout, so both the hook
// (which keys on that layout) and `env ports` (which keys on git) see a worktree.
function makeProject(name) {
  const project = join(ROOT, name);
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  execFileSync('git', ['-C', project, '-c', 'user.email=a@b.c', '-c', 'user.name=x',
    'commit', '-q', '--allow-empty', '-m', 'init']);
  const wt = join(project, '.claude', 'worktrees', 'task-1-alpha');
  mkdirSync(dirname(wt), { recursive: true });
  execFileSync('git', ['-C', project, 'worktree', 'add', '-q', '-b', 'wtb', wt]);
  return { project, wt };
}

function runHook(wt) {
  return execFileSync('node', [HOOK, wt], {
    env: { ...process.env, COGYARD_HOME: HOME, COGYARD_DRIVER: 'claude', PATH: `${BIN}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

function envPorts(cwd) {
  const r = spawnSync('node', [ENV_CLI, 'ports', '--shell'], {
    cwd, encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME },
  });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function launchEntry(project) {
  const launch = JSON.parse(readFileSync(join(project, '.claude', 'launch.json'), 'utf8'));
  return launch.configurations.find((c) => c.name === 'wt-task-1-alpha');
}

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-wtconfig-')));
  HOME = join(ROOT, 'cogyard-home');
  mkdirSync(HOME, { recursive: true });
  // A no-op osascript ahead of the real one, so the hook pops no notification.
  BIN = join(ROOT, 'bin');
  mkdirSync(BIN);
  writeFileSync(join(BIN, 'osascript'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(BIN, 'osascript'), 0o755);
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

// --- the resolver ------------------------------------------------------------

test('no config in either place → null', () => {
  const dir = join(ROOT, 'none');
  mkdirSync(dir);
  assert.equal(findWorktreeConfig(dir), null);
});

test('new path → the new file', () => {
  const dir = join(ROOT, 'new-only');
  writeConfigAt(dir, NEW);
  assert.deepEqual(findWorktreeConfig(dir), { path: join(dir, ...NEW) });
});

test('old path only → null: the old file is not read', () => {
  const dir = join(ROOT, 'old-only');
  writeConfigAt(dir, OLD);
  assert.equal(findWorktreeConfig(dir), null);
});

test('both present → the new file; the old one is ignored', () => {
  const dir = join(ROOT, 'both');
  writeConfigAt(dir, NEW);
  writeConfigAt(dir, OLD);
  assert.deepEqual(findWorktreeConfig(dir), { path: join(dir, ...NEW) });
});

test('a directory at the config path is not a config', () => {
  const dir = join(ROOT, 'dir-not-file');
  mkdirSync(join(dir, ...NEW), { recursive: true });
  assert.equal(findWorktreeConfig(dir), null);
});

// --- end to end: the hook and `env ports` ------------------------------------

test('hook + env ports: a project with only .cogyard/worktree.json is fully wired', () => {
  const { project, wt } = makeProject('wired-new');
  writeConfigAt(project, NEW);
  const briefing = runHook(wt);
  assert.match(briefing, /=== Worktree dev environment ===/, 'full wiring, not the reserved-only briefing');
  const entry = launchEntry(project);
  assert.ok(entry, 'the worktree entry is registered in launch.json');
  const { status, out } = envPorts(wt);
  assert.equal(status, 0);
  assert.match(out, new RegExp(`^export PORT=\\d+\\nexport FRONTEND_PORT=${entry.port}$`));
});

test('hook: a project with only .claude/worktree-config.json gets the reserved-only briefing', () => {
  const { wt } = makeProject('wired-old');
  writeConfigAt(join(ROOT, 'wired-old'), OLD);
  const briefing = runHook(wt);
  assert.match(briefing, /=== Worktree ports \(reserved\) ===/, 'the old file wires nothing');
});

test('env ports: with both present, the names come from the new file', () => {
  const { project, wt } = makeProject('both-names');
  writeConfigAt(project, NEW, { NEW_BACKEND: 'backend', FRONTEND_PORT: 'frontend' });
  writeConfigAt(project, OLD, { OLD_BACKEND: 'backend', FRONTEND_PORT: 'frontend' });
  runHook(wt);
  const { status, out } = envPorts(wt);
  assert.equal(status, 0);
  assert.match(out, /^export NEW_BACKEND=/m);
  assert.doesNotMatch(out, /OLD_BACKEND/);
});

// --- what init / onboard write ----------------------------------------------

// The target is always an ABSOLUTE path outside any repo: a bare name is
// created under cwd, and from inside this repo init refuses it (task 182).
function cogyard(args) {
  const r = spawnSync('node', [COGYARD_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COGYARD_HOME: HOME, COGYARD_PROJECTS_ROOT: join(ROOT, 'projects') },
  });
  assert.equal(r.status, 0, `cogyard ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const tracked = (repo) => execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);

test('init commits .cogyard/worktree.json and nothing under .claude/', () => {
  const target = join(ROOT, 'projects', 'fresh');
  cogyard(['init', target, '--kind', 'fullstack']);
  const files = tracked(target);
  assert.ok(files.includes('.cogyard/worktree.json'), `not committed: ${files.join(', ')}`);
  assert.deepEqual(files.filter((f) => f.startsWith('.claude/')), []);
  const cfg = JSON.parse(readFileSync(join(target, ...NEW), 'utf8'));
  assert.deepEqual(cfg.port_vars, { PORT: 'backend', FRONTEND_PORT: 'frontend' });
});

test('onboard writes .cogyard/worktree.json even when an old .claude/ file is there', () => {
  const { project } = makeProject('onboard-old');
  writeConfigAt(project, OLD, { CUSTOM_PORT: 'backend', FRONTEND_PORT: 'frontend' });
  cogyard(['onboard', project, '--kind', 'fullstack']);
  assert.equal(findWorktreeConfig(project).path, join(project, ...NEW));
});

test('hook: with no config anywhere, the reserved-only briefing names the new path', () => {
  const { wt } = makeProject('unwired');
  const briefing = runHook(wt);
  assert.match(briefing, /=== Worktree ports \(reserved\) ===/);
  assert.match(briefing, /\.cogyard\/worktree\.json/);
});
