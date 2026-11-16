// Tests for `cogyard env ports` — where a dev server's ports come from, and
// what this project calls them (task 131; carries over every case that pinned
// scripts/dev-ports.sh in task 121, which this subcommand replaces).
//
// The promise being tested is "never guess". Three halves:
//   · the registry beats a stale .env.worktree copy, so the copy that rotted on
//     2026-08-18 (file said 31000, allocation said 31046) cannot decide anything;
//   · a worktree with no readable allocation FAILS rather than falling back to a
//     default, because a default in a worktree is how two of them land on one
//     port, silently;
//   · the variable NAMES come from the project's own port_vars, never from this
//     repo's habits — an assignment under a name the project doesn't read binds
//     nothing while looking like it worked.
//
// COGYARD_HOME points at a temp registry, so the answers here are controlled by
// the test rather than read from the developer's real ~/.cogyard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'env.mjs');

let ROOT, HOME, PLAIN, REPO, WORKTREE, UNALLOCATED;

// The registry, as the SessionStart hook would have written it.
function writeRegistry(allocations) {
  writeFileSync(join(HOME, 'ports.json'), JSON.stringify({ allocations }, null, 2));
}

// The project's declaration of what it calls its ports.
function writeConfig(repo, portVars) {
  mkdirSync(join(repo, '.cogyard'), { recursive: true });
  writeFileSync(join(repo, '.cogyard', 'worktree.json'),
    JSON.stringify({ project_name: 'demo', port_vars: portVars }, null, 2));
}

function run(cwd, args = [], env = {}) {
  const r = spawnSync('node', [CLI, 'ports', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, COGYARD_HOME: HOME, ...env },
  });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-envports-')));
  HOME = join(ROOT, 'home');
  PLAIN = join(ROOT, 'plain');
  mkdirSync(HOME, { recursive: true });
  mkdirSync(PLAIN, { recursive: true });

  REPO = join(ROOT, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
  execFileSync('git', ['-C', REPO, '-c', 'user.email=a@b.c', '-c', 'user.name=x',
    'commit', '-q', '--allow-empty', '-m', 'init']);
  WORKTREE = join(REPO, '.claude', 'worktrees', 'task-1-thing');
  UNALLOCATED = join(REPO, '.claude', 'worktrees', 'task-2-nothing');
  mkdirSync(dirname(WORKTREE), { recursive: true });
  execFileSync('git', ['-C', REPO, 'worktree', 'add', '-q', '-b', 'wtb', WORKTREE]);
  execFileSync('git', ['-C', REPO, 'worktree', 'add', '-q', '-b', 'wtb2', UNALLOCATED]);

  writeRegistry({ [WORKTREE]: { backend: 30046, frontend: 31047 } });
  writeConfig(REPO, { PORT: 'backend', FRONTEND_PORT: 'frontend' });
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

test('a worktree gets the ports the registry holds, under the declared names', () => {
  const { status, out } = run(WORKTREE, ['--shell']);
  assert.equal(status, 0);
  assert.equal(out, 'export PORT=30046\nexport FRONTEND_PORT=31047');
});

test('the assignments are exported — a bare one is invisible to the server child', () => {
  const { out } = run(WORKTREE, ['--shell']);
  for (const line of out.split('\n')) assert.match(line, /^export /);
});

test('the registry beats a stale copy in the environment', () => {
  // Exactly the 2026-08-18 rot: the copy says 31000, the allocation says 31047.
  const { status, out } = run(WORKTREE, ['--shell'], { PORT: '30000', FRONTEND_PORT: '31000' });
  assert.equal(status, 0);
  assert.equal(out, 'export PORT=30046\nexport FRONTEND_PORT=31047', 'the stale copy must not win');
});

test('the names are the project\'s own, not this repo\'s habits', () => {
  writeConfig(REPO, { BACKEND_PORT: 'backend', FRONTEND_PORT: 'frontend' });
  const { status, out } = run(WORKTREE, ['--shell']);
  assert.equal(status, 0);
  assert.equal(out, 'export BACKEND_PORT=30046\nexport FRONTEND_PORT=31047');
  writeConfig(REPO, { PORT: 'backend', FRONTEND_PORT: 'frontend' });
});

test('a project declaring one port gets one line', () => {
  writeConfig(REPO, { PLANET_PORT: 'backend' });
  const { status, out } = run(WORKTREE, ['--shell']);
  assert.equal(status, 0);
  assert.equal(out, 'export PLANET_PORT=30046');
  writeConfig(REPO, { PORT: 'backend', FRONTEND_PORT: 'frontend' });
});

test('a worktree with no allocation FAILS rather than guessing', () => {
  const { status, out, err } = run(UNALLOCATED, ['--shell']);
  assert.notEqual(status, 0);
  assert.equal(out, '', 'nothing may be printed — a caller must not get a port');
  assert.match(err, /could not be read/);
  assert.match(err, /cogyard hook session-start/);
});

test('a worktree does not fall back to a default even when one is in the environment', () => {
  const { status, out } = run(UNALLOCATED, ['--shell'], { PORT: '7440', FRONTEND_PORT: '4200' });
  assert.notEqual(status, 0);
  assert.equal(out, '');
});

test('the human view fails the same way — no numbers to copy out of a guess', () => {
  const { status, out } = run(UNALLOCATED);
  assert.notEqual(status, 0);
  assert.equal(out, '');
});

test('an allocation with no declared names FAILS — an unread variable binds nothing', () => {
  rmSync(join(REPO, '.cogyard', 'worktree.json'));
  const { status, out, err } = run(WORKTREE, ['--shell']);
  assert.notEqual(status, 0);
  assert.equal(out, '');
  assert.match(err, /port_vars/);
  assert.match(err, /30046/, 'a human still needs to see what was allocated');
  writeConfig(REPO, { PORT: 'backend', FRONTEND_PORT: 'frontend' });
});

test('outside a worktree nothing is assigned — the repo defaults stand', () => {
  const { status, out } = run(REPO, ['--shell']);
  assert.equal(status, 0);
  assert.equal(out, '', 'an assignment here would override the repo\'s own default');
});

test('outside a repo entirely, the same silence', () => {
  const { status, out } = run(PLAIN, ['--shell']);
  assert.equal(status, 0);
  assert.equal(out, '');
});

test('the human view names the ports, the sides, and the worktree', () => {
  const { status, out } = run(WORKTREE);
  assert.equal(status, 0);
  assert.match(out, /task-1-thing/);
  assert.match(out, /PORT\s+= 30046\s+\(backend\)/);
  assert.match(out, /FRONTEND_PORT = 31047\s+\(frontend\)/);
});

// `env detect` answers in JSON everywhere (task 136): a worktree reports its
// allocation, a main checkout reports null ports, and a directory outside any
// git repo reports every field null — exit 0 each time, never an error.
function detect(cwd) {
  const r = spawnSync('node', [CLI, 'detect'], { cwd, encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME } });
  return { status: r.status, json: JSON.parse(r.stdout) };
}

test('detect: a worktree reports its registry ports', () => {
  const { status, json } = detect(WORKTREE);
  assert.equal(status, 0);
  assert.equal(json.worktree, 'task-1-thing');
  assert.deepEqual(json.ports, { backend: 30046, frontend: 31047 });
});

test('detect: a main checkout reports null ports', () => {
  const { status, json } = detect(REPO);
  assert.equal(status, 0);
  assert.equal(json.branch, 'main');
  assert.deepEqual(json.ports, { backend: null, frontend: null });
});

test('detect: outside a git repo, every field is null and it still exits 0', () => {
  const { status, json } = detect(PLAIN);
  assert.equal(status, 0);
  assert.equal(json.repoRoot, null);
  assert.equal(json.worktree, null);
  assert.deepEqual(json.ports, { backend: null, frontend: null });
});
