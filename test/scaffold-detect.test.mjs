// test/scaffold-detect.test.mjs — onboard notices what it is adopting (task 162).
//
// Every built-in kind assumes an npm web app. Onboarding a folder that holds an
// Xcode project, a Swift package or PlatformIO firmware warns — naming what it
// found, what the chosen kind seeded that may not fit, and an installed kind
// whose `markers` claim it (or that none does) — and then carries on: warn, not
// refuse or auto-select. COGYARD_HOME / COGYARD_PROJECTS_ROOT are throwaway and
// set BEFORE import (the registry resolves at import).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-detect-')));
const HOME = join(ROOT, 'home');
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = PROJECTS;

// The built-in `apple` kind claims the Apple markers, so it is the kind named.
mkdirSync(join(HOME, 'scaffolds', 'bad-markers'), { recursive: true });
writeFileSync(join(HOME, 'scaffolds', 'bad-markers', 'scaffold.mjs'), `export const scaffold = {
  kind: 'bad-markers', description: 'x', markers: '*.xcodeproj',
  pkgJson(slug) { return { name: slug }; }, skeletonFiles() { return {}; },
};
`);

const { platformWarnings, KINDS } = await import('../core/scaffolds/index.mjs');
const { ensureProjectWiring } = await import('../core/scaffold.mjs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
// A folder holding the given relative paths; a trailing '/' makes a directory.
function folder(paths) {
  const dir = join(PROJECTS, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const p of paths) {
    if (p.endsWith('/')) mkdirSync(join(dir, p), { recursive: true });
    else { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), ''); }
  }
  return dir;
}

test('an .xcodeproj at the root warns and names the installed kind that claims it', () => {
  const [w, ...rest] = platformWarnings(folder(['MessagesCleanup.xcodeproj/', 'Sources/main.swift']), 'single');
  assert.equal(rest.length, 0);
  assert.match(w, /found MessagesCleanup\.xcodeproj \(an Xcode project\), but kind "single" assumes an npm web app/);
  assert.match(w, /better kind is installed: apple —/);
  assert.match(w, /--kind apple\./);
});

test('one folder down counts — an iOS app beside a server keeps it in ios/', () => {
  const [w] = platformWarnings(folder(['package.json', 'ios/WhereIsMaya.xcodeproj/']), 'single');
  assert.match(w, /found ios\/WhereIsMaya\.xcodeproj/);
});

test('an .xcworkspace and a Package.swift are each detected', () => {
  const ws = platformWarnings(folder(['App.xcworkspace/', 'Package.swift']), 'fullstack');
  assert.equal(ws.length, 2);
  assert.match(ws[0], /found App\.xcworkspace \(an Xcode workspace\)/);
  assert.match(ws[1], /found Package\.swift \(a Swift package\)/);
});

test('platformio.ini under an npm kind warns and names the built-in firmware kind', () => {
  const [w] = platformWarnings(folder(['platformio.ini', 'src/main.cpp']), 'single');
  assert.match(w, /found platformio\.ini \(a PlatformIO firmware project\)/);
  assert.match(w, /better kind is installed: firmware/);
  assert.match(w, /--kind firmware/);
});

test('platformio.ini under the firmware kind gets no warning', () => {
  assert.deepEqual(platformWarnings(folder(['platformio.ini', 'src/main.cpp']), 'firmware'), []);
});

test('the kind that claims the marker gets no warning', () => {
  assert.deepEqual(platformWarnings(folder(['App.xcodeproj/']), 'apple'), []);
  assert.deepEqual(platformWarnings(folder(['App.xcworkspace/', 'Package.swift']), 'apple'), []);
});

test('a plain npm project gets no warning', () => {
  assert.deepEqual(platformWarnings(folder(['package.json', 'src/index.mjs']), 'single'), []);
});

test('node_modules, hidden folders and anything two folders down are not looked into', () => {
  const dir = folder(['node_modules/x/X.xcodeproj/', 'node_modules/Y.xcodeproj/', '.build/Z.xcodeproj/', 'a/b/platformio.ini']);
  assert.deepEqual(platformWarnings(dir, 'single'), []);
});

test('a drop-in whose markers is not a list of names is skipped as broken', () => {
  assert.equal(KINDS.includes('bad-markers'), false);
});

test('onboard carries on and reports the warning with what it seeded', () => {
  const dir = folder(['MessagesCleanup.xcodeproj/']);
  const r = ensureProjectWiring({ path: dir, kind: 'single', scaffold: false });
  assert.ok(existsSync(join(dir, '.cogyard', 'worktree.json')), 'onboard still wires — warn, not refuse');
  const w = r.warnings.find((x) => x.includes('MessagesCleanup.xcodeproj'));
  assert.ok(w, `no platform warning in ${JSON.stringify(r.warnings)}`);
  assert.match(w, /dev_script "npm run dev" in \.cogyard\/worktree\.json and scripts\/generate-version\.mjs/);
});

test('onboard with the claiming kind reports nothing', () => {
  const dir = folder(['MessagesCleanup.xcodeproj/']);
  const r = ensureProjectWiring({ path: dir, kind: 'apple', scaffold: false });
  assert.deepEqual(r.warnings, []);
});
