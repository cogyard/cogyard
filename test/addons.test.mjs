// test/addons.test.mjs — the add-on contract + loader + registry.
// Add-ons are MACHINE-LEVEL (they extend cogyard itself, never a project);
// covers drop-in discovery under a redirected COGYARD_HOME, manifest validation,
// platform gating, catalog/status shapes, project-typed config fields traveling
// through cfg, and the safe-vs-manual execution tiers (manual must NEVER
// execute — that's the core-enforced safety property).
//
// COGYARD_HOME is pointed at a throwaway temp dir BEFORE importing the module
// (same pattern as config.test.mjs; the Node test runner isolates each file in
// its own process, so this never touches the real ~/.cogyard).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-addons-'));
process.env.COGYARD_HOME = HOME;
const DIR = join(HOME, 'addons');

const { ADDONS_DIR, listAddonIds, listAddons, addonStatuses, runAddonAction, resetAddons } =
  await import('../core/addons/index.mjs');

// A well-behaved add-on that records whether run() ever fired — the probe for
// the "manual never executes" guarantee. Its config declares a `project`-typed
// field: project targeting is add-on config, not framework structure.
const GOOD = `
let ran = [];
export const manifest = {
  id: 'good',
  label: 'Good Add-on',
  description: 'test fixture',
  icon: '🧪',
  thirdParty: false,
  prereqs() { return [{ id: 'always', label: 'Always ok', ok: true }]; },
  configSchema: [
    { key: 'host', label: 'Host', type: 'string', required: true },
    { key: 'project', label: 'Project', type: 'project' },
  ],
  status() { return { enabled: true, summary: 'machine-level on', healthy: true, details: { ran } }; },
  actions: [
    { id: 'poke', label: 'Poke', tier: 'safe' },
    { id: 'setup', label: 'Setup', tier: 'manual', needsConfig: true },
  ],
  run(actionId, cfg) { ran.push(actionId); return { ok: true, message: 'poked ' + (cfg && cfg.host) + ' for ' + (cfg && cfg.project) }; },
  command(actionId, cfg) { return { command: 'toolctl ' + actionId + ' ' + (cfg && cfg.host) + ' --project ' + (cfg && cfg.project), note: 'copy-paste' }; },
};
`;

// Declares an impossible platform — must be listed but disabled, never probed.
const ELSEWHERE = `
export const manifest = {
  id: 'elsewhere',
  label: 'Elsewhere Only',
  platforms: ['not-a-real-os'],
  status() { throw new Error('must never be called on an unsupported platform'); },
  actions: [{ id: 'go', label: 'Go', tier: 'safe' }],
  run() { throw new Error('must never run'); },
};
`;

function install(id, source) {
  mkdirSync(join(DIR, id), { recursive: true });
  writeFileSync(join(DIR, id, 'addon.mjs'), source);
}

before(() => {
  install('good', GOOD);
  install('elsewhere', ELSEWHERE);
  install('broken', 'export const manifest = { id: "mismatch", label: "x" };');
  mkdirSync(join(DIR, 'not-an-addon'), { recursive: true }); // no addon.mjs → ignored
  resetAddons();
});
after(() => rmSync(HOME, { recursive: true, force: true }));

// --- discovery ------------------------------------------------------------------

test('ADDONS_DIR resolves under the redirected COGYARD_HOME', () => {
  assert.equal(ADDONS_DIR, DIR);
});

test('discovery lists only folders holding addon.mjs, sorted', () => {
  assert.deepEqual(listAddonIds(), ['broken', 'elsewhere', 'good']);
});

// --- catalog ----------------------------------------------------------------------

test('catalog: functions stripped, machine prereqs evaluated, broken installs surfaced', async () => {
  const { addons, invalid } = await listAddons();
  const good = addons.find((a) => a.id === 'good');
  assert.equal(good.label, 'Good Add-on');
  assert.equal(good.supported, true);
  assert.equal(good.status, undefined);           // no functions on the wire
  assert.deepEqual(good.prereqs, [{ id: 'always', label: 'Always ok', ok: true }]);
  assert.deepEqual(good.configSchema[1], { key: 'project', label: 'Project', type: 'project' });
  assert.deepEqual(good.actions.map((a) => a.tier), ['safe', 'manual']);

  const elsewhere = addons.find((a) => a.id === 'elsewhere');
  assert.equal(elsewhere.supported, false);       // listed, but platform-gated
  assert.deepEqual(elsewhere.prereqs, []);        // and never probed

  assert.equal(invalid.length, 1);                // id/folder mismatch is visible
  assert.equal(invalid[0].id, 'broken');
  assert.match(invalid[0].error, /must equal its folder name/);
});

// --- status ---------------------------------------------------------------------

test('status: machine-level, takes no project, gates unsupported platforms', async () => {
  const statuses = await addonStatuses();
  const good = statuses.find((s) => s.id === 'good');
  assert.equal(good.enabled, true);
  assert.equal(good.summary, 'machine-level on');
  const elsewhere = statuses.find((s) => s.id === 'elsewhere');
  assert.equal(elsewhere.supported, false);       // status() never called → no throw
  assert.equal(elsewhere.enabled, false);
});

// --- tiered execution -------------------------------------------------------------

test('safe action executes via run(); project slug travels in cfg', async () => {
  const r = await runAddonAction('good', 'poke', { host: 'h1', project: 'demo' });
  assert.deepEqual(r, { ok: true, manual: false, message: 'poked h1 for demo' });
});

test('manual action renders the command and NEVER executes', async () => {
  const r = await runAddonAction('good', 'setup', { host: 'h2', project: 'demo' });
  assert.equal(r.manual, true);
  assert.equal(r.command, 'toolctl setup h2 --project demo');
  // run() fired exactly once — for the earlier safe poke, not for this manual action.
  const statuses = await addonStatuses();
  assert.deepEqual(statuses.find((s) => s.id === 'good').details.ran, ['poke']);
});

test('unknown add-on / unknown action / unsupported platform all throw', async () => {
  await assert.rejects(() => runAddonAction('nope', 'x', {}), /unknown add-on/);
  await assert.rejects(() => runAddonAction('good', 'nope', {}), /no action/);
  await assert.rejects(() => runAddonAction('elsewhere', 'go', {}), /not available/);
});

// --- framework activation switch (config.json disabledAddons) --------------------

test('switched-off add-on: listed but inert — no code runs, actions refuse', async () => {
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disabledAddons: ['good'] }));
  try {
    const { addons } = await listAddons();
    const good = addons.find((a) => a.id === 'good');
    assert.equal(good.active, false);
    assert.deepEqual(good.prereqs, []);          // prereqs() NOT called while off
    const st = (await addonStatuses()).find((s) => s.id === 'good');
    assert.equal(st.active, false);
    assert.equal(st.summary, 'switched off');    // status() NOT called while off
    await assert.rejects(() => runAddonAction('good', 'poke', {}), /switched off/);
  } finally {
    rmSync(join(HOME, 'config.json'));
  }
});

test('active add-ons carry active:true; toggle state is read fresh per call', async () => {
  const { addons } = await listAddons();          // config.json gone again → all active
  assert.ok(addons.every((a) => a.active));
  const st = (await addonStatuses()).find((s) => s.id === 'good');
  assert.equal(st.active, true);
});
