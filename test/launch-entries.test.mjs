// Tests for core/launch.mjs — the per-project launch.json (task 121).
//
// The interesting case is de-registration, and specifically the one a naive
// round trip gets WRONG. Removing a worktree used to leave its entry behind
// until some other worktree session happened to start; with a second worktree
// lying around, a create-then-destroy test passes while the bug is fully
// present. So the decisive test here removes the LAST worktree and asserts the
// entry is gone with nothing left to trigger a sweep.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWorktreeLaunch, writeWorktreeLaunch, removeWorktreeLaunch, sweepLaunchEntries, launchNameFor } from '../core/launch.mjs';

let ROOT, PROJECT;

const launchFile = () => join(PROJECT, '.claude', 'launch.json');
const read = () => JSON.parse(readFileSync(launchFile(), 'utf8'));
const names = () => read().configurations.map((c) => c.name);

function makeWorktree(name) {
  const wt = join(PROJECT, '.claude', 'worktrees', name);
  mkdirSync(wt, { recursive: true });
  return wt;
}

function register(name, port) {
  const wt = join(PROJECT, '.claude', 'worktrees', name);
  return registerWorktreeLaunch(PROJECT, {
    worktree: wt, name: launchNameFor(name), devScript: 'npm run dev', port,
  });
}

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-launch-')));
  PROJECT = join(ROOT, 'project');
  mkdirSync(join(PROJECT, '.claude'), { recursive: true });
  // The project's own entries — these must survive everything below.
  writeFileSync(launchFile(), JSON.stringify({
    version: '0.0.1',
    configurations: [
      { name: 'api', runtimeExecutable: 'npm', runtimeArgs: ['run', 'api'], port: 7440 },
      { name: 'frontend', runtimeExecutable: 'npm', runtimeArgs: ['start'], port: 4200 },
    ],
  }, null, 2));
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

test('registering a worktree adds one entry and records its owner', () => {
  makeWorktree('task-1-alpha');
  register('task-1-alpha', 31001);
  assert.deepEqual(names(), ['api', 'frontend', 'wt-task-1-alpha']);
  const e = read().configurations.find((c) => c.name === 'wt-task-1-alpha');
  assert.equal(e.port, 31001);
  assert.match(e.cogyardWorktree, /task-1-alpha$/);
});

test('re-registering refreshes in place rather than duplicating', () => {
  register('task-1-alpha', 31009);
  assert.deepEqual(names(), ['api', 'frontend', 'wt-task-1-alpha']);
  assert.equal(read().configurations.find((c) => c.name === 'wt-task-1-alpha').port, 31009);
});

test('removing a worktree removes its entry — and ONLY its entry', () => {
  makeWorktree('task-2-beta');
  register('task-2-beta', 31002);
  assert.deepEqual(names(), ['api', 'frontend', 'wt-task-1-alpha', 'wt-task-2-beta']);

  const alpha = join(PROJECT, '.claude', 'worktrees', 'task-1-alpha');
  rmSync(alpha, { recursive: true, force: true });
  const swept = sweepLaunchEntries(PROJECT);

  assert.deepEqual(swept, ['wt-task-1-alpha']);
  assert.deepEqual(names(), ['api', 'frontend', 'wt-task-2-beta']);
});

test('removing the LAST worktree still removes its entry', () => {
  // The case a create-then-destroy round trip hides: with no other worktree
  // left, nothing would ever trigger a later sweep, so removal must do it.
  const beta = join(PROJECT, '.claude', 'worktrees', 'task-2-beta');
  rmSync(beta, { recursive: true, force: true });
  assert.deepEqual(sweepLaunchEntries(PROJECT), ['wt-task-2-beta']);
  assert.deepEqual(names(), ['api', 'frontend']);
});

test('a worktree still on disk is de-registered when named explicitly', () => {
  // What cleanup uses: git may leave the directory behind, and the entry must
  // go regardless.
  makeWorktree('task-3-gamma');
  register('task-3-gamma', 31003);
  const wt = join(PROJECT, '.claude', 'worktrees', 'task-3-gamma');
  assert.ok(existsSync(wt));

  assert.deepEqual(sweepLaunchEntries(PROJECT, { except: wt }), ['wt-task-3-gamma']);
  assert.deepEqual(names(), ['api', 'frontend']);
  rmSync(wt, { recursive: true, force: true });
});

test('a legacy hand-written entry is sweepable via its cd', () => {
  // The seventeen entries that predate cogyardWorktree carry only a shell cd.
  const doc = read();
  doc.configurations.push({
    name: 'wt-task-99-legacy',
    runtimeExecutable: 'sh',
    runtimeArgs: ['-c', 'cd .claude/worktrees/task-99-legacy && bash scripts/dev.sh'],
    port: 31099,
  });
  writeFileSync(launchFile(), JSON.stringify(doc, null, 2));

  assert.deepEqual(sweepLaunchEntries(PROJECT), ['wt-task-99-legacy']);
  assert.deepEqual(names(), ['api', 'frontend']);
});

test('the project\'s own entries are never swept', () => {
  assert.deepEqual(sweepLaunchEntries(PROJECT), []);
  assert.deepEqual(names(), ['api', 'frontend']);
});

test('a corrupt launch.json costs nobody their dev server', () => {
  writeFileSync(launchFile(), '{ this is not json');
  makeWorktree('task-4-delta');
  register('task-4-delta', 31004);
  assert.deepEqual(names(), ['wt-task-4-delta']);
});

// Task 230: the worktree's own file. The preview tool reads only the chat's
// current folder's launch.json, so a chat inside a worktree needs this one.
test('a worktree\'s own file holds exactly its entry, the same one the main checkout lists', () => {
  const wt = makeWorktree('task-5-echo');
  // The app drops a copy of the main checkout's file into a worktree it creates.
  mkdirSync(join(wt, '.claude'), { recursive: true });
  writeFileSync(join(wt, '.claude', 'launch.json'), readFileSync(launchFile(), 'utf8'));

  const entry = { worktree: wt, name: launchNameFor('task-5-echo'), devScript: 'npm run dev', port: 31005 };
  registerWorktreeLaunch(PROJECT, entry);
  writeWorktreeLaunch(wt, entry);

  const own = JSON.parse(readFileSync(join(wt, '.claude', 'launch.json'), 'utf8'));
  assert.deepEqual(own.configurations.map((c) => c.name), ['wt-task-5-echo']);
  assert.deepEqual(own.configurations[0], read().configurations.find((c) => c.name === 'wt-task-5-echo'));
});

test('removing a worktree\'s own file reports whether there was one', () => {
  const wt = makeWorktree('task-6-foxtrot');
  writeWorktreeLaunch(wt, { worktree: wt, name: launchNameFor('task-6-foxtrot'), devScript: 'npm run dev', port: 31006 });
  assert.equal(removeWorktreeLaunch(wt), true);
  assert.equal(existsSync(join(wt, '.claude', 'launch.json')), false);
  assert.equal(removeWorktreeLaunch(wt), false);
});
