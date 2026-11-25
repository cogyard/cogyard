// Tests for the SessionStart hook's several port-binding commands (task 164).
//
// A worktree config's `dev_script` is the first command; `extra_dev_scripts`
// names more, each with its own `launch_name` and `preview_port_var`. Every one
// gets a launch entry in both files — the worktree's own and the main
// checkout's — opening on its own port. A config with only `dev_script` is wired
// exactly as before. Runs the real hook against throwaway projects with their
// own COGYARD_HOME, so no real allocation is touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'worktree-session.mjs');

let ROOT, BIN;

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-hook-dev-entries-')));
  // A no-op osascript ahead of the real one, so the run pops no notification.
  BIN = join(ROOT, 'bin');
  mkdirSync(BIN);
  writeFileSync(join(BIN, 'osascript'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(BIN, 'osascript'), 0o755);
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

const PREVIEW = {
  dev_script: 'npm run preview', launch_name: 'preview',
  port_vars: { PORT: 'backend', FRONTEND_PORT: 'frontend' }, preview_port_var: 'PORT',
};

function project(name) {
  const dir = join(ROOT, name);
  const wt = join(dir, '.claude', 'worktrees', 'task-1-alpha');
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(dir, '.cogyard'), { recursive: true });
  return { dir, wt, home: join(ROOT, `${name}-home`) };
}

function run(p, config) {
  writeFileSync(join(p.dir, '.cogyard', 'worktree.json'), JSON.stringify({ project_name: 'demo', ...config }));
  const env = { ...process.env, COGYARD_HOME: p.home, COGYARD_DRIVER: 'claude', PATH: `${BIN}:${process.env.PATH}` };
  delete env.CLAUDE_PROJECT_DIR;
  return execFileSync('node', [HOOK, p.wt], { env, input: '', encoding: 'utf8' });
}

const allocation = (briefing) => {
  const m = briefing.match(/backend\s+port = (\d+)\s+frontend port = (\d+)/);
  assert.ok(m, `briefing names no ports:\n${briefing}`);
  return { backend: Number(m[1]), frontend: Number(m[2]) };
};
const entries = (dir) => JSON.parse(readFileSync(join(dir, '.claude', 'launch.json'), 'utf8')).configurations;
const byName = (list) => Object.fromEntries(list.map((c) => [c.name, c]));

test('each further command gets its own launch entry, in both files, on its own port', () => {
  const p = project('two');
  const briefing = run(p, { ...PREVIEW, extra_dev_scripts: [
    { dev_script: 'npm run site', launch_name: 'site', preview_port_var: 'FRONTEND_PORT' },
  ] });
  const { backend, frontend } = allocation(briefing);
  for (const dir of [p.wt, p.dir]) {
    const e = byName(entries(dir));
    assert.deepEqual(Object.keys(e), ['wt-task-1-alpha', 'wt-task-1-alpha-site'], dir);
    assert.equal(e['wt-task-1-alpha'].port, backend, 'the first command opens on PORT, the backend port');
    assert.match(e['wt-task-1-alpha'].runtimeArgs[1], /&& npm run preview$/);
    assert.equal(e['wt-task-1-alpha-site'].port, frontend);
    assert.match(e['wt-task-1-alpha-site'].runtimeArgs[1], /&& npm run site$/);
    assert.equal(e['wt-task-1-alpha-site'].cogyardWorktree, p.wt);
  }
  assert.match(briefing, /preview_start name="wt-task-1-alpha-site"\n\s+runs npm run site, opens on FRONTEND_PORT = \d+ \(frontend\)/);
  assert.doesNotMatch(briefing, /run one of them at a time/);
  assert.ok(briefing.includes(`Preview  : http://localhost:${backend}`), 'the first command\'s own port is named');
});

test('two commands on one port are both wired, and the briefing says to run one at a time', () => {
  const p = project('same-port');
  const briefing = run(p, { ...PREVIEW, extra_dev_scripts: [
    { dev_script: 'npm run site', launch_name: 'site', preview_port_var: 'PORT' },
  ] });
  const e = byName(entries(p.wt));
  assert.equal(e['wt-task-1-alpha'].port, e['wt-task-1-alpha-site'].port);
  assert.match(briefing, /run one of them at a time/);
});

test('a command dropped from the config loses its entry on the next run, in both files', () => {
  const p = project('dropped');
  run(p, { ...PREVIEW, extra_dev_scripts: [{ dev_script: 'npm run site', launch_name: 'site' }] });
  run(p, PREVIEW);
  for (const dir of [p.wt, p.dir]) assert.deepEqual(entries(dir).map((c) => c.name), ['wt-task-1-alpha'], dir);
});

test('a config with only dev_script is wired as before: one entry, on the frontend port by default', () => {
  const p = project('single');
  const briefing = run(p, { dev_script: 'npm run dev', launch_name: 'dev', port_vars: { PORT: 'backend', FRONTEND_PORT: 'frontend' }, preview_port_var: 'FRONTEND_PORT' });
  const list = entries(p.wt);
  assert.deepEqual(list.map((c) => c.name), ['wt-task-1-alpha']);
  assert.equal(list[0].port, allocation(briefing).frontend);
  assert.doesNotMatch(briefing, /More commands that bind a port/);
  assert.doesNotMatch(briefing, /Preview  :/, 'no separate preview line when it is the frontend port');
});

for (const [why, extra, message] of [
  ['no launch_name', [{ dev_script: 'npm run site' }], /needs a launch_name/],
  ['a launch_name used twice', [{ dev_script: 'a', launch_name: 'x' }, { dev_script: 'b', launch_name: 'x' }], /"x" is used twice/],
  ['the first command\'s launch_name', [{ dev_script: 'a', launch_name: 'preview' }], /"preview" is used twice/],
  ['an undeclared preview_port_var', [{ dev_script: 'a', launch_name: 'x', preview_port_var: 'API_PORT' }], /API_PORT not declared/],
  ['no dev_script', [{ launch_name: 'x' }], /has no dev_script/],
]) {
  test(`extra_dev_scripts with ${why} is refused and wires nothing`, () => {
    const p = project(`bad-${why.replace(/\W+/g, '-')}`);
    const briefing = run(p, { ...PREVIEW, extra_dev_scripts: extra });
    assert.doesNotMatch(briefing, /Worktree dev environment/, 'the hook does not report the worktree as wired');
    assert.equal(existsSync(join(p.wt, '.claude', 'launch.json')), false, 'no launch entry is written');
    assert.match(readFileSync(join(p.home, 'logs', 'worktree-hook.log'), 'utf8'), message);
  });
}

test('extra_dev_scripts without a dev_script is refused', () => {
  const p = project('no-first');
  run(p, { port_vars: { PORT: 'backend' }, extra_dev_scripts: [{ dev_script: 'npm run site', launch_name: 'site' }] });
  assert.match(readFileSync(join(p.home, 'logs', 'worktree-hook.log'), 'utf8'), /extra_dev_scripts needs a dev_script/);
});
