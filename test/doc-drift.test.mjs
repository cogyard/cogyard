// test/doc-drift.test.mjs — the doc-drift candidate query (core/doc-drift.mjs).
//
// Two halves. The path-matching helpers are pure and tested directly. The query
// itself is tested integration-style against a real throwaway git repo with
// dated commits, because git history IS the input — a mocked log would only
// prove the mock behaves.
//
// The cases that matter are the NEGATIVE ones. A drift report that cries wolf is
// a report the owner stops reading, so "a doc updated after the work is not
// flagged", "one task is not enough", "yesterday's churn is not drift", and
// "a sweep declaration proves nothing" each get their own test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  globToRe, entryCovers, entryNamesDoc, isSpecificArea, isProsePath,
  taskDeclarations, hubPaths, areaFor, docDriftCandidates,
} from '../core/doc-drift.mjs';

// --- pure helpers -------------------------------------------------------------

test('glob matching: ** spans separators, * does not', () => {
  assert.ok(globToRe('docs/**/*.md').test('docs/ADDONS.md'));       // ** may match nothing
  assert.ok(globToRe('docs/**/*.md').test('docs/deep/nest/A.md'));
  assert.ok(globToRe('docs/*.md').test('docs/A.md'));
  assert.equal(globToRe('docs/*.md').test('docs/deep/A.md'), false);
  assert.equal(globToRe('CLAUDE.md').test('docs/CLAUDE.md'), false);
});

test('entryCovers accepts the three ways touches_paths are written', () => {
  assert.ok(entryCovers('core/addons/', 'core/addons/index.mjs'));  // trailing slash
  assert.ok(entryCovers('core/addons', 'core/addons/index.mjs'));   // bare dir
  assert.ok(entryCovers('core/addons/index.mjs', 'core/addons/index.mjs'));
  assert.ok(entryCovers('frontend/src/**', 'frontend/src/app/x.ts'));
  assert.equal(entryCovers('~/.claude/CLAUDE.md', 'CLAUDE.md'), false); // outside the repo
  assert.equal(entryCovers('core/addons', 'core/addons-extra.mjs'), false); // prefix, not parent
});

test('a doc must be NAMED to be associated — a directory entry is not a claim', () => {
  assert.ok(entryNamesDoc('docs/ADDONS.md', 'docs/ADDONS.md'));
  assert.ok(entryNamesDoc('docs/*.md', 'docs/ADDONS.md'));
  // The bug this rule exists for: `docs/` covers the file, but says nothing
  // about which doc the task maintains.
  assert.equal(entryNamesDoc('docs/', 'docs/ADDONS.md'), false);
  assert.equal(entryNamesDoc('docs', 'docs/ADDONS.md'), false);
  assert.equal(entryNamesDoc('frontend/**', 'docs/ADDONS.md'), false);
});

test('an area path is specific: a top-level directory is the codebase, not an area', () => {
  assert.ok(isSpecificArea('core/addons/'));
  assert.ok(isSpecificArea('package.json'));
  assert.equal(isSpecificArea('core/'), false);
  assert.equal(isSpecificArea('test'), false);
  assert.ok(isProsePath('docs/A.md'));
  assert.equal(isProsePath('core/a.mjs'), false);
});

// --- fixture repo -------------------------------------------------------------

let ROOT;
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=x', ...args], { encoding: 'utf8' });

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);
const at = (days) => new Date(T0 + days * DAY).toISOString();

function write(dir, rel, body) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

// One commit, at a controlled date so age-gap assertions don't depend on when
// the suite runs.
function commit(dir, message, days) {
  git(dir, 'add', '-A');
  execFileSync('git', [
    '-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=x',
    'commit', '-q', '-m', message,
  ], { env: { ...process.env, GIT_AUTHOR_DATE: at(days), GIT_COMMITTER_DATE: at(days) } });
}

function task(dir, id, { title = `task ${id}`, status = 'DONE', paths = [] }) {
  const list = paths.map((p) => `  - ${p}`).join('\n');
  write(dir, `.cogyard/tasks/${String(id).padStart(3, '0')}-t.md`, [
    '---', `id: ${id}`, `slug: t${id}`, `title: ${title}`, `status: ${status}`,
    'touches_paths:', list, '---', '', `# ${id}`, '',
  ].join('\n'));
}

// A repo where docs/AREA.md is declared by two tasks alongside core/thing/, and
// both tasks then land commits in that area 40+ days later.
function repoWithDrift(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'docs/AREA.md', 'the area works like this\n');
  write(dir, 'docs/QUIET.md', 'nothing has happened here\n');
  write(dir, 'core/thing/index.mjs', 'export const a = 1;\n');
  write(dir, 'core/other/index.mjs', 'export const b = 1;\n');
  task(dir, 11, { paths: ['core/thing/', 'docs/AREA.md'] });
  task(dir, 12, { paths: ['core/thing/index.mjs', 'docs/AREA.md'] });
  task(dir, 13, { paths: ['core/other/', 'docs/QUIET.md'] });
  commit(dir, 'init', 0);

  write(dir, 'core/thing/index.mjs', 'export const a = 2;\n');
  commit(dir, '[#11] feat(thing): reshape it', 40);
  write(dir, 'core/thing/index.mjs', 'export const a = 3;\n');
  commit(dir, '[#12] feat(thing): reshape it again', 45);
  return dir;
}

before(() => { ROOT = mkdtempSync(join(tmpdir(), 'cogyard-docdrift-')); });
after(() => { rmSync(ROOT, { recursive: true, force: true }); });

// --- the query ----------------------------------------------------------------

test('known drift is found, with the tasks that contradict it', async () => {
  const dir = repoWithDrift('drift');
  const r = await docDriftCandidates(dir, { now: new Date(at(50)) });

  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.equal(c.doc, 'docs/AREA.md');
  assert.deepEqual(c.tasks.map((t) => t.id), [11, 12]);
  assert.equal(c.taskCount, 2);
  assert.equal(c.ageDays, 45);            // doc at day 0, newest contradicting commit at day 45
  assert.ok(c.area.includes('core/thing/'));
  assert.deepEqual(c.declaredBy, [11, 12]);
});

test('a doc with no work in its area is not a candidate', async () => {
  const dir = repoWithDrift('quiet');
  const r = await docDriftCandidates(dir, { now: new Date(at(50)) });
  assert.equal(r.candidates.find((c) => c.doc === 'docs/QUIET.md'), undefined);
  assert.ok(r.docsAssociated >= 2); // it WAS examined and associated — just not stale
});

test('a doc updated after the tasks that touched its area is not flagged', async () => {
  const dir = repoWithDrift('updated');
  write(dir, 'docs/AREA.md', 'the area works like this, revised\n');
  commit(dir, 'docs: refresh AREA for the new shape', 46);
  const r = await docDriftCandidates(dir, { now: new Date(at(50)) });
  assert.deepEqual(r.candidates, []);
});

test('one contradicting task is below the threshold', async () => {
  const dir = repoWithDrift('one-task');
  const r = await docDriftCandidates(dir, { minTasks: 3, now: new Date(at(50)) });
  assert.deepEqual(r.candidates, []);
});

test('recent churn is not drift — the age gap has to be real', async () => {
  const dir = repoWithDrift('recent');
  const r = await docDriftCandidates(dir, { minAgeDays: 60, now: new Date(at(50)) });
  assert.deepEqual(r.candidates, []);
});

test('unattributed commits are counted but never satisfy the threshold', async () => {
  const dir = join(ROOT, 'unattributed');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'docs/AREA.md', 'prose\n');
  write(dir, 'core/thing/index.mjs', 'export const a = 1;\n');
  task(dir, 11, { paths: ['core/thing/', 'docs/AREA.md'] });
  task(dir, 12, { paths: ['core/thing/', 'docs/AREA.md'] });
  commit(dir, 'init', 0);
  write(dir, 'core/thing/index.mjs', 'export const a = 2;\n');
  commit(dir, 'refactor: no task prefix', 40);
  write(dir, 'core/thing/index.mjs', 'export const a = 3;\n');
  commit(dir, 'refactor: still no task prefix', 45);

  const r = await docDriftCandidates(dir, { now: new Date(at(50)) });
  assert.deepEqual(r.candidates, []);
});

test('task files are never treated as docs', async () => {
  const dir = repoWithDrift('tasks-not-docs');
  const r = await docDriftCandidates(dir, { docGlobs: ['**/*.md'], minTasks: 1, minAgeDays: 0, now: new Date(at(50)) });
  assert.equal(r.candidates.some((c) => c.doc.startsWith('.cogyard/tasks/')), false);
});

// --- what a declaration is allowed to contribute -------------------------------

test('a sweeping declaration contributes no area', () => {
  const decls = [{ id: 1, title: '', status: 'DONE', paths: [...Array(20).keys()].map((i) => `pkg/m${i}/x.mjs`).concat('docs/A.md') }];
  assert.deepEqual(areaFor('docs/A.md', decls).area, []);
});

test('hub paths are dropped from every area', () => {
  // 10 tasks, 8 of them touching server/index.mjs: it identifies nothing.
  const decls = [];
  for (let i = 1; i <= 8; i++) decls.push({ id: i, title: '', status: 'DONE', paths: ['server/index.mjs', 'docs/A.md'] });
  decls.push({ id: 9, title: '', status: 'DONE', paths: ['server/index.mjs', 'core/rare/x.mjs', 'docs/A.md'] });
  decls.push({ id: 10, title: '', status: 'DONE', paths: ['core/rare/x.mjs'] });

  const hubs = hubPaths(decls);
  assert.ok(hubs.has('server/index.mjs'));
  assert.equal(hubs.has('core/rare/x.mjs'), false);
  assert.deepEqual(areaFor('docs/A.md', decls, hubs).area, ['core/rare/x.mjs']);
});

test('taskDeclarations reads real task files and drops paths outside the repo', () => {
  const dir = join(ROOT, 'decls');
  mkdirSync(join(dir, '.cogyard', 'tasks'), { recursive: true });
  task(dir, 7, { paths: ['core/a.mjs', '"~/.claude/CLAUDE.md"', 'docs/A.md'] });
  const rows = taskDeclarations(join(dir, '.cogyard', 'tasks'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 7);
  assert.equal(rows[0].paths.some((p) => p.includes('.claude/CLAUDE.md')), false);
});
