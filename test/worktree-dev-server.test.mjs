// test/worktree-dev-server.test.mjs — whether a worktree runs a dev server
// (core/worktrees.mjs, `devServer`), read from the worktree's own
// .cogyard/worktree.json. The Worktrees tab shows a worktree's ports as links
// only when something can be on them: a config that names no dev_script (an
// Xcode app) says nothing is, while no config at all says nothing either way.
// The reserved ports themselves are reported unchanged in every case.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ROOT, REPO, FEATURE;
let worktreesForProject;

const git = (args) => execFileSync('git', ['-C', REPO, ...args], {
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'a@b.c' },
}).trim();

before(async () => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-wtdev-')));
  const home = join(ROOT, 'home');
  REPO = join(ROOT, 'repo');
  FEATURE = join(ROOT, 'feature');
  mkdirSync(home, { recursive: true });
  // Keep worktreesForProject off the real ~/.cogyard; give the feature worktree a port pair.
  process.env.COGYARD_HOME = home;
  execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
  git(['commit', '-q', '--allow-empty', '-m', 'm1']);
  git(['worktree', 'add', '-q', '-b', 'feature', FEATURE]);
  writeFileSync(join(home, 'ports.json'), JSON.stringify({
    allocations: { [FEATURE]: { backend: 30100, frontend: 31100, hostname: 'feature.repo.test' } },
  }));
  ({ worktreesForProject } = await import('../core/worktrees.mjs'));
});
after(() => { rmSync(ROOT, { recursive: true, force: true }); });

const config = (cfg) => {
  rmSync(join(FEATURE, '.cogyard'), { recursive: true, force: true });
  if (cfg === undefined) return;
  mkdirSync(join(FEATURE, '.cogyard'), { recursive: true });
  writeFileSync(join(FEATURE, '.cogyard', 'worktree.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
};
const feature = async () => (await worktreesForProject({ slug: 'repo', label: 'repo', path: REPO })).find((w) => w.name === 'feature');

test('a config naming a dev_script: a dev server', async () => {
  config({ project_name: 'repo', dev_script: 'npm run dev', port_vars: { PORT: 'backend' } });
  const w = await feature();
  assert.equal(w.devServer, true);
  assert.deepEqual(w.ports, { backend: 30100, frontend: 31100, hostname: 'feature.repo.test' });
});

test('a config naming no dev_script: no dev server, ports still reported', async () => {
  config({ project_name: 'repo', port_vars: { PORT: 'backend', FRONTEND_PORT: 'frontend' } });
  const w = await feature();
  assert.equal(w.devServer, false);
  assert.equal(w.ports.frontend, 31100);
});

test('no config, or one that does not parse: unknown', async () => {
  config(undefined);
  assert.equal((await feature()).devServer, null);
  config('{ not json');
  assert.equal((await feature()).devServer, null);
});
