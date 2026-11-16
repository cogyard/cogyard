// test/scaffold-version-stamp.test.mjs — a kind chooses how it stamps (task 162).
//
// `versionStamp` on a scaffold descriptor: true = the npm stamper
// (scripts/generate-version.mjs → version.json, what every kind got before);
// false = none; a function (slug) => ({ relPath: content }) = the kind's own
// stamping files, seeded INSTEAD of the npm one — the room an Xcode or firmware
// kind needs. Runs the real wiring engine against throwaway dirs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-stamp-')));
const HOME = join(ROOT, 'home');
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = PROJECTS;

function install(kind, body) {
  mkdirSync(join(HOME, 'scaffolds', kind), { recursive: true });
  writeFileSync(join(HOME, 'scaffolds', kind, 'scaffold.mjs'), `export const scaffold = {
  kind: '${kind}', description: '${kind}', worktreePorts: false,
  pkgJson(slug) { return { name: slug, version: '0.1.0' }; },
  skeletonFiles(slug) { return { 'README.md': '# ' + slug }; },
  ${body}
};
`);
}
install('stub-header', `versionStamp(slug) {
    return { 'scripts/stamp-header.sh': '#!/bin/sh\\n# writes include/version.h for ' + slug + '\\n' };
  },`);
install('stub-default', 'versionStamp: true,');
install('stub-empty', 'versionStamp() { return {}; },');
install('bad-stamp', "versionStamp: 'plist',");

const { ensureProjectWiring } = await import('../core/scaffold.mjs');
const { KINDS } = await import('../core/scaffolds/index.mjs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

function wire(kind, { scaffold = true } = {}) {
  const dir = join(PROJECTS, `demo-${kind}-${scaffold ? 'init' : 'onboard'}`);
  mkdirSync(dir, { recursive: true });
  const r = ensureProjectWiring({ path: dir, kind, scaffold });
  return { dir, steps: r.steps };
}

test('a stub strategy has its files seeded and no npm stamper is written', () => {
  const { dir } = wire('stub-header');
  assert.equal(readFileSync(join(dir, 'scripts/stamp-header.sh'), 'utf8'),
    '#!/bin/sh\n# writes include/version.h for demo-stub-header-init\n');
  assert.equal(existsSync(join(dir, 'scripts/generate-version.mjs')), false);
});

test('the strategy runs on onboard too, like the npm stamper always has', () => {
  const { dir } = wire('stub-header', { scaffold: false });
  assert.ok(existsSync(join(dir, 'scripts/stamp-header.sh')));
  assert.equal(existsSync(join(dir, 'scripts/generate-version.mjs')), false);
});

test('true is the default strategy: scripts/generate-version.mjs', () => {
  const { dir } = wire('stub-default');
  assert.match(readFileSync(join(dir, 'scripts/generate-version.mjs'), 'utf8'), /version\.json/);
});

test('a strategy that seeds nothing says so and writes no npm stamper', () => {
  const { dir, steps } = wire('stub-empty');
  assert.equal(existsSync(join(dir, 'scripts/generate-version.mjs')), false);
  assert.ok(steps.some((s) => s.step === 'version stamp' && s.status === 'skipped'));
});

test('a drop-in whose versionStamp is neither boolean nor function is skipped as broken', () => {
  assert.equal(KINDS.includes('bad-stamp'), false);
});
