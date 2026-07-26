// test/axes.test.mjs — the label-axis registry (task 096). Covers resolveAxes'
// shared+project overlay (project-wins name-replace-in-slot + append), the
// first-wins axisLookup, color defaulting, malformed-file tolerance, the empty
// case (→ flat), registeredLabels, and the idempotent seedSharedAxes.
//
// COGYARD_HOME is redirected to a throwaway temp dir BEFORE importing (paths.mjs
// resolves it at import). The Node runner isolates each file in its own process,
// so the real ~/.cogyard is never touched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-axes-'));
process.env.COGYARD_HOME = HOME;
const SHARED = join(HOME, 'axes.json');

const { resolveAxes, axisLookup, registeredLabels, seedSharedAxes, DEFAULT_SHARED_AXES,
  readSharedAxes, readProjectAxes, sanitizeAxes, writeSharedAxes, writeProjectAxes } =
  await import('../core/axes.mjs');

// A throwaway "project" dir with its axis map in its task store (_tasks/axes.json).
const PROJ = mkdtempSync(join(tmpdir(), 'cogyard-axproj-'));
mkdirSync(join(PROJ, '_tasks'), { recursive: true });
const PROJ_AXES = join(PROJ, '_tasks', 'axes.json');

const writeShared = (obj) => writeFileSync(SHARED, JSON.stringify(obj));
const writeProject = (obj) => writeFileSync(PROJ_AXES, JSON.stringify(obj));
const clearShared = () => { if (existsSync(SHARED)) rmSync(SHARED); };
const clearProject = () => { if (existsSync(PROJ_AXES)) rmSync(PROJ_AXES); };

before(() => { clearShared(); clearProject(); });
after(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(PROJ, { recursive: true, force: true }); });

test('no files anywhere → [] (portal then renders flat)', () => {
  clearShared(); clearProject();
  assert.deepEqual(resolveAxes(PROJ), []);
  assert.deepEqual(resolveAxes(null), []);
});

test('shared only → shared axes pass through', () => {
  clearProject();
  writeShared({ axes: [{ name: 'Surface', color: '#4f8cff', labels: ['frontend', 'db'] }] });
  const r = resolveAxes(PROJ);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { name: 'Surface', color: '#4f8cff', labels: ['frontend', 'db'] });
  clearShared();
});

test('project axis of the same name REPLACES the shared one in its slot; new axes append', () => {
  writeShared({ axes: [
    { name: 'Surface', color: '#4f8cff', labels: ['frontend', 'db'] },
    { name: 'Phase', color: '#a06bff', labels: ['p1', 'p2'] },
  ] });
  writeProject({ axes: [
    { name: 'Surface', color: '#111111', labels: ['frontend', 'server'] }, // replaces (db dropped)
    { name: 'Pipeline', color: '#2fae7a', labels: ['voice'] },              // appends
  ] });
  const names = resolveAxes(PROJ).map((a) => a.name);
  assert.deepEqual(names, ['Surface', 'Phase', 'Pipeline']); // Surface keeps slot 0, Pipeline last
  const surface = resolveAxes(PROJ)[0];
  assert.deepEqual(surface.labels, ['frontend', 'server']); // project labels won; db is gone
  assert.equal(surface.color, '#111111');
  clearShared(); clearProject();
});

test('axisLookup is first-wins in resolved order; a project-dropped label is Ungrouped', () => {
  writeShared({ axes: [{ name: 'Surface', labels: ['frontend', 'db'] }] });
  writeProject({ axes: [
    { name: 'Surface', labels: ['frontend'] },      // replaces → db no longer mapped
    { name: 'Pipeline', labels: ['frontend', 'x'] }, // also lists frontend, but Surface is earlier
  ] });
  const lu = axisLookup(resolveAxes(PROJ));
  assert.equal(lu.frontend.axis, 'Surface'); // first-wins
  assert.equal(lu.x.axis, 'Pipeline');
  assert.equal(lu.db, undefined);            // dropped by the project override → Ungrouped
  clearShared(); clearProject();
});

test('a row missing color gets the neutral default; bad rows are dropped', () => {
  writeShared({ axes: [
    { name: 'NoColor', labels: ['a'] },
    { name: '', labels: ['bad'] },   // empty name → dropped
    { labels: ['x'] },               // no name → dropped
    'garbage',                       // not an object → dropped
  ] });
  const r = resolveAxes(PROJ);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'NoColor');
  assert.equal(r[0].color, '#8a8f98'); // neutral default
  clearShared();
});

test('malformed / non-object file → that layer contributes nothing (never throws)', () => {
  writeShared('{not json');
  assert.deepEqual(resolveAxes(PROJ), []);
  writeShared({ axes: 'not-an-array' });
  assert.deepEqual(resolveAxes(PROJ), []);
  writeShared([1, 2, 3]); // top-level array, no .axes
  assert.deepEqual(resolveAxes(PROJ), []);
  clearShared();
});

test('registeredLabels is the flat union across resolved axes', () => {
  writeShared({ axes: [{ name: 'A', labels: ['x', 'y'] }, { name: 'B', labels: ['y', 'z'] }] });
  assert.deepEqual([...registeredLabels(resolveAxes(PROJ))].sort(), ['x', 'y', 'z']);
  clearShared();
});

test('seedSharedAxes writes the Surface default when absent, and never clobbers an existing file', () => {
  clearShared();
  const seeded = seedSharedAxes();
  assert.deepEqual(seeded, DEFAULT_SHARED_AXES);
  assert.ok(existsSync(SHARED));
  // Second call must not overwrite a customized file.
  writeShared({ axes: [{ name: 'Custom', labels: ['q'] }] });
  seedSharedAxes();
  assert.equal(JSON.parse(readFileSync(SHARED, 'utf8')).axes[0].name, 'Custom');
  clearShared();
});

// --- the manager's per-layer raw reads + writes (Phase 4) --------------------

test('sanitizeAxes cleans an untrusted list the same way reads do', () => {
  assert.deepEqual(sanitizeAxes('not an array'), []);
  const out = sanitizeAxes([{ name: ' A ', color: '#fff', labels: ['x', 'x', 5, ''] }, { labels: ['y'] }]);
  assert.deepEqual(out, [{ name: 'A', color: '#fff', labels: ['x'] }]); // trimmed name, deduped, bad row dropped
});

test('writeSharedAxes round-trips through readSharedAxes and drops a null color from disk', () => {
  clearShared();
  writeSharedAxes([{ name: 'Surface', color: '#4f8cff', labels: ['a'] }, { name: 'Plain', labels: ['b'] }]);
  const raw = JSON.parse(readFileSync(SHARED, 'utf8'));
  assert.equal(raw.axes[0].color, '#4f8cff');
  assert.equal('color' in raw.axes[1], false); // null color omitted from the file
  assert.deepEqual(readSharedAxes().map((a) => a.name), ['Surface', 'Plain']);
  clearShared();
});

test('writeProjectAxes persists to _tasks/ and readProjectAxes reads it back', () => {
  clearProject();
  assert.deepEqual(readProjectAxes(PROJ), []);
  writeProjectAxes(PROJ, [{ name: 'Domain', color: '#2fae7a', labels: ['w'] }]);
  assert.deepEqual(readProjectAxes(PROJ), [{ name: 'Domain', color: '#2fae7a', labels: ['w'] }]);
  clearProject();
});
