// test/config.test.mjs — the persistent machine-config layer.
// Covers readConfig/writeConfig merge-patch, projectDefaults overlay + validation,
// and the env → config → default precedence of PROJECTS_ROOT resolution.
//
// COGYARD_HOME is pointed at a throwaway temp dir BEFORE importing the modules,
// which resolve it at import. The Node test runner isolates each file in its own
// process, so this redirect never touches the real ~/.cogyard.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-cfg-'));
process.env.COGYARD_HOME = HOME;
const CONFIG = join(HOME, 'config.json');

// Import AFTER COGYARD_HOME is set (config.mjs/paths.mjs resolve it at import).
const { readConfig, writeConfig, projectDefaults, uiPrefs, CONFIG_PATH } = await import('../core/config.mjs');
const { resolveProjectsRoot } = await import('../core/paths.mjs');

function clearConfig() { if (existsSync(CONFIG)) rmSync(CONFIG); }

before(() => clearConfig());
after(() => rmSync(HOME, { recursive: true, force: true }));

// --- readConfig / writeConfig -------------------------------------------------

test('CONFIG_PATH resolves under the redirected COGYARD_HOME', () => {
  assert.equal(CONFIG_PATH, CONFIG);
});

test('readConfig: no file → {}', () => {
  clearConfig();
  assert.deepEqual(readConfig(), {});
});

test('readConfig: malformed / non-object file → {}', () => {
  writeFileSync(CONFIG, '{not json');
  assert.deepEqual(readConfig(), {});
  writeFileSync(CONFIG, '[1,2,3]');
  assert.deepEqual(readConfig(), {});
  clearConfig();
});

test('writeConfig: merge-patch preserves unknown keys', () => {
  clearConfig();
  writeConfig({ driver: 'claude' });
  writeConfig({ projectsRoot: '/srv/code' });
  const cfg = readConfig();
  assert.equal(cfg.driver, 'claude'); // preserved across the second write
  assert.equal(cfg.projectsRoot, '/srv/code');
  clearConfig();
});

// --- projectDefaults ----------------------------------------------------------

test('projectDefaults: no file → built-in defaults', () => {
  clearConfig();
  assert.deepEqual(projectDefaults(), { kind: 'single', store: 'shared' });
});

test('projectDefaults: valid config.defaults overlays the built-ins', () => {
  writeConfig({ defaults: { kind: 'fullstack', store: 'shared' } });
  assert.deepEqual(projectDefaults(), { kind: 'fullstack', store: 'shared' });
  clearConfig();
});

test('projectDefaults: invalid kind/store are dropped, not crashed on', () => {
  writeConfig({ defaults: { kind: 'nonsense', store: 'bogus' } });
  assert.deepEqual(projectDefaults(), { kind: 'single', store: 'shared' });
  clearConfig();
});

test('projectDefaults: partial overlay keeps the other built-in', () => {
  writeConfig({ defaults: { kind: 'library' } });
  assert.deepEqual(projectDefaults(), { kind: 'library', store: 'shared' });
  clearConfig();
});

// --- uiPrefs.hiddenTabs ---------------------------------------------

test('uiPrefs: no file → hiddenTabs defaults to []', () => {
  clearConfig();
  assert.deepEqual(uiPrefs().hiddenTabs, []);
});

test('uiPrefs: valid hiddenTabs subset persists', () => {
  writeConfig({ ui: { hiddenTabs: ['board', 'branches'] } });
  assert.deepEqual(uiPrefs().hiddenTabs, ['board', 'branches']);
  clearConfig();
});

test("uiPrefs: a persisted 'settings' tab id (legacy config) is dropped on read", () => {
  // The per-project settings tab no longer exists; stale configs that hid it
  // must degrade silently instead of leaking an unknown id to the UI.
  writeConfig({ ui: { hiddenTabs: ['board', 'settings'] } });
  assert.deepEqual(uiPrefs().hiddenTabs, ['board']);
  clearConfig();
});

test('uiPrefs: unknown tab ids are dropped, known ones kept', () => {
  writeConfig({ ui: { hiddenTabs: ['bogus', 'graph'] } });
  assert.deepEqual(uiPrefs().hiddenTabs, ['graph']);
  clearConfig();
});

test('uiPrefs: non-array hiddenTabs is ignored → []', () => {
  writeConfig({ ui: { hiddenTabs: 'board' } });
  assert.deepEqual(uiPrefs().hiddenTabs, []);
  clearConfig();
});

// --- PROJECTS_ROOT resolution precedence (env → config → default) -------------

test('resolveProjectsRoot: default when neither env nor config set', () => {
  clearConfig();
  const prev = process.env.COGYARD_PROJECTS_ROOT;
  delete process.env.COGYARD_PROJECTS_ROOT;
  try {
    const r = resolveProjectsRoot();
    assert.equal(r.source, 'default');
    assert.ok(r.value.endsWith('/gitroot'));
  } finally { if (prev !== undefined) process.env.COGYARD_PROJECTS_ROOT = prev; }
});

test('resolveProjectsRoot: config wins over default', () => {
  const prev = process.env.COGYARD_PROJECTS_ROOT;
  delete process.env.COGYARD_PROJECTS_ROOT;
  writeConfig({ projectsRoot: '/srv/code' });
  try {
    assert.deepEqual(resolveProjectsRoot(), { value: '/srv/code', source: 'config' });
  } finally {
    clearConfig();
    if (prev !== undefined) process.env.COGYARD_PROJECTS_ROOT = prev;
  }
});

test('resolveProjectsRoot: env wins over config', () => {
  const prev = process.env.COGYARD_PROJECTS_ROOT;
  writeConfig({ projectsRoot: '/srv/code' });
  process.env.COGYARD_PROJECTS_ROOT = '/env/wins';
  try {
    assert.deepEqual(resolveProjectsRoot(), { value: '/env/wins', source: 'env' });
  } finally {
    clearConfig();
    if (prev === undefined) delete process.env.COGYARD_PROJECTS_ROOT; else process.env.COGYARD_PROJECTS_ROOT = prev;
  }
});

test('writeConfig wrote a trailing newline (matches the registry/open-targets idiom)', () => {
  writeConfig({ driver: 'claude' });
  assert.ok(readFileSync(CONFIG, 'utf8').endsWith('}\n'));
  clearConfig();
});
