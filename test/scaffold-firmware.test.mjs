// test/scaffold-firmware.test.mjs — the built-in `firmware` kind (task 164).
//
// A PlatformIO project whose dev entry is its HOST-SIDE preview server: init
// and onboard keep worktree port wiring, name `npm run preview` opening on $PORT,
// seed the firmware's own stamper (a PlatformIO pre-build script) instead of the
// npm one, and record only which build environment is production. cogyard never
// runs `pio`, and works without it on PATH. Runs the real wiring engine against
// throwaway dirs with their own COGYARD_HOME and COGYARD_PROJECTS_ROOT, set
// BEFORE import (the registry and paths resolve at import).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-firmware-')));
const HOME = join(ROOT, 'home');
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = PROJECTS;

const { ensureProjectWiring } = await import('../core/scaffold.mjs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

// PATH with every folder that holds a pio taken out — git stays reachable.
const REAL_PATH = process.env.PATH;
const hasPio = (dir) => ['pio', 'platformio'].some((n) => { try { return statSync(join(dir, n)).isFile(); } catch { return false; } });
const PATH_WITHOUT_PIO = REAL_PATH.split(delimiter).filter((d) => d && !hasPio(d)).join(delimiter);

// A stand-in pio that leaves a mark if anything ever runs it.
const FAKE_BIN = join(ROOT, 'fake-bin');
const RAN = join(ROOT, 'pio-was-run');
mkdirSync(FAKE_BIN);
writeFileSync(join(FAKE_BIN, 'pio'), `#!/bin/sh\ntouch '${RAN}'\nexit 0\n`);
chmodSync(join(FAKE_BIN, 'pio'), 0o755);

function withPath(path, fn) {
  process.env.PATH = path;
  try { return fn(); } finally { process.env.PATH = REAL_PATH; }
}

function wire(name, files = {}, { scaffold = false, path = PATH_WITHOUT_PIO } = {}) {
  const dir = join(PROJECTS, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const r = withPath(path, () => ensureProjectWiring({ path: dir, kind: 'firmware', scaffold }));
  const read = (rel) => readFileSync(join(dir, rel), 'utf8');
  return { dir, r, read, has: (rel) => existsSync(join(dir, rel)) };
}

const NO_PIO = /PlatformIO \(pio\) is not on PATH\. cogyard never runs it and has set this project up without it/;

test('init with no pio on PATH succeeds, and says clearly what is missing', () => {
  const { r, read, has } = wire('fresh', {}, { scaffold: true });
  assert.ok(r.warnings.some((w) => NO_PIO.test(w)), `no PATH message in ${JSON.stringify(r.warnings)}`);
  assert.ok(r.warnings.some((w) => /No platformio\.ini at the project root yet/.test(w)));

  const cfg = JSON.parse(read('.cogyard/worktree.json'));
  assert.equal(cfg.dev_script, 'npm run preview', 'the dev entry is the host-side preview');
  assert.equal(cfg.launch_name, 'preview');
  assert.equal(cfg.preview_port_var, 'PORT');
  assert.equal(cfg.port_vars.PORT, 'backend', 'PORT resolves to a reserved worktree port');
  assert.equal('extra_dev_scripts' in cfg, false);

  assert.equal(has('scripts/generate-version.mjs'), false, 'no npm stamper');
  assert.match(read('scripts/firmware_version.py'), /extra_scripts = pre:scripts\/firmware_version\.py/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.build, 'pio run');
  assert.equal(pkg.scripts['generate-version'], undefined);
  assert.match(read('README.md'), /never runs PlatformIO/);
  assert.equal(has('.cogyard/firmware.json'), false, 'nothing to record before there is a platformio.ini');
});

test('with pio on PATH there is no PATH message — and pio is never run', () => {
  const { r } = wire('with-pio', { 'platformio.ini': '[env:app]\nboard = esp32dev\n' }, { path: `${FAKE_BIN}${delimiter}${PATH_WITHOUT_PIO}` });
  assert.equal(r.warnings.some((w) => NO_PIO.test(w)), false);
  assert.equal(existsSync(RAN), false, 'cogyard ran pio');
});

test('onboard records the production environment when platformio.ini defines one', () => {
  const { r, read } = wire('one-env', { 'platformio.ini': '; a comment\n[platformio]\nsrc_dir = src\n\n[env:release]\nboard = esp32dev\n' });
  const rec = JSON.parse(read('.cogyard/firmware.json'));
  assert.equal(rec.production_env, 'release');
  assert.deepEqual(Object.keys(rec), ['_comment', 'production_env'], 'only which env is production — no env list, no board');
  assert.ok(r.steps.some((s) => s.step === '.cogyard/firmware.json' && s.status === 'created'));
  assert.equal(r.warnings.some((w) => /production/.test(w)), false);
});

test('with several environments onboard records nothing and says how to record it', () => {
  const ini = '[env]\nboard = T5\n\n[env:app]\n[env:demo_render]\n[env:hello_epd] ; a test sketch\n';
  const { r, has } = wire('many-envs', { 'platformio.ini': ini });
  assert.equal(has('.cogyard/firmware.json'), false, 'never guesses which one is production');
  const w = r.warnings.find((x) => /cannot tell which is production/.test(x));
  assert.ok(w, JSON.stringify(r.warnings));
  assert.match(w, /3 build environments \(app, demo_render, hello_epd\)/);
  assert.match(w, /pio project config/);
  assert.match(w, /write \.cogyard\/firmware\.json as \{"production_env": "<env>"\}/);
});

test('a record the owner already wrote is kept, and no longer warned about', () => {
  const mine = '{ "production_env": "app" }\n';
  const { r, read } = wire('owner-wrote', { 'platformio.ini': '[env:app]\n[env:test]\n', '.cogyard/firmware.json': mine });
  assert.equal(read('.cogyard/firmware.json'), mine);
  assert.equal(r.warnings.some((w) => /production/.test(w)), false);
});

test('onboard with the firmware kind does not warn about the platformio.ini it claims', () => {
  const { r } = wire('claimed', { 'platformio.ini': '[env:app]\n', 'package.json': '{ "name": "x", "version": "2.0.0" }\n' });
  assert.equal(r.warnings.some((w) => /found platformio\.ini/.test(w)), false, JSON.stringify(r.warnings));
});

test('onboard never touches an existing package.json, and the preview stays the dev entry', () => {
  const pkg = '{\n  "name": "meter",\n  "version": "2.18.0",\n  "scripts": { "preview": "node preview/server.mjs" }\n}\n';
  const { read } = wire('existing-pkg', { 'platformio.ini': '[env:app]\n', 'package.json': pkg });
  assert.equal(read('package.json'), pkg);
  assert.equal(JSON.parse(read('.cogyard/worktree.json')).dev_script, 'npm run preview');
});
