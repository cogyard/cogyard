// Tests for the SessionStart hook on a config that names no dev command (task 162).
//
// A project built outside npm — an Xcode app, PlatformIO firmware — can still
// want its worktree ports while having no dev server. Its .cogyard/worktree.json
// omits dev_script, and the hook must read that as "no dev server here": no
// launch.json entry (and any stale one for this worktree dropped), a briefing
// that says so, and no failure. It used to default to `npm run dev`, handing the
// session a preview entry for a command that does not exist.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'worktree-session.mjs');

let ROOT, PROJECT, WT, HOME, briefing;

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-hook-nodev-')));
  PROJECT = join(ROOT, 'project');
  WT = join(PROJECT, '.claude', 'worktrees', 'task-1-alpha');
  HOME = join(ROOT, 'cogyard-home');
  mkdirSync(WT, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(join(PROJECT, '.cogyard'), { recursive: true });
  writeFileSync(join(PROJECT, '.cogyard', 'worktree.json'), JSON.stringify({
    project_name: 'project',
    port_vars: { PORT: 'backend', FRONTEND_PORT: 'frontend' },
  }));
  // A stale entry this worktree got while its config still named a dev command,
  // and a project-owned entry that is never the hook's to touch.
  mkdirSync(join(PROJECT, '.claude'), { recursive: true });
  writeFileSync(join(PROJECT, '.claude', 'launch.json'), JSON.stringify({
    version: '0.0.1',
    configurations: [
      { name: 'wt-task-1-alpha', runtimeExecutable: 'sh', runtimeArgs: ['-c', `cd '${WT}' && npm run dev`], port: 1, cogyardWorktree: WT },
      { name: 'api', runtimeExecutable: 'npm', runtimeArgs: ['run', 'api'], port: 7440 },
    ],
  }));
  // And the worktree's own file from that time (task 230), which must go too.
  mkdirSync(join(WT, '.claude'), { recursive: true });
  writeFileSync(join(WT, '.claude', 'launch.json'), JSON.stringify({
    version: '0.0.1',
    configurations: [
      { name: 'wt-task-1-alpha', runtimeExecutable: 'sh', runtimeArgs: ['-c', `cd '${WT}' && npm run dev`], port: 1, cogyardWorktree: WT },
    ],
  }));

  const bin = join(ROOT, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'osascript'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'osascript'), 0o755);

  briefing = execFileSync('node', [HOOK, WT], {
    env: { ...process.env, COGYARD_HOME: HOME, COGYARD_DRIVER: 'claude', PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

test('the briefing says there is no dev server and names the reserved ports', () => {
  assert.match(briefing, /# No dev server/);
  assert.match(briefing, /Reserved ports: backend = \d+, frontend = \d+/);
  assert.doesNotMatch(briefing, /preview_start/);
  assert.doesNotMatch(briefing, /npm run dev/);
  assert.doesNotMatch(briefing, /setup failed/);
});

test('no preview entry is registered, a stale one is dropped, the project\'s own is kept', () => {
  const launch = JSON.parse(readFileSync(join(PROJECT, '.claude', 'launch.json'), 'utf8'));
  const names = launch.configurations.map((c) => c.name);
  assert.deepEqual(names, ['api']);
});

test('the worktree\'s own launch.json is removed', () => {
  assert.equal(existsSync(join(WT, '.claude', 'launch.json')), false);
});
