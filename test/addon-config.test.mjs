// test/addon-config.test.mjs — persisted add-on config (task 127).
//
// The load-bearing property: A SAVED VALUE REACHES THE SCHEDULED RUN. Before
// this, config lived only in a browser signal and the nightly tick passed none
// at all, so every unattended run saw `{}` — a setting the owner changed had no
// effect on the one execution path nobody is watching.
//
// No credential passes through this layer. config.json is world-readable, so the
// agent's credential lives with the driver and the store instead
// (test/driver-credential.test.mjs, test/secrets.test.mjs).
//
// COGYARD_HOME is redirected before the imports, as in addons.test.mjs.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-addoncfg-'));
process.env.COGYARD_HOME = HOME;
const DIR = join(HOME, 'addons');
const CONFIG = join(HOME, 'config.json');
const { addonConfig, saveAddonConfig, resetAddons } = await import('../core/addons/index.mjs');
const { readAddonConfig } = await import('../core/config.mjs');
const { runScheduledJob } = await import('../core/addons/jobs.mjs');

// A scheduled job that records the cfg it was handed — the only way to assert
// the load-bearing property end to end.
const JOB = `
export const manifest = {
  id: 'job',
  label: 'Job',
  configSchema: [
    { key: 'threshold', label: 'Threshold', type: 'string', default: '30' },
    { key: 'loud', label: 'Loud', type: 'boolean', default: false },
    { key: 'mode', label: 'Mode', type: 'enum', options: ['fast', 'slow'], default: 'fast' },
  ],
  schedule: { every: 'day', at: '05:00' },
  status() { return { enabled: true, summary: 'ok' }; },
  actions: [{ id: 'poke', label: 'Poke', tier: 'safe' }],
  run(actionId, cfg) { return { ok: true, message: JSON.stringify(cfg) }; },
  async runScheduled(cfg) { return { ok: true, summary: JSON.stringify(cfg) }; },
};
`;

function install(id, source) {
  mkdirSync(join(DIR, id), { recursive: true });
  writeFileSync(join(DIR, id, 'addon.mjs'), source);
}



before(() => { install('job', JOB); resetAddons(); });
beforeEach(() => rmSync(CONFIG, { force: true }));
after(() => rmSync(HOME, { recursive: true, force: true }));

// --- persistence --------------------------------------------------------------

test('config: unset → schema defaults, so an add-on works before anyone configures it', async () => {
  const cfg = await addonConfig('job');
  assert.equal(cfg.threshold, '30');
  assert.equal(cfg.mode, 'fast');
  assert.equal(cfg.loud, false);
});

test('config: a saved value survives, overlaying the default', async () => {
  await saveAddonConfig('job', { threshold: '7', loud: true, mode: 'slow' });
  assert.deepEqual(readAddonConfig('job'), { threshold: '7', loud: true, mode: 'slow' });
  const cfg = await addonConfig('job');
  assert.equal(cfg.threshold, '7');
  assert.equal(cfg.loud, true);
  assert.equal(cfg.mode, 'slow');
});

test('config: an empty string CLEARS a key rather than storing a blank', async () => {
  await saveAddonConfig('job', { threshold: '7' });
  await saveAddonConfig('job', { threshold: '' });
  assert.deepEqual(readAddonConfig('job'), {});
  assert.equal((await addonConfig('job')).threshold, '30'); // back to the default
});

test('config: an undeclared key is refused, not silently stored', async () => {
  await assert.rejects(() => saveAddonConfig('job', { nonsense: 'x' }), /no config field 'nonsense'/);
});

test('config: an enum outside its options is refused', async () => {
  await assert.rejects(() => saveAddonConfig('job', { mode: 'sideways' }), /must be one of: fast, slow/);
});

test('config: one add-on\'s save does not clobber another\'s', async () => {
  install('other', 'export const manifest = { id: "other", label: "Other", configSchema: [{ key: "x", label: "X", type: "string" }] };');
  resetAddons();
  await saveAddonConfig('job', { threshold: '7' });
  await saveAddonConfig('other', { x: 'kept' });
  assert.equal(readAddonConfig('job').threshold, '7');
  assert.equal(readAddonConfig('other').x, 'kept');
});

// --- property 1: the saved value reaches the unattended run --------------------

test('a value saved through the API reaches runScheduled on the next run', async () => {
  await saveAddonConfig('job', { threshold: '7', mode: 'slow' });
  // Exactly what server/index.mjs's nightly tick passes.
  const r = await runScheduledJob('job', { cfg: await addonConfig('job') });
  assert.equal(r.ok, true);
  const seen = JSON.parse(r.summary);
  assert.equal(seen.threshold, '7');
  assert.equal(seen.mode, 'slow');
});

test('a run that lands before the first Settings load keeps its count and log', async () => {
  // The seed used to write `runs: 0, totalCost: 0, log: []` alongside seededAt,
  // so a Run now on a freshly installed job was erased the moment anyone opened
  // Settings. Found while verifying that a saved setting reaches a run — the log
  // that was supposed to prove it came back empty.
  const { readJobs, seedJob, listScheduledJobs } = await import('../core/addons/jobs.mjs');
  rmSync(join(HOME, 'jobs.json'), { force: true });
  await runScheduledJob('job', { cfg: await addonConfig('job') });
  assert.equal(readJobs().job.runs, 1);
  seedJob('job');
  assert.equal(readJobs().job.runs, 1, 'the seed must not overwrite a completed run');
  assert.equal((await listScheduledJobs()).find((j) => j.id === 'job').runs, 1);
});

test('a scheduled job is only told about the agent credential when it declared needsAgent', async () => {
  // Core cannot tell whether a job calls the agent. A job that only reads git
  // and files needs no credential, and warning its owner that one is missing is
  // a false alarm on the one row they read in the morning — so the job declares
  // it. ('job' in this file's fixture declares no needsAgent.)
  const { listScheduledJobs } = await import('../core/addons/jobs.mjs');
  const rows = await listScheduledJobs();
  assert.equal(rows.find((j) => j.id === 'job').credential, null);
});






