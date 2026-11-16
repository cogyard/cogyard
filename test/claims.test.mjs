// test/claims.test.mjs — the machine-local claim record (task 190): a task's
// worktree and chat id live in $COGYARD_HOME/claims.json, and the task loader
// lays them over the task's `env` as it reads the file.
//
// $COGYARD_HOME is a throwaway folder, set before core is imported (core/paths
// reads it once, at import).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-claims-')));
process.env.COGYARD_HOME = join(ROOT, 'home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { CLAIMS_PATH, localClaim, setLocalClaim } = await import('../core/claims.mjs');
const { readTaskFile } = await import('../core/frontmatter.mjs');

const STORE = join(ROOT, 'store');
mkdirSync(STORE);
const task = (file, id, env) => {
  writeFileSync(join(STORE, file), ['---', `id: ${id}`, `slug: s${id}`, 'title: t', 'status: OPEN', 'type: bug',
    'env:', ...env, '---', '', 'body', ''].join('\n'));
  return join(STORE, file);
};

test('no record on this machine: the task file is read as written (a store not yet migrated)', () => {
  const p = task('001-a.md', 1, ['  worktree: old-wt', '  branch: b1', '  claimed_at: 2026-01-01', '  claimed_by: Ann', '  claimed_by_session: s-old']);
  const env = readTaskFile(p).frontmatter.env;
  assert.equal(env.worktree, 'old-wt');
  assert.equal(env.claimed_by_session, 's-old');
  assert.equal(localClaim(p, 1), null);
});

test('a record is laid over the task as it loads — branch, claimed_by, claimed_at stay the file\'s', () => {
  const p = task('002-b.md', 2, ['  branch: b2', '  claimed_at: 2026-01-02', '  claimed_by: Ann']);
  setLocalClaim(p, 2, { worktree: 'task-002-b', session: 'sess-2', at: '2026-01-02' });
  const env = readTaskFile(p).frontmatter.env;
  assert.deepEqual([env.worktree, env.claimed_by_session, env.branch, env.claimed_by], ['task-002-b', 'sess-2', 'b2', 'Ann']);
  assert.ok(existsSync(CLAIMS_PATH));
  assert.ok(!readFileSync(p, 'utf8').includes('sess-2'), 'the task file is not written');
});

test('release keeps the worktree record and clears the session', () => {
  const p = join(STORE, '002-b.md');
  setLocalClaim(p, 2, { session: null });
  const env = readTaskFile(p).frontmatter.env;
  assert.equal(env.worktree, 'task-002-b');
  assert.equal(env.claimed_by_session, null);
});

test('the record overrides the old fields in a not-yet-migrated file', () => {
  const p = join(STORE, '001-a.md');
  setLocalClaim(p, 1, { worktree: 'new-wt', session: null });
  const env = readTaskFile(p).frontmatter.env;
  assert.deepEqual([env.worktree, env.claimed_by_session], ['new-wt', null]);
});

test('keyed by the store\'s real path and the canonical id: a link, zero-padding and a dotted id all find the same record', () => {
  const link = join(ROOT, 'project-link');
  symlinkSync(STORE, link);
  const p = task('013.5-c.md', '13.5', ['  branch: null']);
  setLocalClaim(join(link, '013.5-c.md'), '013.5', { worktree: 'wt-13-5' });
  assert.equal(localClaim(p, 13.5).worktree, 'wt-13-5');
  assert.equal(readTaskFile(join(link, '013.5-c.md')).frontmatter.env.worktree, 'wt-13-5');
  const all = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8'));
  assert.ok(Object.keys(all).includes(`${STORE}#13.5`));
});
