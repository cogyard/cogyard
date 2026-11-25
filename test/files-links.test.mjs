// test/files-links.test.mjs — links in the Files tab (task 269): the tree
// list marks each link with `link: { target, kind, inside }`, always lists the
// task link `.cogyard/tasks` (gitignored, so the plain listing used to leave it
// out), and /api/file describes a link it can't show as a file — to a folder,
// broken, or leading outside the worktree — instead of refusing it, without
// ever reading inside the target.
//
// COGYARD_HOME points at a throwaway dir BEFORE core is imported.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-links-home-')));
process.env.COGYARD_HOME = HOME;
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-links-proj-')));
const STORE = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-links-store-')));
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-links-outside-')));
after(() => { for (const d of [HOME, PROJ, STORE, OUTSIDE]) rmSync(d, { recursive: true, force: true }); });

const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: PROJ });
git('init', '-q', '-b', 'main');
mkdirSync(join(PROJ, 'docs'), { recursive: true });
mkdirSync(join(PROJ, 'bin'), { recursive: true });
mkdirSync(join(PROJ, '.cogyard'), { recursive: true });
writeFileSync(join(PROJ, 'docs', 'real.md'), '# real\n');
writeFileSync(join(PROJ, '.cogyard', '.gitignore'), '/tasks\n');
writeFileSync(join(STORE, '001-a-task.md'), 'secret task text\n');
writeFileSync(join(OUTSIDE, 'secret.txt'), 'outside\n');
symlinkSync(STORE, join(PROJ, '.cogyard', 'tasks'));                     // the task link: a folder outside
symlinkSync('../docs/real.md', join(PROJ, 'bin', 'real-link.md'));       // a file inside (relative)
symlinkSync('../docs', join(PROJ, 'bin', 'docs-link'));                  // a folder inside
symlinkSync(join(OUTSIDE, 'secret.txt'), join(PROJ, 'bin', 'out-file')); // a file outside
symlinkSync('../nowhere/gone.js', join(PROJ, 'bin', 'broken'));          // nothing there
git('add', 'docs', '.cogyard/.gitignore', 'bin/real-link.md');
git('commit', '-q', '-m', 'init');

const { fileTree, readWorkFile } = await import('../server/files.mjs');
const byPath = (t) => new Map(t.files.map((f) => [f.path, f]));

test('the plain listing marks links and always lists the task link', async () => {
  const files = byPath(await fileTree(PROJ));
  assert.deepEqual(files.get('.cogyard/tasks')?.link, { target: STORE, display: STORE, kind: 'dir', inside: false });
  assert.equal(files.get('.cogyard/tasks').tracked, false);
  assert.equal(files.get('.cogyard/tasks').status, null, 'gitignored: not a change');
  assert.deepEqual(files.get('bin/real-link.md')?.link, { target: '../docs/real.md', display: '../docs/real.md', kind: 'file', inside: true });
  assert.deepEqual(files.get('bin/docs-link')?.link, { target: '../docs', display: '../docs', kind: 'dir', inside: true });
  assert.deepEqual(files.get('bin/out-file')?.link, { target: join(OUTSIDE, 'secret.txt'), display: join(OUTSIDE, 'secret.txt'), kind: 'file', inside: false });
  assert.deepEqual(files.get('bin/broken')?.link, { target: '../nowhere/gone.js', display: '../nowhere/gone.js', kind: 'broken', inside: true });
  assert.equal(files.get('docs/real.md')?.link, undefined, 'a plain file carries no link');
  assert.equal([...files.keys()].filter((p) => p.startsWith('.cogyard/tasks/')).length, 0, 'never lists inside the store');
});

test('the gitignored listing lists the task link once, marked', async () => {
  const t = await fileTree(PROJ, { ignored: true });
  const tl = t.files.filter((f) => f.path === '.cogyard/tasks');
  assert.equal(tl.length, 1);
  assert.equal(tl[0].link.kind, 'dir');
});

test('a link that is not a plain file inside the worktree is described, never read', () => {
  for (const [rel, kind, inside] of [['.cogyard/tasks', 'dir', false], ['bin/docs-link', 'dir', true], ['bin/out-file', 'file', false], ['bin/broken', 'broken', true]]) {
    const r = readWorkFile(PROJ, rel);
    assert.deepEqual(Object.keys(r), ['meta'], rel);
    assert.equal(r.meta.content, undefined, `${rel}: no content`);
    assert.equal(r.meta.size, 0);
    assert.equal(r.meta.link.kind, kind, rel);
    assert.equal(r.meta.link.inside, inside, rel);
  }
});

test('a link to a file inside the worktree reads as before, plus link', () => {
  const r = readWorkFile(PROJ, 'bin/real-link.md');
  assert.equal(r.meta.content, '# real\n');
  assert.ok(r.meta.hash);
  assert.deepEqual(r.meta.link, { target: '../docs/real.md', display: '../docs/real.md', kind: 'file', inside: true });
  assert.equal(readWorkFile(PROJ, 'docs/real.md').meta.link, undefined);
});

test('an absolute target under the home folder prints as ~/…', async () => {
  const { homedir } = await import('node:os');
  const underHome = mkdtempSync(join(homedir(), '.cogyard-links-test-'));
  try {
    symlinkSync(underHome, join(PROJ, 'bin', 'home-link'));
    const l = byPath(await fileTree(PROJ)).get('bin/home-link').link;
    assert.equal(l.target, underHome);
    assert.equal(l.display, '~' + underHome.slice(homedir().length));
  } finally {
    rmSync(join(PROJ, 'bin', 'home-link'), { force: true });
    rmSync(underHome, { recursive: true, force: true });
  }
});

test('a path THROUGH a link that leads outside stays refused', () => {
  assert.deepEqual(readWorkFile(PROJ, '.cogyard/tasks/001-a-task.md'), { forbidden: true });
});
