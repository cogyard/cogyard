// Tests for core/launch.mjs — the per-project launch.json (task 121).
//
// The interesting case is de-registration, and specifically the one a naive
// round trip gets WRONG. Removing a worktree used to leave its entry behind
// until some other worktree session happened to start; with a second worktree
// lying around, a create-then-destroy test passes while the bug is fully
// present. So the decisive test here removes the LAST worktree and asserts the
// entry is gone with nothing left to trigger a sweep.
//
// The worktrees here are REAL git worktrees (task 172). A worktree is alive
// only while git lists it; a folder at the path is not enough, and the bug lived
// exactly in the gap between "a folder" and "a worktree" — so a fixture made
// with mkdir would test the wrong thing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWorktreeLaunch, writeWorktreeLaunch, removeWorktreeLaunch, sweepLaunchEntries, launchNameFor } from '../core/launch.mjs';

let ROOT, PROJECT;

const launchFile = () => join(PROJECT, '.claude', 'launch.json');
const read = () => JSON.parse(readFileSync(launchFile(), 'utf8'));
const names = () => read().configurations.map((c) => c.name);
const wtPath = (name) => join(PROJECT, '.claude', 'worktrees', name);

function git(...args) {
  return execFileSync('git', ['-C', PROJECT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeWorktree(name) {
  const wt = wtPath(name);
  git('worktree', 'add', '-q', '--detach', wt);
  return wt;
}

function removeWorktree(name) {
  git('worktree', 'remove', '--force', wtPath(name));
}

function register(name, port, worktree = wtPath(name)) {
  return registerWorktreeLaunch(PROJECT, {
    worktree, name: launchNameFor(name), devScript: 'npm run dev', port,
  });
}

// An entry exactly like the four where-is-maya kept: written by the hook, owned
// by a path where only a folder holding `.env.worktree` is left.
function addEntryFor(path, name, port) {
  const doc = read();
  doc.configurations.push({
    name, runtimeExecutable: 'sh', runtimeArgs: ['-c', `cd '${path}' && npm run dev`], port, cogyardWorktree: path,
  });
  writeFileSync(launchFile(), JSON.stringify(doc, null, 2));
}

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-launch-')));
  PROJECT = join(ROOT, 'project');
  execFileSync('git', ['init', '-q', '-b', 'main', PROJECT]);
  git('-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'init');
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

  removeWorktree('task-1-alpha');
  const swept = sweepLaunchEntries(PROJECT);

  assert.deepEqual(swept, ['wt-task-1-alpha']);
  assert.deepEqual(names(), ['api', 'frontend', 'wt-task-2-beta']);
});

test('removing the LAST worktree still removes its entry', () => {
  // The case a create-then-destroy round trip hides: with no other worktree
  // left, nothing would ever trigger a later sweep, so removal must do it.
  removeWorktree('task-2-beta');
  assert.deepEqual(sweepLaunchEntries(PROJECT), ['wt-task-2-beta']);
  assert.deepEqual(names(), ['api', 'frontend']);
});

test('a worktree still alive is de-registered when named explicitly', () => {
  // What cleanup uses: git may leave the directory behind, and the entry must
  // go regardless.
  const wt = makeWorktree('task-3-gamma');
  register('task-3-gamma', 31003);
  assert.ok(existsSync(wt));

  assert.deepEqual(sweepLaunchEntries(PROJECT, { except: wt }), ['wt-task-3-gamma']);
  assert.deepEqual(names(), ['api', 'frontend']);
  removeWorktree('task-3-gamma');
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

// Task 172 — alive means a registered worktree, not a folder.

test('a folder that is not a registered worktree is swept, and the folder is left alone', () => {
  // where-is-maya's leftover, reproduced: a name with a space, a folder holding
  // only `.env.worktree`, an entry the hook wrote for it. git never made it.
  const live = makeWorktree('task-7-golf');
  register('task-7-golf', 31007);
  const leftover = wtPath('task-053 stop-sharing-keeps-todays-history-');
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, '.env.worktree'), 'PORT=30071\nFRONTEND_PORT=31071\n');
  addEntryFor(leftover, 'wt-task-053 stop-sharing-keeps-todays-history-', 31071);
  assert.deepEqual(names(), ['api', 'frontend', 'wt-task-7-golf', 'wt-task-053 stop-sharing-keeps-todays-history-']);

  assert.deepEqual(sweepLaunchEntries(PROJECT), ['wt-task-053 stop-sharing-keeps-todays-history-']);
  assert.deepEqual(names(), ['api', 'frontend', 'wt-task-7-golf'], 'the registered worktree is kept');
  assert.ok(existsSync(join(leftover, '.env.worktree')), 'the sweep drops the entry, never the folder');
  assert.ok(existsSync(live));
  rmSync(leftover, { recursive: true, force: true });
});

test('the hook\'s registration sweeps a bare folder\'s entry in the same write', () => {
  // The SessionStart path: registerWorktreeLaunch carries its own filter, and it
  // must use the same liveness as sweepLaunchEntries.
  const leftover = wtPath('task-056 request-log-is-a-per-user-record-');
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, '.env.worktree'), 'PORT=30072\n');
  addEntryFor(leftover, 'wt-task-056 request-log-is-a-per-user-record-', 31072);

  assert.deepEqual(register('task-7-golf', 31007), ['wt-task-056 request-log-is-a-per-user-record-']);
  assert.deepEqual(names(), ['api', 'frontend', 'wt-task-7-golf']);
  assert.ok(existsSync(leftover), 'the folder stays');
  rmSync(leftover, { recursive: true, force: true });
});

test('a worktree git still lists but whose folder was deleted by hand is swept', () => {
  // `git worktree list` keeps such a worktree as "prunable"; it is dead.
  const wt = makeWorktree('task-8-hotel');
  register('task-8-hotel', 31008);
  rmSync(wt, { recursive: true, force: true });
  assert.match(git('worktree', 'list', '--porcelain'), /task-8-hotel/, 'git still lists it');

  assert.deepEqual(sweepLaunchEntries(PROJECT), ['wt-task-8-hotel']);
  assert.deepEqual(names(), ['api', 'frontend', 'wt-task-7-golf']);
  git('worktree', 'prune');
});

test('an entry naming a live worktree through a symlinked path is kept', () => {
  // Paths are compared as realpaths, so a different spelling of the same
  // worktree (a linked home, /var vs /private/var) is still the same worktree.
  const link = join(ROOT, 'project-link');
  symlinkSync(PROJECT, link);
  const viaLink = join(link, '.claude', 'worktrees', 'task-7-golf');
  addEntryFor(viaLink, 'wt-task-7-golf-via-link', 31077);

  assert.deepEqual(sweepLaunchEntries(PROJECT), []);
  assert.deepEqual(names(), ['api', 'frontend', 'wt-task-7-golf', 'wt-task-7-golf-via-link']);
  const doc = read();
  doc.configurations = doc.configurations.filter((c) => c.name !== 'wt-task-7-golf-via-link');
  writeFileSync(launchFile(), JSON.stringify(doc, null, 2));
  rmSync(link);
});

test('when git cannot list the worktrees, every entry is kept', () => {
  // A git failure must not sweep everything: here the project is not a git
  // repository at all, and even an entry whose folder is plainly gone stays.
  const notRepo = join(ROOT, 'not-a-repo');
  mkdirSync(join(notRepo, '.claude'), { recursive: true });
  const gone = join(notRepo, '.claude', 'worktrees', 'task-9-india');
  const doc = {
    version: '0.0.1',
    configurations: [
      { name: 'wt-task-9-india', runtimeExecutable: 'sh', runtimeArgs: ['-c', `cd '${gone}' && npm run dev`], port: 31009, cogyardWorktree: gone },
    ],
  };
  writeFileSync(join(notRepo, '.claude', 'launch.json'), JSON.stringify(doc, null, 2));

  assert.deepEqual(sweepLaunchEntries(notRepo), []);
  const after = JSON.parse(readFileSync(join(notRepo, '.claude', 'launch.json'), 'utf8'));
  assert.deepEqual(after.configurations.map((c) => c.name), ['wt-task-9-india']);
});

test('a corrupt launch.json costs nobody their dev server', () => {
  removeWorktree('task-7-golf');
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
