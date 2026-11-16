// test/git-file-status.test.mjs — the one reader of git's per-file status
// output (task 224), and every place that reads through it: the Files tree,
// the commit panel's commit + uncommitted lists, and the store view's
// uncommitted list. A status is always ONE letter; a rename's path is its NEW
// path, with oldPath beside it.
//
// Runs against a throwaway repo, never a real one.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { statusLetter, parseNameStatusZ, parseNameStatusLine, parsePorcelainZ } from '../core/git-file-status.mjs';
import { pendingEntries } from '../core/store-audit.mjs';
import { commitDetail, gitStatus } from '../server/git.mjs';
import { fileTree, wtDiff } from '../server/files.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const raw = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const lines = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n') + '\n';

// A repo whose second commit (on branch `feature`, off `main`) holds every
// shape: an exact rename (R100), a rename with edits (R0xx), a copy, a delete,
// a modify and an add. After it: one uncommitted modify, one staged rename, one
// untracked file.
function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'git-file-status-')));
  dirs.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']); git(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'exact.md'), lines(20, 'exact'));
  writeFileSync(join(repo, 'edited.md'), lines(40, 'edited'));
  writeFileSync(join(repo, 'source.md'), lines(30, 'source'));
  writeFileSync(join(repo, 'gone.md'), 'gone\n');
  writeFileSync(join(repo, 'mod.md'), 'one\n');
  writeFileSync(join(repo, 'staged-move.md'), lines(20, 'staged'));
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'base']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  mkdirSync(join(repo, 'moved'));
  git(repo, ['mv', 'exact.md', 'moved/exact.md']);
  git(repo, ['mv', 'edited.md', 'moved/edited.md']);
  writeFileSync(join(repo, 'moved/edited.md'), lines(40, 'edited') + 'one more\n');
  copyFileSync(join(repo, 'source.md'), join(repo, 'copy.md'));
  git(repo, ['rm', '-q', 'gone.md']);
  writeFileSync(join(repo, 'mod.md'), 'two\n');
  writeFileSync(join(repo, 'added.md'), 'new\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'every shape']);
  writeFileSync(join(repo, 'mod.md'), 'three\n');
  git(repo, ['mv', 'staged-move.md', 'moved/staged-move.md']);
  writeFileSync(join(repo, 'untracked.txt'), 'u\n');
  return repo;
}

const byPath = (entries) => Object.fromEntries(entries.map((e) => [e.path, e]));

test('statusLetter drops the similarity score', () => {
  assert.equal(statusLetter('R097'), 'R');
  assert.equal(statusLetter('R100'), 'R');
  assert.equal(statusLetter('C075'), 'C');
  assert.equal(statusLetter('m'), 'M');
  assert.equal(statusLetter(null), '');
});

test('parseNameStatusZ: one letter, new path, oldPath for renames and copies', () => {
  const repo = fixture();
  const out = raw(repo, ['show', '--name-status', '-z', '-C', '--find-copies-harder', '--format=', 'HEAD']);
  const e = byPath(parseNameStatusZ(out));
  assert.deepEqual(e['moved/exact.md'], { status: 'R', path: 'moved/exact.md', oldPath: 'exact.md' });
  assert.deepEqual(e['moved/edited.md'], { status: 'R', path: 'moved/edited.md', oldPath: 'edited.md' });
  assert.deepEqual(e['copy.md'], { status: 'C', path: 'copy.md', oldPath: 'source.md' });
  assert.deepEqual(e['gone.md'], { status: 'D', path: 'gone.md' });
  assert.deepEqual(e['mod.md'], { status: 'M', path: 'mod.md' });
  assert.deepEqual(e['added.md'], { status: 'A', path: 'added.md' });
  assert.ok(!Object.keys(e).some((p) => p.includes('\t')), 'no path carries a tab');
});

test('parseNameStatusLine reads the non -z line form the same way', () => {
  assert.deepEqual(parseNameStatusLine('R097\told/a.md\tnew/a.md'), { status: 'R', path: 'new/a.md', oldPath: 'old/a.md' });
  assert.deepEqual(parseNameStatusLine('M\ta.md'), { status: 'M', path: 'a.md' });
  assert.equal(parseNameStatusLine(''), null);
  assert.equal(parseNameStatusLine('commit header'), null);
});

test('parsePorcelainZ: both columns, staged rename with oldPath, untracked', () => {
  const repo = fixture();
  const e = byPath(parsePorcelainZ(raw(repo, ['status', '--porcelain=v1', '-z'])));
  assert.deepEqual(e['mod.md'], { x: ' ', y: 'M', path: 'mod.md', untracked: false });
  assert.deepEqual(e['moved/staged-move.md'], { x: 'R', y: ' ', path: 'moved/staged-move.md', oldPath: 'staged-move.md', untracked: false });
  assert.deepEqual(e['untracked.txt'], { x: '?', y: '?', path: 'untracked.txt', untracked: true });
});

test('commit panel commit detail: letters only, renames split (was "R097" and "old\\tnew")', async () => {
  const repo = fixture();
  const d = await commitDetail(repo, git(repo, ['rev-parse', 'HEAD']).trim());
  const e = byPath(d.files);
  assert.deepEqual(e['moved/exact.md'], { status: 'R', path: 'moved/exact.md', oldPath: 'exact.md' });
  assert.deepEqual(e['moved/edited.md'], { status: 'R', path: 'moved/edited.md', oldPath: 'edited.md' });
  assert.equal(e['gone.md'].status, 'D');
  for (const f of d.files) assert.match(f.status, /^[A-Z]$/, `${f.path}: ${f.status}`);
});

test('commit panel uncommitted lists: staged rename keeps its old path, untracked listed', async () => {
  const repo = fixture();
  const st = await gitStatus(repo);
  assert.deepEqual(st.staged.find((f) => f.path === 'moved/staged-move.md'), { path: 'moved/staged-move.md', status: 'R', oldPath: 'staged-move.md' });
  assert.deepEqual(st.unstaged, [{ path: 'mod.md', status: 'M' }]);
  assert.deepEqual(st.untracked, [{ path: 'untracked.txt' }]);
});

test('Files tree vs main: letters only, rename on the new path with oldPath', async () => {
  const repo = fixture();
  const t = await fileTree(repo);
  const e = byPath(t.files);
  assert.equal(e['moved/exact.md'].status, 'R');
  assert.equal(e['moved/exact.md'].oldPath, 'exact.md');
  assert.equal(e['moved/edited.md'].status, 'R');
  assert.equal(e['gone.md'].status, 'D');
  assert.equal(e['gone.md'].onDisk, false);
  assert.equal(e['untracked.txt'].status, '?');
  for (const f of t.files.filter((x) => x.status)) assert.match(f.status, /^[A-Z?]$/, `${f.path}: ${f.status}`);
});

test('Files tree vs the last commit: only what is not committed yet', async () => {
  const repo = fixture();
  const t = await fileTree(repo);
  const e = byPath(t.files);
  const changedHead = t.files.filter((f) => f.commitStatus).map((f) => `${f.commitStatus} ${f.path}`).sort();
  assert.deepEqual(changedHead, ['? untracked.txt', 'M mod.md', 'R moved/staged-move.md']);
  assert.equal(e['moved/staged-move.md'].commitOldPath, 'staged-move.md');
  assert.equal(e['moved/exact.md'].commitStatus, null, 'a rename already committed is not a change vs the last commit');
  assert.equal(e['gone.md'].status, 'D');
  assert.equal(e['gone.md'].commitStatus, null, 'a delete already committed is not a change vs the last commit');
});

test('Files tree: an uncommitted delete shows vs both; a file deleted after being added on the branch only vs the last commit', async () => {
  const repo = fixture();
  git(repo, ['rm', '-q', 'mod.md', '--force']);
  git(repo, ['rm', '-q', 'added.md']);
  const e = byPath((await fileTree(repo)).files);
  assert.equal(e['mod.md'].status, 'D');
  assert.equal(e['mod.md'].commitStatus, 'D');
  assert.equal(e['added.md'].status, null, 'added on the branch and deleted again: no difference vs main');
  assert.equal(e['added.md'].commitStatus, 'D');
});

test('Files tree vs an older commit: everything since it, committed or not; recent commits and main\'s tip listed', async () => {
  const repo = fixture();
  const baseSha = git(repo, ['rev-parse', 'HEAD~1']).trim();
  const t = await fileTree(repo, { commit: baseSha });
  const e = byPath(t.files);
  assert.equal(t.vsCommit, baseSha);
  assert.equal(e['moved/exact.md'].commitStatus, 'R', 'a rename committed after that commit counts');
  assert.equal(e['mod.md'].commitStatus, 'M');
  assert.equal(e['gone.md'].commitStatus, 'D');
  assert.deepEqual(t.commits.map((c) => c.subject), ['every shape', 'base']);
  assert.equal(t.mainCommit.subject, 'base');
  assert.equal(t.mainCommit.sha, baseSha);
});

test('wtDiff: an older commit as the base', async () => {
  const repo = fixture();
  const baseSha = git(repo, ['rev-parse', 'HEAD~1']).trim();
  assert.match(await wtDiff(repo, 'mod.md', { base: baseSha }), /-one\n\+three/);
});

test('wtDiff: vs the last commit shows only the uncommitted edit; a rename with from pairs both paths', async () => {
  const repo = fixture();
  const vsMain = await wtDiff(repo, 'mod.md');
  const vsCommit = await wtDiff(repo, 'mod.md', { base: 'head' });
  assert.match(vsMain, /-one\n\+three/);
  assert.match(vsCommit, /-two\n\+three/);
  const paired = await wtDiff(repo, 'moved/edited.md', { from: 'edited.md' });
  assert.match(paired, /rename from edited\.md/);
  assert.match(paired, /\+one more/);
  assert.doesNotMatch(paired, /new file mode/);
});

test('store view uncommitted list reads through the same porcelain reader', () => {
  const repo = fixture();
  const e = byPath(pendingEntries(repo));
  assert.equal(e['mod.md'].status, 'M');
  assert.equal(e['moved/staged-move.md'].status, 'R');
  assert.ok(!('staged-move.md' in e), 'the old path of a rename is not listed as its own entry');
  assert.equal(e['untracked.txt'].status, '?');
});
