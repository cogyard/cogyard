// Tests for the default-branch resolver — the single source of truth that keeps
// the portal/CLI/skills from hardcoding 'main'. Integration-style: spins up real
// throwaway git repos in a temp dir (git is the thing under test here).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultBranch, defaultBranchSync } from '../core/exec.mjs';

let ROOT;
const repo = (name, initialBranch) => {
  const dir = join(ROOT, name);
  execFileSync('git', ['init', '-q', '-b', initialBranch, dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
};

before(() => { ROOT = mkdtempSync(join(tmpdir(), 'bt-defbranch-')); });
after(() => { rmSync(ROOT, { recursive: true, force: true }); });

test('main repo resolves to main (async + sync agree)', async () => {
  const dir = repo('main-repo', 'main');
  assert.equal(await defaultBranch(dir), 'main');
  assert.equal(defaultBranchSync(dir), 'main');
});

test('master repo falls back to master', async () => {
  const dir = repo('master-repo', 'master');
  assert.equal(await defaultBranch(dir), 'master');
  assert.equal(defaultBranchSync(dir), 'master');
});

test('main wins when both branches exist', async () => {
  const dir = repo('both-repo', 'master');
  execFileSync('git', ['-C', dir, 'branch', 'main']);
  assert.equal(await defaultBranch(dir), 'main');
  assert.equal(defaultBranchSync(dir), 'main');
});

test('neither branch → null (no crash)', async () => {
  const dir = repo('neither-repo', 'trunk');
  assert.equal(await defaultBranch(dir), null);
  assert.equal(defaultBranchSync(dir), null);
});
