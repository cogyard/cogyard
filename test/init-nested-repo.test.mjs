// `cogyard init` refuses a target inside an existing git repo (task 182).
//
// The wiring asks git for the repo root; in a new folder inside another repo git
// answers with the ENCLOSING repo, so init used to register, gitignore-append and
// commit into that repo. Now it stops before creating anything. Every run uses a
// throwaway COGYARD_HOME and a throwaway outer repo, never this checkout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COGYARD_CLI = join(HERE, '..', 'cli', 'cogyard.mjs');

let ROOT, HOME, OUTER;

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function init(args, cwd) {
  const r = spawnSync('node', [COGYARD_CLI, 'init', ...args, '--kind', 'fullstack'], {
    cwd, encoding: 'utf8',
    env: { ...process.env, COGYARD_HOME: HOME, COGYARD_PROJECTS_ROOT: join(ROOT, 'projects') },
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const registry = () => {
  const p = join(HOME, 'projects.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};

// Nothing in the outer repo changed and nothing was registered.
function assertUntouched() {
  assert.equal(git(OUTER, ['status', '--short', '--untracked-files=all']), '');
  assert.deepEqual(registry(), []);
}

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-init-nested-')));
  HOME = join(ROOT, 'cogyard-home');
  mkdirSync(HOME, { recursive: true });
  OUTER = join(ROOT, 'outer');
  git(ROOT, ['init', '-q', '-b', 'main', OUTER]);
  git(OUTER, ['-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'seed']);
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

test('a bare name from inside a repo is refused and nothing is written', () => {
  const r = init(['demo'], OUTER);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /is inside the git repo at /);
  assert.ok(r.out.includes(OUTER), `names the repo found:\n${r.out}`);
  assert.match(r.out, /Choose a folder outside/);
  assert.match(r.out, /cogyard onboard /);
  assert.equal(existsSync(join(OUTER, 'demo')), false);
  assertUntouched();
});

test('an absolute path deep inside a repo is refused; no parent folder is created', () => {
  const r = init([join(OUTER, 'a', 'b', 'demo')], ROOT);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /is inside the git repo at /);
  assert.equal(existsSync(join(OUTER, 'a')), false);
  assertUntouched();
});

test('an existing empty folder inside a repo is refused and left as it was', () => {
  const empty = join(OUTER, 'empty');
  mkdirSync(empty);
  try {
    const r = init([empty], ROOT);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /is inside the git repo at /);
    assert.deepEqual(readdirSync(empty), []);
    assertUntouched();
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('an absolute path outside any repo still creates its own repo and registers it', () => {
  const target = join(ROOT, 'projects', 'fresh');
  const r = init([target], ROOT);
  assert.equal(r.status, 0, r.out);
  assert.equal(git(target, ['rev-parse', '--show-toplevel']).trim(), target);
  assert.ok(git(target, ['ls-files']).includes('.cogyard/worktree.json'));
  assert.ok(registry().some((p) => p.path === target), JSON.stringify(registry()));
  assert.equal(git(OUTER, ['status', '--short', '--untracked-files=all']), '');
});

test('an empty folder that is its own fresh repo is accepted', () => {
  const target = join(ROOT, 'projects', 'own-repo');
  git(ROOT, ['init', '-q', '-b', 'main', target]);
  const r = init([target], ROOT);
  assert.equal(r.status, 0, r.out);
  assert.ok(registry().some((p) => p.path === target), JSON.stringify(registry()));
});
