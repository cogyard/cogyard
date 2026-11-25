// test/scaffold-apple.test.mjs — the built-in `apple` kind: an Xcode app, macOS or iOS.
//
// What it writes at init and onboard (a package.json whose build runs xcodebuild,
// two scripts, a committed Version.xcconfig, no dev_script, no npm stamper), what
// onboard says about an existing package.json it may not edit, and how the seeded
// scripts behave: the build finds the one scheme or stops, and the stamper writes
// the same Version.xcconfig that was seeded. Runs the real wiring engine against
// throwaway dirs; COGYARD_HOME and COGYARD_PROJECTS_ROOT are set BEFORE import.
//
// The script checks that need plutil (macOS) are skipped elsewhere; none needs
// Xcode — a stand-in xcodebuild on PATH answers instead.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-apple-')));
const HOME = join(ROOT, 'home');
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = PROJECTS;

// A drop-in that tries to take the built-in's name — must be ignored.
mkdirSync(join(HOME, 'scaffolds', 'apple'), { recursive: true });
writeFileSync(join(HOME, 'scaffolds', 'apple', 'scaffold.mjs'), `export const scaffold = {
  kind: 'apple', description: 'EVIL OVERRIDE',
  pkgJson(slug) { return { name: slug }; }, skeletonFiles() { return {}; },
};
`);

const { ensureProjectWiring } = await import('../core/scaffold.mjs');
const { scaffoldFor, KINDS } = await import('../core/scaffolds/index.mjs');
const { appleVersionXcconfig } = await import('../core/scaffolds/builtins.mjs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

const SRC = new URL('../core/scaffolds/apple/', import.meta.url);
const source = (name) => readFileSync(new URL(name, SRC), 'utf8');
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const hasPlutil = spawnSync('plutil', ['-help']).error === undefined;

let n = 0;
function project(files = {}) {
  const dir = join(PROJECTS, `app${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    if (rel.endsWith('/')) { mkdirSync(join(dir, rel), { recursive: true }); continue; }
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

test('the descriptor: a built-in with no dev server, ports kept, Xcode markers, the scripts it needs', () => {
  const k = scaffoldFor('apple');
  assert.equal(k.builtin, true);
  assert.notEqual(k.description, 'EVIL OVERRIDE', 'a drop-in cannot shadow the built-in');
  assert.equal(KINDS.filter((x) => x === 'apple').length, 1);
  assert.equal(k.devScript, null);
  assert.equal(k.worktreePorts, true, 'an app beside a server keeps the server\'s ports');
  assert.deepEqual(k.markers, ['*.xcodeproj', '*.xcworkspace', 'Package.swift']);
  assert.deepEqual(k.gitignore, ['Build.xcconfig']);
  const scripts = k.pkgJson('demo').scripts;
  assert.equal(scripts.build, 'bash scripts/xcode-build.sh');
  for (const name of k.requiredScripts) assert.ok(scripts[name], `pkgJson has no "${name}" script`);
  assert.equal(scripts['generate-version'], undefined);
});

test('init writes the Apple wiring and none of the npm defaults', () => {
  const dir = project();
  ensureProjectWiring({ path: dir, kind: 'apple', scaffold: true });
  const pkg = JSON.parse(read(dir, 'package.json'));
  assert.equal(pkg.version, '0.1.0');
  assert.deepEqual(Object.keys(pkg.scripts), ['build', 'version']);
  assert.equal(existsSync(join(dir, 'scripts/generate-version.mjs')), false);
  assert.equal(read(dir, 'scripts/xcode-build.sh'), source('xcode-build.sh'));
  assert.equal(read(dir, 'scripts/xcode-version.sh'), source('xcode-version.sh'));
  assert.match(read(dir, 'Version.xcconfig'), /^MARKETING_VERSION = 0\.1\.0$/m);
  assert.ok(read(dir, '.gitignore').split('\n').includes('Build.xcconfig'));
  const cfg = JSON.parse(read(dir, '.cogyard/worktree.json'));
  assert.equal(cfg.dev_script, undefined, 'no dev server is named');
  assert.deepEqual(cfg.port_vars, { PORT: 'backend', FRONTEND_PORT: 'frontend' });
  assert.match(read(dir, 'README.md'), /The one-time hookup in Xcode/);
  // Committed with the wiring, so the first build leaves nothing to commit.
  assert.ok(git(dir, 'ls-files').split('\n').includes('Version.xcconfig'));
});

test('onboard leaves an existing package.json alone and names the lines to add', () => {
  const pkg = JSON.stringify({ name: 'mac-app', version: '1.1.0', scripts: { 'generate-version': 'node scripts/generate-version.mjs' } }, null, 2) + '\n';
  const dir = project({ 'package.json': pkg, 'MyApp.xcodeproj/': '', 'MyApp/App.swift': '' });
  const r = ensureProjectWiring({ path: dir, kind: 'apple', scaffold: false });
  assert.equal(read(dir, 'package.json'), pkg);
  assert.match(read(dir, 'Version.xcconfig'), /^MARKETING_VERSION = 1\.1\.0$/m, 'seeded with the version on disk');
  const lines = r.warnings.filter((w) => w.includes('onboard never edits an existing package.json'));
  assert.equal(lines.length, 2, JSON.stringify(r.warnings));
  assert.ok(lines[0].endsWith('"build": "bash scripts/xcode-build.sh"'));
  assert.ok(lines[1].endsWith('"version": "bash scripts/xcode-version.sh && git add Version.xcconfig"'));
  assert.equal(r.warnings.some((w) => w.includes('assumes an npm web app')), false, 'the kind claims the .xcodeproj');
  assert.equal(JSON.parse(read(dir, '.cogyard/worktree.json')).dev_script, undefined);
});

test('onboard keeps an existing worktree config — an app beside a server keeps its dev entry', () => {
  const cfg = JSON.stringify({ project_name: 'hybrid', dev_script: 'npm run serve', port_vars: { PORT: 'backend' } }, null, 2) + '\n';
  const dir = project({ 'package.json': '{ "name": "hybrid", "version": "2.0.0" }\n', 'ios/MyApp.xcodeproj/': '', 'server/index.mjs': '', '.cogyard/worktree.json': cfg });
  ensureProjectWiring({ path: dir, kind: 'apple', scaffold: false });
  assert.equal(read(dir, '.cogyard/worktree.json'), cfg);
});

test('the README and the stamper give the same hookup steps', () => {
  const steps = (text) => text.split('\n')
    .map((l) => l.replace(/^#\s?/, '').trim())
    .join(' ')
    .match(/1\. Add Version\.xcconfig.*?forInfoDictionaryKey: "GitCommitShort"\)\./)?.[0];
  const readme = scaffoldFor('apple').skeletonFiles('demo')['README.md'];
  assert.ok(steps(source('xcode-version.sh')), 'no steps in the stamper');
  assert.equal(steps(readme), steps(source('xcode-version.sh')));
});

test('the Version.xcconfig template fills in only the version', () => {
  const body = appleVersionXcconfig('9.8.7');
  assert.match(body, /^MARKETING_VERSION = 9\.8\.7$/m);
  assert.doesNotMatch(body, /[$`\\]/, 'a shell character in the heredoc would make the build write something else');
  assert.match(body, /^#include\? "Build\.xcconfig"$/m);
});

test('the build script stops when there is no Xcode project, before stamping anything', () => {
  const dir = project();
  ensureProjectWiring({ path: dir, kind: 'apple', scaffold: true });
  const r = spawnSync('bash', ['scripts/xcode-build.sh'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no Xcode workspace, project or Package\.swift at the repo root or one folder below it/);
  assert.equal(existsSync(join(dir, 'Build.xcconfig')), false);
});

test('the stamper writes the Version.xcconfig that was seeded, and git stays clean', { skip: !hasPlutil && 'needs plutil (macOS)' }, () => {
  const dir = project();
  ensureProjectWiring({ path: dir, kind: 'apple', scaffold: true });
  const seeded = read(dir, 'Version.xcconfig');
  const r = spawnSync('bash', ['scripts/xcode-version.sh'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir, 'Version.xcconfig'), seeded);
  assert.match(read(dir, 'Build.xcconfig'), new RegExp(`^GIT_COMMIT_SHORT = ${git(dir, 'rev-parse', '--short', 'HEAD')}$`, 'm'));
  assert.match(read(dir, 'Build.xcconfig'), new RegExp(`^CURRENT_PROJECT_VERSION = ${git(dir, 'rev-list', '--count', 'HEAD')}$`, 'm'));
  assert.equal(git(dir, 'status', '--porcelain'), '', 'Build.xcconfig is ignored and Version.xcconfig unchanged');
});

// A stand-in xcodebuild: logs its arguments and answers -list with the given JSON.
function fakeXcode(list) {
  const bin = mkdtempSync(join(ROOT, 'bin-'));
  writeFileSync(join(bin, 'list.json'), JSON.stringify(list));
  writeFileSync(join(bin, 'xcodebuild'), `#!/bin/sh
echo "$*" >> "${bin}/calls"
case "$1" in
  -list) cat "${bin}/list.json" ;;
  -showBuildSettings) echo '[]' ;;
esac
`);
  chmodSync(join(bin, 'xcodebuild'), 0o755);
  return {
    run: (dir, args = []) => spawnSync('bash', ['scripts/xcode-build.sh', ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    }),
    calls: () => (existsSync(join(bin, 'calls')) ? readFileSync(join(bin, 'calls'), 'utf8').trim().split('\n') : []),
  };
}

function appProject(files) {
  const dir = project(files);
  ensureProjectWiring({ path: dir, kind: 'apple', scaffold: false });
  return dir;
}

test('the build finds the one scheme and builds it', { skip: !hasPlutil && 'needs plutil (macOS)' }, () => {
  const x = fakeXcode({ project: { name: 'MyApp', schemes: ['MyApp'], targets: ['MyApp'], configurations: ['Debug', 'Release'] } });
  const dir = appProject({ 'MyApp.xcodeproj/': '' });
  const r = x.run(dir, ['-quiet']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(x.calls().includes('build -project MyApp.xcodeproj -scheme MyApp -quiet'), x.calls().join('\n'));
  assert.ok(existsSync(join(dir, 'Build.xcconfig')), 'stamped before building');
});

test('a project one folder down is found there', { skip: !hasPlutil && 'needs plutil (macOS)' }, () => {
  const x = fakeXcode({ project: { name: 'MyApp', schemes: ['MyApp'] } });
  const dir = appProject({ 'ios/MyApp.xcodeproj/': '', 'server/index.mjs': '' });
  const r = x.run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /xcodebuild build -project MyApp\.xcodeproj -scheme MyApp \(in ios\)/);
});

test('a workspace beside its project is the one built', { skip: !hasPlutil && 'needs plutil (macOS)' }, () => {
  const x = fakeXcode({ workspace: { name: 'MyApp', schemes: ['MyApp'] } });
  const dir = appProject({ 'MyApp.xcodeproj/': '', 'MyApp.xcworkspace/': '' });
  assert.equal(x.run(dir).status, 0);
  assert.ok(x.calls().includes('build -workspace MyApp.xcworkspace -scheme MyApp'), x.calls().join('\n'));
});

test('several schemes stop the build and name them, with the line to add', { skip: !hasPlutil && 'needs plutil (macOS)' }, () => {
  const x = fakeXcode({ project: { name: 'MyApp', schemes: ['MyApp', 'MyWidget'] } });
  const dir = appProject({ 'MyApp.xcodeproj/': '' });
  const r = x.run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /2 schemes in MyApp\.xcodeproj: MyApp, MyWidget\. Name the one to build in package\.json, e\.g\. "build": "bash scripts\/xcode-build\.sh -scheme MyApp"/);
  assert.equal(x.calls().some((c) => c.startsWith('build')), false);
  assert.equal(existsSync(join(dir, 'Build.xcconfig')), false, 'nothing stamped');
});

test('no scheme stops the build', { skip: !hasPlutil && 'needs plutil (macOS)' }, () => {
  const x = fakeXcode({ project: { name: 'MyApp', schemes: [] } });
  const dir = appProject({ 'MyApp.xcodeproj/': '' });
  const r = x.run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no scheme in MyApp\.xcodeproj/);
});

test('-scheme in the build line skips discovery', { skip: !hasPlutil && 'needs plutil (macOS)' }, () => {
  const x = fakeXcode({ project: { name: 'MyApp', schemes: ['A', 'B'] } });
  const dir = appProject({ 'MyApp.xcodeproj/': '' });
  const r = x.run(dir, ['-scheme', 'B']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(x.calls().some((c) => c.startsWith('-list')), false);
  assert.ok(x.calls().includes('build -project MyApp.xcodeproj -scheme B'));
});
