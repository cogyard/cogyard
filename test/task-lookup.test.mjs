// test/task-lookup.test.mjs — resolveTask, the authoritative id→file lookup that
// `tasks find`, `drift`, `claim` and `release` all resolve through, and that
// pickup-task calls to turn "do task NNN" into a path.
//
// The bug this exists to prevent (task 116): resolveTask compared raw strings, so
// `find 033` missed a store that writes `id: 33` and `find 33` missed one that
// writes `id: 003` — and the projects genuinely disagree, so BOTH directions were
// live failures. Zero-padding is not part of a task's identity; every case below
// asserts the same file comes back regardless of how the id is spelled.
//
// Fixtures are real files on disk because resolveTask reads them through
// loadTasks. Importing cli/tasks.mjs runs nothing — its dispatch is behind an
// __isCLI guard.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveTask, findTaskFile } from '../cli/tasks.mjs';

// A task file whose frontmatter id is written EXACTLY as given — the point of
// these fixtures is that stores spell the same id differently.
function writeTask(dir, filename, id, slug) {
  writeFileSync(join(dir, filename), [
    '---', `id: ${id}`, `slug: ${slug}`, `title: ${slug}`,
    'status: OPEN', 'type: bug', '---', '', `# ${id}: ${slug}`, '',
  ].join('\n'));
}

// Two stores, same tasks, opposite padding conventions in frontmatter.
const UNPADDED = mkdtempSync(join(tmpdir(), 'cogyard-lookup-unpadded-'));
const PADDED = mkdtempSync(join(tmpdir(), 'cogyard-lookup-padded-'));
mkdirSync(UNPADDED, { recursive: true });
mkdirSync(PADDED, { recursive: true });
// The common shape (cogyard's own): padded filename, bare id.
writeTask(UNPADDED, '033-series-page.md', '33', 'series-page');
writeTask(UNPADDED, '003-early-one.md', '3', 'early-one');
// The other shape some projects use: padded filename AND padded id.
writeTask(PADDED, '033-document-processing.md', '033', 'document-processing');
writeTask(PADDED, '003-mobile-responsiveness.md', '003', 'mobile-responsiveness');

after(() => {
  rmSync(UNPADDED, { recursive: true, force: true });
  rmSync(PADDED, { recursive: true, force: true });
});

const found = (dir, want) => {
  const t = resolveTask(dir, want);
  return t ? basename(t.path) : null;
};

test('unpadded store (`id: 33`): every spelling of 33 resolves', () => {
  for (const want of ['33', '033', '0033']) {
    assert.equal(found(UNPADDED, want), '033-series-page.md', `spelling: ${want}`);
  }
});

test('padded store (`id: 003`): every spelling of 3 resolves', () => {
  for (const want of ['3', '03', '003']) {
    assert.equal(found(PADDED, want), '003-mobile-responsiveness.md', `spelling: ${want}`);
  }
});

test('the two live failures from the field, one per direction', () => {
  // `cogyard tasks find 033` in a project whose frontmatter says `id: 33`.
  assert.equal(found(UNPADDED, '033'), '033-series-page.md');
  // ...and the mirror: `find 33` where the frontmatter says `id: 033`.
  assert.equal(found(PADDED, '33'), '033-document-processing.md');
});

test('slug and full filename stem still resolve', () => {
  assert.equal(found(UNPADDED, 'series-page'), '033-series-page.md');
  assert.equal(found(UNPADDED, '033-series-page'), '033-series-page.md');
  assert.equal(found(UNPADDED, '033-series-page.md'), '033-series-page.md');
});

test('padding never collapses distinct ids', () => {
  // 3 and 33 are different tasks; no amount of zero-stripping may confuse them.
  assert.equal(found(UNPADDED, '3'), '003-early-one.md');
  assert.equal(found(UNPADDED, '33'), '033-series-page.md');
});

test('a genuinely absent id resolves to nothing', () => {
  assert.equal(found(UNPADDED, '999'), null);
  assert.equal(found(UNPADDED, 'no-such-slug'), null);
});

test('the filename id token is a match even when frontmatter has no id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cogyard-lookup-noid-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '007-legacy.md'), '# 007: legacy, no frontmatter\n');
  assert.equal(found(dir, '7'), '007-legacy.md');
  assert.equal(found(dir, '007'), '007-legacy.md');
});

// Task 158: `find` prints the REAL path. Sessions edit whatever it prints, and
// Claude Code treats a write whose `.cogyard/tasks` link resolves outside the working
// directory as out of bounds (prompt in a checkout, refusal in a worktree).
test('findTaskFile: a linked store resolves to the store path, not <repo>/.cogyard/tasks/…', () => {
  const root = mkdtempSync(join(tmpdir(), 'cogyard-find-linked-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, 'store');
  const repo = join(root, 'repo');
  mkdirSync(store);
  mkdirSync(repo);
  writeTask(store, '033-series-page.md', '33', 'series-page');
  mkdirSync(join(repo, '.cogyard'), { recursive: true });
  symlinkSync(store, join(repo, '.cogyard', 'tasks'));
  assert.equal(findTaskFile(repo, '33'), join(realpathSync(store), '033-series-page.md'));
});

test('findTaskFile: a normal task directory gives the same path it always did', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-find-plain-')));
  after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, '.cogyard', 'tasks'), { recursive: true });
  writeTask(join(repo, '.cogyard', 'tasks'), '033-series-page.md', '33', 'series-page');
  assert.equal(findTaskFile(repo, '33'), join(repo, '.cogyard', 'tasks', '033-series-page.md'));
  assert.equal(findTaskFile(repo, '999'), null);
});
