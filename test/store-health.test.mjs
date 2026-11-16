// The storage report's task-link state (task 169): every row's `link` is one of
// ok / broken / missing / folder — the same field and values GET /api/graph's
// store view sends — and `cogyard tasks doctor` prints it in its LINK column. A
// folder in the link's place is a fault with its fix, never a second model.
//
// Runs against a throwaway COGYARD_HOME / COGYARD_PROJECTS_ROOT in child
// processes (core reads both at import), so no real registry is touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS_CLI = join(HERE, '..', 'cli', 'tasks.mjs');
const CORE = join(HERE, '..', 'core', 'index.mjs');

let ROOT, ENV;
const ID = ['-c', 'user.email=a@b.c', '-c', 'user.name=x'];
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8' });

function project(name, setup) {
  const p = join(ROOT, 'projects', name);
  git(ROOT, ['init', '-q', '-b', 'main', p]);
  git(p, ['commit', '-q', '--allow-empty', '-m', 'init']);
  mkdirSync(join(p, '.cogyard'), { recursive: true });
  setup(p);
  const r = spawnSync('node', [TASKS_CLI, 'projects', 'register'], { cwd: p, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return p;
}

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-storehealth-')));
  mkdirSync(join(ROOT, 'home'));
  mkdirSync(join(ROOT, 'projects'));
  ENV = { ...process.env, COGYARD_HOME: join(ROOT, 'home'), COGYARD_PROJECTS_ROOT: join(ROOT, 'projects') };

  const store = join(ROOT, 'projects', '_tasks', 'good');
  mkdirSync(store, { recursive: true });
  git(store, ['init', '-q', '-b', 'tasks']);
  git(store, ['commit', '-q', '--allow-empty', '-m', 'init']);
  project('good', (p) => symlinkSync(store, join(p, '.cogyard', 'tasks')));
  project('dead', (p) => symlinkSync(join(ROOT, 'nowhere'), join(p, '.cogyard', 'tasks')));
  project('none', () => {});
  project('folder', (p) => {
    mkdirSync(join(p, '.cogyard', 'tasks'));
    writeFileSync(join(p, '.cogyard', 'tasks', '001-a.md'), '---\nid: 1\nslug: a\ntitle: A\nstatus: OPEN\ntype: bug\n---\n');
  });
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

function rows() {
  const out = execFileSync('node', ['--input-type=module', '-e',
    `const c = await import(${JSON.stringify(CORE)}); console.log(JSON.stringify(c.storeHealth().rows));`,
  ], { env: ENV, encoding: 'utf8' });
  return Object.fromEntries(JSON.parse(out).map((r) => [r.slug, r]));
}

test('each row carries link {state, target}: ok, broken, missing, folder — and no model field', () => {
  const r = rows();
  assert.equal(r.good.link.state, 'ok');
  assert.equal(r.dead.link.state, 'broken');
  assert.equal(r.dead.link.target, join(ROOT, 'nowhere'));
  assert.equal(r.none.link.state, 'missing');
  assert.equal(r.folder.link.state, 'folder');
  for (const row of Object.values(r)) {
    assert.equal('model' in row, false, `${row.slug} has no model field`);
    assert.equal('symlinkTarget' in row, false, `${row.slug} has no symlinkTarget field`);
  }
});

test('a folder in the link\'s place is flagged with its fix; nothing says "convertible"', () => {
  const r = rows();
  assert.ok(r.folder.flags.some((f) => /^folder, not a link to a task store — rename it to _tasks\/ and run `cogyard tasks convert`$/.test(f)), r.folder.flags.join('; '));
  for (const row of Object.values(r)) assert.equal(row.flags.some((f) => /convertible/.test(f)), false);
  assert.deepEqual(r.good.flags, []);
});

test('the same state for a project from storeLinkState, which /api/graph sends', () => {
  const out = execFileSync('node', ['--input-type=module', '-e',
    `const c = await import(${JSON.stringify(CORE)}); console.log(JSON.stringify(['good','dead','none','folder'].map((s) => c.storeLinkState(${JSON.stringify(join(ROOT, 'projects'))} + '/' + s).state)));`,
  ], { env: ENV, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), ['ok', 'broken', 'missing', 'folder']);
});

test('doctor prints a LINK column with those values, and no MODEL column', () => {
  const out = execFileSync('node', [TASKS_CLI, 'doctor'], { env: ENV, encoding: 'utf8', cwd: ROOT });
  const header = out.split('\n').find((l) => l.startsWith('PROJECT'));
  assert.match(header, /^PROJECT\s+LINK\s+STORE/);
  assert.doesNotMatch(header, /MODEL/);
  const state = (slug) => out.split('\n').find((l) => l.startsWith(slug + ' '))?.split(/\s+/)[1];
  assert.deepEqual(['good', 'dead', 'none', 'folder'].map(state), ['ok', 'broken', 'missing', 'folder']);
});
