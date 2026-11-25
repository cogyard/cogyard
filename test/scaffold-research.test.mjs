// test/scaffold-research.test.mjs — a kind that writes no package.json (task 274).
//
// A descriptor declares `pkgJson: null` to say it writes no package.json. Step 3
// of ensureProjectWiring then writes nothing and records `skipped`; an existing
// package.json is still left alone; with none on disk the `version` switch
// defaults to off. Runs the real wiring engine against throwaway dirs, with
// add-in kinds installed in a throwaway COGYARD_HOME before the registry loads.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-nopkg-')));
const HOME = join(ROOT, 'home');
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = PROJECTS;

function install(kind, body) {
  mkdirSync(join(HOME, 'scaffolds', kind), { recursive: true });
  writeFileSync(join(HOME, 'scaffolds', kind, 'scaffold.mjs'), `export const scaffold = {
  kind: '${kind}', description: '${kind}',
  skeletonFiles(slug) { return { 'README.md': '# ' + slug + '\\n' }; },
  ${body}
};
`);
}
install('stub-nopkg', 'worktreePorts: false, devScript: null, versionStamp: false, pkgJson: null,');
install('stub-pkg', "worktreePorts: false, versionStamp: false, pkgJson(slug) { return { name: slug, version: '0.1.0' }; },");
install('stub-returns-null', 'worktreePorts: false, versionStamp: false, pkgJson() { return null; },');
install('stub-no-pkg-field', 'worktreePorts: false, versionStamp: false,'); // pkgJson left out → broken

const { ensureProjectWiring } = await import('../core/scaffold.mjs');
const { KINDS } = await import('../core/scaffolds/index.mjs');
const { resolveSwitches } = await import('../core/switches.mjs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

function wire(kind, { scaffold = true, name, before } = {}) {
  const dir = join(PROJECTS, name || `demo-${kind}-${scaffold ? 'init' : 'onboard'}`);
  mkdirSync(dir, { recursive: true });
  if (before) before(dir);
  const r = ensureProjectWiring({ path: dir, kind, scaffold });
  return { dir, steps: r.steps, warnings: r.warnings, step: (n) => r.steps.find((s) => s.step === n) };
}

test('pkgJson: null is a valid descriptor; leaving pkgJson out is still broken', () => {
  assert.ok(KINDS.includes('stub-nopkg'));
  assert.equal(KINDS.includes('stub-no-pkg-field'), false);
});

test('init with pkgJson: null writes no package.json and records skipped', () => {
  const { dir, step } = wire('stub-nopkg');
  assert.equal(existsSync(join(dir, 'package.json')), false);
  assert.deepEqual(step('package.json'), { step: 'package.json', status: 'skipped', detail: 'kind=stub-nopkg writes no package.json' });
  assert.ok(existsSync(join(dir, 'README.md')));
});

test('onboard with pkgJson: null writes no package.json either', () => {
  const { dir, step, warnings } = wire('stub-nopkg', { scaffold: false });
  assert.equal(existsSync(join(dir, 'package.json')), false);
  assert.equal(step('package.json').status, 'skipped');
  assert.equal(warnings.some((w) => /package\.json/.test(w)), false);
});

test('an existing package.json is left untouched, and the no-version warning still fires', () => {
  const body = '{ "name": "mine" }\n';
  const { dir, step, warnings } = wire('stub-nopkg', { scaffold: false, name: 'has-pkg', before: (d) => writeFileSync(join(d, 'package.json'), body) });
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), body);
  assert.equal(step('package.json').status, 'present');
  assert.ok(warnings.some((w) => /package\.json exists but has no "version"/.test(w)));
});

test('the no-version warning applies only when a package.json exists', () => {
  const { warnings } = wire('stub-nopkg', { name: 'no-pkg-no-warning' });
  assert.equal(warnings.some((w) => /has no "version"/.test(w)), false);
});

test('with no package.json on disk the version switch defaults to off', () => {
  const { dir } = wire('stub-nopkg', { name: 'switch-off' });
  const sw = resolveSwitches(dir);
  assert.equal(sw.version.value, 'off');
  assert.equal(sw.version.set, false);
  assert.equal(sw.version.file, null);
});

test('step 6 says the kind has no version, not that it stamps via package.json', () => {
  const { step } = wire('stub-nopkg', { name: 'stamp-line' });
  assert.deepEqual(step('scripts/generate-version.mjs'),
    { step: 'scripts/generate-version.mjs', status: 'skipped', detail: 'kind=stub-nopkg has no version to stamp' });
});

test('a kind whose pkgJson returns an object behaves as before', () => {
  const { dir, step } = wire('stub-pkg');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), { name: 'demo-stub-pkg-init', version: '0.1.0' });
  assert.deepEqual(step('package.json'), { step: 'package.json', status: 'created', detail: 'minimal, version 0.1.0' });
  assert.equal(step('scripts/generate-version.mjs').detail, 'kind=stub-pkg stamps via package.json');
  assert.equal(resolveSwitches(dir).version.value, 'minor');
});

// --- the built-in research kind ----------------------------------------------

// Every path under `dir` except .git, sorted; a link shows as `path -> target`.
function listing(dir) {
  return execFileSync('find', ['.', '-path', './.git', '-prune', '-o', '-print'], { cwd: dir, encoding: 'utf8' })
    .split('\n').filter((l) => l && l !== '.').sort();
}

test('research init writes exactly what it declares, and no package.json, stamper or worktree config', () => {
  const { dir, step, warnings } = wire('research');
  assert.deepEqual(listing(dir), [
    './.cogyard', './.cogyard/.gitignore', './.cogyard/tasks', './.gitignore', './README.md',
    './findings', './findings/.gitkeep', './notes', './notes/.gitkeep', './sources', './sources/.gitkeep',
  ]);
  for (const f of ['notes/.gitkeep', 'sources/.gitkeep', 'findings/.gitkeep']) assert.equal(readFileSync(join(dir, f), 'utf8'), '');
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(readme, /^# demo-research-init\n/);
  assert.match(readme, /no build, no dev server and no version/);
  for (const folder of ['notes/', 'sources/', 'findings/']) assert.ok(readme.includes(`\`${folder}\``), folder);
  assert.equal(step('package.json').detail, 'kind=research writes no package.json');
  assert.equal(step('scripts/generate-version.mjs').detail, 'kind=research has no version to stamp');
  assert.equal(step('.cogyard/worktree.json').status, 'skipped');
  assert.deepEqual(warnings, []);
  assert.equal(resolveSwitches(dir).version.value, 'off');
});

test('research onboard on a no-code folder leaves its files alone and warns about nothing', () => {
  const files = { 'AGENTS.md': '# rules\n', '_docs/architecture.md': '# arch\n' };
  const { dir, warnings } = wire('research', {
    scaffold: false,
    name: 'nocode',
    before: (d) => { for (const [rel, c] of Object.entries(files)) { mkdirSync(join(d, rel, '..'), { recursive: true }); writeFileSync(join(d, rel), c); } },
  });
  for (const [rel, c] of Object.entries(files)) assert.equal(readFileSync(join(dir, rel), 'utf8'), c);
  assert.equal(existsSync(join(dir, 'package.json')), false);
  assert.equal(existsSync(join(dir, 'README.md')), false); // onboard seeds no skeleton
  assert.deepEqual(warnings, []);
});

test('a pkgJson() that returns no object writes no file holding null, and says so', () => {
  const { dir, step, warnings } = wire('stub-returns-null');
  assert.equal(existsSync(join(dir, 'package.json')), false);
  assert.equal(step('package.json').status, 'skipped');
  assert.ok(warnings.some((w) => /pkgJson\(\) returned no object/.test(w) && /pkgJson: null/.test(w)));
});
