// test/files-tree-hash.test.mjs — the Files tree's `filesHash` (task 270). The
// Files tab re-downloads the tree on every live-update check and redraws it
// only when `filesHash` moves, so the hash must move when the file list does
// (a file edited, added or deleted) and stay put when only the clock moves
// (the commit list's ages) or nothing changed at all.
//
// Runs against a throwaway repo, never a real one. COGYARD_HOME points at a
// throwaway dir BEFORE core is imported.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-treehash-home-')));
process.env.COGYARD_HOME = HOME;
const REPO = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-treehash-repo-')));
after(() => { for (const d of [HOME, REPO]) rmSync(d, { recursive: true, force: true }); });

const git = (args, env = {}) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: REPO, stdio: 'pipe', env: { ...process.env, ...env } });
git(['init', '-q', '-b', 'main']);
writeFileSync(join(REPO, 'a.md'), 'a\n');
writeFileSync(join(REPO, 'b.md'), 'b\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'init']);

const { fileTree } = await import('../server/files.mjs');

test('the same files give the same filesHash', async () => {
  const one = await fileTree(REPO), two = await fileTree(REPO);
  assert.match(one.filesHash, /^[0-9a-f]{16}$/);
  assert.equal(two.filesHash, one.filesHash);
});

test("a commit's age changing leaves filesHash alone", async () => {
  const before = await fileTree(REPO);
  // Same files, same tree; only the commit's date (and so its age label) moves.
  git(['commit', '-q', '--amend', '--no-edit', '--date', '2020-01-01T00:00:00'], { GIT_COMMITTER_DATE: '2020-01-01T00:00:00' });
  const after = await fileTree(REPO);
  assert.notEqual(after.commits[0].relDate, before.commits[0].relDate, 'the age label really changed');
  assert.deepEqual(after.files, before.files);
  assert.equal(after.filesHash, before.filesHash);
});

test('a file edited, added or deleted gives a different filesHash', async () => {
  const clean = (await fileTree(REPO)).filesHash;

  appendFileSync(join(REPO, 'a.md'), 'edited\n');          // unstaged edit: a.md turns M
  const edited = (await fileTree(REPO)).filesHash;
  assert.notEqual(edited, clean);

  writeFileSync(join(REPO, 'new.txt'), 'new\n');           // untracked file: listed with ?
  const added = (await fileTree(REPO)).filesHash;
  assert.notEqual(added, edited);

  unlinkSync(join(REPO, 'b.md'));                          // tracked file gone: D
  const deleted = (await fileTree(REPO)).filesHash;
  assert.notEqual(deleted, added);

  // Undone, the list is the clean one again, and so is its hash.
  git(['checkout', '-q', '--', 'a.md', 'b.md']);
  unlinkSync(join(REPO, 'new.txt'));
  assert.equal((await fileTree(REPO)).filesHash, clean);
});

test('editing an already-changed file again leaves filesHash alone', async () => {
  // The hash is of the list (paths, statuses, links), not of file contents: a
  // second edit to a file already marked M changes nothing the tree shows.
  appendFileSync(join(REPO, 'a.md'), 'first\n');
  const once = (await fileTree(REPO)).filesHash;
  appendFileSync(join(REPO, 'a.md'), 'second\n');
  assert.equal((await fileTree(REPO)).filesHash, once);
  git(['checkout', '-q', '--', 'a.md']);
});
