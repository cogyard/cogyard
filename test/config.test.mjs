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

test('projectDefaults: no file → built-in defaults (the kind only — no store choice)', () => {
  clearConfig();
  assert.deepEqual(projectDefaults(), { kind: 'single' });
});

test('projectDefaults: a valid config.defaults kind overlays the built-in', () => {
  writeConfig({ defaults: { kind: 'fullstack' } });
  assert.deepEqual(projectDefaults(), { kind: 'fullstack' });
  clearConfig();
});

test('projectDefaults: an invalid kind is dropped, not crashed on', () => {
  writeConfig({ defaults: { kind: 'nonsense' } });
  assert.deepEqual(projectDefaults(), { kind: 'single' });
  clearConfig();
});

// Task 169: a config.json written by an older release may still carry
// `store: 'shared'` — it is ignored, never sent back out.
test('projectDefaults: an older file\'s store key is ignored', () => {
  writeConfig({ defaults: { kind: 'library', store: 'shared' } });
  assert.deepEqual(projectDefaults(), { kind: 'library' });
  clearConfig();
});

// --- uiPrefs.hiddenTabs ---------------------------------------------

test('uiPrefs: no file → hiddenTabs defaults to []', () => {
  clearConfig();
  assert.deepEqual(uiPrefs().hiddenTabs, []);
});

test('uiPrefs: valid hiddenTabs subset persists', () => {
  writeConfig({ ui: { hiddenTabs: ['plan', 'branches'] } });
  assert.deepEqual(uiPrefs().hiddenTabs, ['plan', 'branches']);
  clearConfig();
});

test("uiPrefs: a persisted 'settings' tab id (legacy config) is dropped on read", () => {
  // The per-project settings tab no longer exists; stale configs that hid it
  // must degrade silently instead of leaking an unknown id to the UI.
  writeConfig({ ui: { hiddenTabs: ['plan', 'settings'] } });
  assert.deepEqual(uiPrefs().hiddenTabs, ['plan']);
  clearConfig();
});

test("uiPrefs: a hidden 'board' (replaced by 'plan', task 179) stays hidden as 'plan'", () => {
  writeConfig({ ui: { hiddenTabs: ['board', 'graph'] } });
  assert.deepEqual(uiPrefs().hiddenTabs, ['plan', 'graph']);
  clearConfig();
});

// Task 249: Stats and Cleanup moved into the project's Admin tab, which can't
// be hidden — a config that hid them (or the older 'activity') loads with
// those ids simply gone.
test("uiPrefs: a hidden 'stats' / 'cleanup' / 'activity' (now inside Admin) is dropped on read", () => {
  writeConfig({ ui: { hiddenTabs: ['stats', 'cleanup', 'activity', 'graph'] } });
  assert.deepEqual(uiPrefs().hiddenTabs, ['graph']);
  writeConfig({ ui: { hiddenTabs: ['stats', 'cleanup'] } });
  assert.deepEqual(uiPrefs().hiddenTabs, []);
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

// --- uiPrefs.defaultTab (task 216) ----------------------------------

test("uiPrefs: no file → defaultTab is 'tasks'", () => {
  clearConfig();
  assert.equal(uiPrefs().defaultTab, 'tasks');
});

test('uiPrefs: a valid visible defaultTab persists', () => {
  writeConfig({ ui: { defaultTab: 'plan' } });
  assert.equal(uiPrefs().defaultTab, 'plan');
  clearConfig();
});

test("uiPrefs: an unknown defaultTab falls back to 'tasks'", () => {
  writeConfig({ ui: { defaultTab: 'bogus' } });
  assert.equal(uiPrefs().defaultTab, 'tasks');
  clearConfig();
});

test("uiPrefs: a legacy 'board' defaultTab maps to 'plan'", () => {
  writeConfig({ ui: { defaultTab: 'board' } });
  assert.equal(uiPrefs().defaultTab, 'plan');
  clearConfig();
});

// Task 249: a landing tab of Stats or Cleanup (or the older 'activity') names
// no top-level tab any more, so it falls back like any unknown id — to Tasks,
// or to the first visible tab when Tasks is hidden.
test("uiPrefs: a defaultTab of 'stats' / 'cleanup' / 'activity' falls back", () => {
  for (const t of ['stats', 'cleanup', 'activity']) {
    writeConfig({ ui: { defaultTab: t } });
    assert.equal(uiPrefs().defaultTab, 'tasks', t);
    writeConfig({ ui: { defaultTab: t, hiddenTabs: ['tasks'] } });
    assert.equal(uiPrefs().defaultTab, 'daily', `${t} with Tasks hidden`);
  }
  clearConfig();
});

test('uiPrefs: a hidden defaultTab resolves to the first visible tab', () => {
  writeConfig({ ui: { defaultTab: 'plan', hiddenTabs: ['plan', 'daily'] } });
  assert.equal(uiPrefs().defaultTab, 'tasks');
  writeConfig({ ui: { defaultTab: 'tasks', hiddenTabs: ['daily', 'tasks'] } });
  assert.equal(uiPrefs().defaultTab, 'plan');
  clearConfig();
});

test("uiPrefs: every tab hidden → defaultTab is 'tasks'", () => {
  writeConfig({ ui: { defaultTab: 'plan', hiddenTabs: ['daily', 'tasks', 'plan', 'branches', 'worktrees', 'graph', 'files'] } });
  assert.equal(uiPrefs().defaultTab, 'tasks');
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
