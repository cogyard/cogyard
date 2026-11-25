// test/scaffold-kind-fields.test.mjs — what a kind may add beyond the npm defaults.
//
// Three descriptor fields, each optional:
//   * `gitignore`        lines appended to .gitignore with the essentials (a file
//                        the kind generates on every build);
//   * `requiredScripts`  package.json scripts the kind's files rely on. An existing
//                        package.json is never edited, so onboard warns for each one
//                        it lacks or has differently, giving the exact line to add;
//   * `versionStamp`     as a function, it is told the package.json version on disk,
//                        so a file committed with the version in it is seeded right.
// Runs the real wiring engine against throwaway dirs; COGYARD_HOME and
// COGYARD_PROJECTS_ROOT are set BEFORE import (the registry resolves at import).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-kind-fields-')));
const HOME = join(ROOT, 'home');
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = PROJECTS;

function install(kind, body) {
  mkdirSync(join(HOME, 'scaffolds', kind), { recursive: true });
  writeFileSync(join(HOME, 'scaffolds', kind, 'scaffold.mjs'), `export const scaffold = {
  kind: '${kind}', description: '${kind}', worktreePorts: false,
  skeletonFiles() { return {}; },
  ${body}
};
`);
}
install('stub-fields', `
  gitignore: ['Build.stamp', 'node_modules'],
  requiredScripts: ['build', 'version'],
  pkgJson(slug) { return { name: slug, version: '0.1.0', scripts: { build: 'sh build.sh', version: 'sh stamp.sh' } }; },
  versionStamp(slug, { version } = {}) {
    return version ? { 'stamp.sh': '# stamps ' + version + '\\n' } : {};
  },`);
install('bad-gitignore', "gitignore: 'Build.stamp', pkgJson(slug) { return { name: slug }; },");
install('bad-required', "requiredScripts: [''], pkgJson(slug) { return { name: slug }; },");

const { ensureProjectWiring } = await import('../core/scaffold.mjs');
const { KINDS } = await import('../core/scaffolds/index.mjs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
function project(pkg) {
  const dir = join(PROJECTS, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  return dir;
}

test('the kind\'s gitignore lines are appended once, beside the essentials', () => {
  const dir = project();
  ensureProjectWiring({ path: dir, kind: 'stub-fields', scaffold: true });
  const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
  assert.ok(lines.includes('Build.stamp'));
  assert.equal(lines.filter((l) => l === 'node_modules').length, 1, 'a line the essentials already have is not repeated');
});

test('init: versionStamp is told the version it just wrote', () => {
  const dir = project();
  ensureProjectWiring({ path: dir, kind: 'stub-fields', scaffold: true });
  assert.equal(readFileSync(join(dir, 'stamp.sh'), 'utf8'), '# stamps 0.1.0\n');
});

test('onboard: versionStamp is told the existing package.json version', () => {
  const dir = project({ name: 'x', version: '4.2.0', scripts: { build: 'sh build.sh', version: 'sh stamp.sh' } });
  ensureProjectWiring({ path: dir, kind: 'stub-fields', scaffold: false });
  assert.equal(readFileSync(join(dir, 'stamp.sh'), 'utf8'), '# stamps 4.2.0\n');
});

test('onboard: a missing required script is named with the exact line, and package.json is left as it was', () => {
  const pkg = { name: 'x', version: '1.0.0', scripts: { test: 'node --test' } };
  const dir = project(pkg);
  const before = readFileSync(join(dir, 'package.json'), 'utf8');
  const r = ensureProjectWiring({ path: dir, kind: 'stub-fields', scaffold: false });
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before);
  const build = r.warnings.find((w) => w.includes('"build"'));
  assert.ok(build, `no build warning in ${JSON.stringify(r.warnings)}`);
  assert.match(build, /package\.json has no "build" script, which kind "stub-fields" needs/);
  assert.ok(build.endsWith('"build": "sh build.sh"'), build);
  assert.ok(r.warnings.some((w) => w.endsWith('"version": "sh stamp.sh"')));
});

test('onboard: a required script that differs is named, with the kind\'s line', () => {
  const dir = project({ name: 'x', version: '1.0.0', scripts: { build: 'make', version: 'sh stamp.sh' } });
  const r = ensureProjectWiring({ path: dir, kind: 'stub-fields', scaffold: false });
  const scripts = r.warnings.filter((w) => w.includes('script'));
  assert.equal(scripts.length, 1, JSON.stringify(scripts));
  assert.match(scripts[0], /package\.json's "build" script is "make", not kind "stub-fields"'s/);
  assert.ok(scripts[0].endsWith('"build": "sh build.sh"'));
});

test('onboard: required scripts already in place give no warning', () => {
  const dir = project({ name: 'x', version: '1.0.0', scripts: { build: 'sh build.sh', version: 'sh stamp.sh' } });
  const r = ensureProjectWiring({ path: dir, kind: 'stub-fields', scaffold: false });
  assert.deepEqual(r.warnings.filter((w) => w.includes('script')), []);
});

test('a kind that declares no required scripts warns about none (the built-ins)', () => {
  const dir = project({ name: 'x', version: '1.0.0' });
  const r = ensureProjectWiring({ path: dir, kind: 'single', scaffold: false });
  assert.deepEqual(r.warnings.filter((w) => w.includes('script')), []);
});

test('a drop-in whose gitignore or requiredScripts is not a list of names is skipped as broken', () => {
  assert.equal(KINDS.includes('bad-gitignore'), false);
  assert.equal(KINDS.includes('bad-required'), false);
  assert.ok(KINDS.includes('stub-fields'));
});
