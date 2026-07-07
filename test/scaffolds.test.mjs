// test/scaffolds.test.mjs — the project-kind (scaffold) registry.
// Covers built-in kinds, external drop-in discovery, the additions-only rule
// (a drop-in can't shadow a built-in), and descriptor content parity with what
// core/scaffold.mjs used to hardcode.
//
// COGYARD_HOME is pointed at a throwaway temp dir BEFORE importing the module
// (same pattern as config.test.mjs / addons.test.mjs; per-file process isolation).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-scaffolds-'));
process.env.COGYARD_HOME = HOME;
const DIR = join(HOME, 'scaffolds');

// Install external drop-ins BEFORE importing (the registry resolves at import).
function install(kind, source) {
  mkdirSync(join(DIR, kind), { recursive: true });
  writeFileSync(join(DIR, kind, 'scaffold.mjs'), source);
}
install('site-eleventy', `
export const scaffold = {
  kind: 'site-eleventy',
  description: 'Eleventy static site',
  worktreePorts: true,
  versionStamp: true,
  pkgJson(slug) { return { name: slug, version: '0.1.0' }; },
  skeletonFiles(slug) { return { 'README.md': '# ' + slug }; },
};
`);
// Tries to shadow a built-in — must be ignored (additions only).
install('single', `
export const scaffold = {
  kind: 'single',
  description: 'EVIL OVERRIDE',
  pkgJson() { return {}; },
  skeletonFiles() { return {}; },
};
`);
// Broken drop-in — must be skipped, not crash the import.
install('broken', 'export const scaffold = { kind: "mismatch" };');

const { KINDS, scaffoldFor, scaffoldKinds } = await import('../core/scaffolds/index.mjs');

after(() => rmSync(HOME, { recursive: true, force: true }));

test('built-ins ship in core, external drop-in is added, broken is skipped', () => {
  assert.deepEqual(KINDS, ['single', 'fullstack', 'static', 'library', 'site-eleventy']);
});

test('a drop-in cannot shadow a built-in kind', () => {
  assert.notEqual(scaffoldFor('single').description, 'EVIL OVERRIDE');
  assert.equal(scaffoldFor('single').builtin, true);
});

test('scaffoldKinds: wire-safe rows with descriptions', () => {
  const rows = scaffoldKinds();
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.equal(typeof r.kind, 'string');
    assert.ok(r.description.length > 0, `${r.kind} needs a description`);
    assert.equal(typeof r.builtin, 'boolean');
  }
  assert.deepEqual(rows.find((r) => r.kind === 'site-eleventy'),
    { kind: 'site-eleventy', description: 'Eleventy static site', builtin: false });
});

test('unknown kind throws with the full registry list', () => {
  assert.throws(() => scaffoldFor('nope'), /unknown kind: nope.*site-eleventy/);
});

test('descriptor parity with the former hardcoded branches', () => {
  // static seeds a working dev script bound to the reserved port; Model 3 = pure
  // wiring, so the skeleton is a README only (no index.html / app files).
  const st = scaffoldFor('static');
  assert.match(st.pkgJson('demo').scripts.dev, /FRONTEND_PORT/);
  const stFiles = st.skeletonFiles('demo');
  assert.deepEqual(Object.keys(stFiles), ['README.md']);
  assert.equal(stFiles['index.html'], undefined);
  assert.ok(stFiles['README.md'].includes('scaffold'));
  // library: public, no version stamp, no worktree ports, src entry via pkg.main
  const lib = scaffoldFor('library');
  const libPkg = lib.pkgJson('demo');
  assert.equal(libPkg.private, undefined);
  assert.equal(libPkg.main, 'src/index.mjs');
  assert.equal(lib.versionStamp, false);
  assert.equal(lib.worktreePorts, false);
  // single: private with the generate-version script
  const single = scaffoldFor('single');
  assert.equal(single.pkgJson('demo').private, true);
  assert.match(single.pkgJson('demo').scripts['generate-version'], /generate-version/);
});
