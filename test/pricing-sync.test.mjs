// test/pricing-sync.test.mjs — task 113: the price table keeps itself current.
//
// Two invariants carry the whole design and are locked here:
//   1. A row that already HAS a cost is never re-valued. Cost is locked in at
//      collection time; only costUSD:null rows may be filled in later.
//   2. A failed sync is a no-op, never a downgrade. Network error, empty feed,
//      or garbage rates all leave the last known-good table in place — a bad
//      fetch must not be able to un-price the world.
//
// COGYARD_HOME points at a throwaway dir and COGYARD_DRIVER at a fixture adapter,
// both BEFORE importing anything from core/ (paths + the active driver resolve at
// import). Node's test runner isolates each file in its own process, so this
// never touches the real ~/.cogyard or the real Claude driver.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), 'cogyard-pricing-'));
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_DRIVER = join(HERE, 'fixtures', 'pricing-driver.mjs');
const USAGE = join(HOME, 'usage');
mkdirSync(USAGE, { recursive: true });

const LEDGER = join(USAGE, 'usage.jsonl');
const PRICING = join(HOME, 'pricing.json');
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const writeLedger = (rows) => writeFileSync(LEDGER, jsonl(rows));
const readLedger = () => readFileSync(LEDGER, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const tokens = (o = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...o });

const { script } = await import('./fixtures/pricing-driver.mjs');
const { priceFor, activeVersions, syncPricing, pricingStatus } = await import('../core/pricing.mjs');
const { storedVersions, appendPricingVersion, storedEntry } = await import('../core/pricing-store.mjs');
const { repriceLedger, refreshPricing } = await import('../core/usage.mjs');
const { modelsFromFeed } = await import('../drivers/claude/pricing-sync.mjs');

beforeEach(() => {
  rmSync(PRICING, { force: true });
  script.models = null;
  script.throws = null;
  script.calls = 0;
});

after(() => rmSync(HOME, { recursive: true, force: true }));

// --- the feed parser (drivers/claude) ---------------------------------------

test('modelsFromFeed: takes Anthropic claude-* entries and converts to $ per MTok', () => {
  const models = modelsFromFeed({
    'claude-opus-5': { litellm_provider: 'anthropic', input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
  });
  assert.deepEqual(models, { 'claude-opus-5': { input: 5, output: 25 } });
});

test('modelsFromFeed: drops other providers, platform re-listings, and non-claude ids', () => {
  const models = modelsFromFeed({
    'gpt-9': { litellm_provider: 'openai', input_cost_per_token: 0.00001, output_cost_per_token: 0.00003 },
    'bedrock/claude-opus-5': { litellm_provider: 'anthropic', input_cost_per_token: 0.000006, output_cost_per_token: 0.00003 },
    'anthropic/claude-opus-5': { litellm_provider: 'anthropic', input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
    'command-r': { litellm_provider: 'anthropic', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
  });
  assert.deepEqual(models, {});
});

test('modelsFromFeed: skips entries with missing or zero rates rather than defaulting them', () => {
  const models = modelsFromFeed({
    'claude-no-rate': { litellm_provider: 'anthropic', output_cost_per_token: 0.000025 },
    'claude-zero': { litellm_provider: 'anthropic', input_cost_per_token: 0, output_cost_per_token: 0 },
    'claude-ok': { litellm_provider: 'anthropic', input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
  });
  assert.deepEqual(Object.keys(models), ['claude-ok']);
});

test('modelsFromFeed: rounds float noise out of per-token rates', () => {
  const models = modelsFromFeed({
    'claude-noisy': { litellm_provider: 'anthropic', input_cost_per_token: 0.00000019999999999999998, output_cost_per_token: 0.0000009999999999999999 },
  });
  assert.deepEqual(models['claude-noisy'], { input: 0.2, output: 1 });
});

// --- the store + resolution order -------------------------------------------

test('with no store, pricing falls back to the driver seed', () => {
  assert.equal(activeVersions()[0].version, 'seed-1');
  assert.equal(pricingStatus().synced, false);
  assert.equal(priceFor('model-a', tokens({ input: 1_000_000 })).costUSD, 10);
});

test('a synced version sits ahead of the seed and takes effect with no restart', async () => {
  script.models = { 'model-a': { input: 20, output: 100 } };
  const res = await syncPricing();
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.equal(activeVersions()[0].version, res.version);
  assert.equal(activeVersions().at(-1).version, 'seed-1'); // seed kept as fallback
  assert.equal(priceFor('model-a', tokens({ input: 1_000_000 })).costUSD, 20);
});

test('a seed model the feed does not carry keeps its price instead of going unpriced', async () => {
  script.models = { 'model-a': { input: 20, output: 100 } };  // no model-b upstream
  const res = await syncPricing();
  assert.deepEqual(res.unfetched, ['model-b']);
  assert.equal(priceFor('model-a', tokens({ input: 1_000_000 })).costUSD, 20); // upstream wins
  assert.equal(priceFor('model-b', tokens({ input: 1_000_000 })).costUSD, 1);  // seed floor holds
});

test('a sync that fetches identical rates appends nothing', async () => {
  script.models = { 'model-a': { input: 10, output: 50 }, 'model-b': { input: 1, output: 5 } };
  const res = await syncPricing();
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
  assert.equal(existsSync(PRICING), false);
});

test('a new model in the feed is reported as added', async () => {
  script.models = { 'model-a': { input: 10, output: 50 }, 'model-b': { input: 1, output: 5 }, 'model-new': { input: 3, output: 15 } };
  const res = await syncPricing();
  assert.deepEqual(res.added, ['model-new']);
  assert.deepEqual(res.rateChanges, []);
});

test('a changed rate is reported with both sides', async () => {
  script.models = { 'model-a': { input: 2, output: 10 }, 'model-b': { input: 1, output: 5 } };
  const res = await syncPricing();
  assert.deepEqual(res.added, []);
  assert.deepEqual(res.rateChanges, ['model-a: $10/$50 → $2/$10']);
});

test("another driver's table is not applied to this driver", async () => {
  appendPricingVersion('someone-else', { version: 'foreign', models: { 'model-a': { input: 999, output: 999 } } });
  assert.deepEqual(storedVersions('testdriver'), []);
  assert.equal(priceFor('model-a', tokens({ input: 1_000_000 })).costUSD, 10); // still the seed
});

test('two drivers coexist in one store — neither clobbers the other', async () => {
  appendPricingVersion('driver-one', { version: 'v1', models: { 'm': { input: 1, output: 2 } } });
  appendPricingVersion('driver-two', { version: 'v2', models: { 'm': { input: 3, output: 4 } } });
  appendPricingVersion('driver-one', { version: 'v3', models: { 'm': { input: 5, output: 6 } } });
  assert.deepEqual(storedVersions('driver-one').map((v) => v.version), ['v3', 'v1']);
  assert.deepEqual(storedVersions('driver-two').map((v) => v.version), ['v2']);
  assert.equal(storedEntry('driver-two').versions[0].models.m.input, 3);
});

test('a legacy single-driver store still resolves after the shape change', async () => {
  writeFileSync(PRICING, JSON.stringify({
    driver: 'testdriver',
    updated: '2026-01-01T00:00:00.000Z',
    source: 'legacy',
    versions: [{ version: 'legacy-1', models: { 'model-a': { input: 7, output: 70 } } }],
  }));
  assert.deepEqual(storedVersions('testdriver').map((v) => v.version), ['legacy-1']);
  assert.equal(priceFor('model-a', tokens({ input: 1_000_000 })).costUSD, 7);
  // …and writing through it migrates rather than dropping what was there.
  appendPricingVersion('testdriver', { version: 'new-1', models: { 'model-a': { input: 8, output: 80 } } });
  assert.deepEqual(storedVersions('testdriver').map((v) => v.version), ['new-1', 'legacy-1']);
});

// --- cache tiers: stated rates beat the engine's Anthropic ratios ------------

test('with no stated tiers, cache buckets fall back to the published multipliers', () => {
  const cost = priceFor('model-a', tokens({ cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 })).costUSD;
  assert.equal(cost, 10 * 0.1 + 10 * 1.25 + 10 * 2); // input $10 × the ratios
});

test('stated tier rates are used verbatim — a provider that prices cache its own way is priceable', async () => {
  // Cache writes free, reads at a quarter: nothing an input-rate ratio can express.
  script.models = { 'model-a': { input: 10, output: 50, cacheRead: 2.5, cacheWrite5m: 0, cacheWrite1h: 0 } };
  await syncPricing();
  const cost = priceFor('model-a', tokens({ cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 })).costUSD;
  assert.equal(cost, 2.5);
});

test('a tier-only rate change still counts as a change worth storing', async () => {
  script.models = { 'model-a': { input: 10, output: 50, cacheRead: 1 }, 'model-b': { input: 1, output: 5 } };
  assert.equal((await syncPricing()).changed, true);
  script.models = { 'model-a': { input: 10, output: 50, cacheRead: 9 }, 'model-b': { input: 1, output: 5 } };
  const second = await syncPricing();
  assert.equal(second.changed, true, 'input/output identical, cacheRead moved');
});

test('modelsFromFeed carries upstream cache tiers when they are published', () => {
  const models = modelsFromFeed({
    'claude-x': {
      litellm_provider: 'anthropic',
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.000025,
      cache_read_input_token_cost: 0.0000005,
      cache_creation_input_token_cost: 0.00000625,
      cache_creation_input_token_cost_above_1hr: 0.00001,
    },
  });
  assert.deepEqual(models['claude-x'], { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 });
});

test('a feed with no cache fields yields none — the engine ratios still apply', () => {
  const models = modelsFromFeed({
    'claude-y': { litellm_provider: 'anthropic', input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
  });
  assert.deepEqual(Object.keys(models['claude-y']), ['input', 'output']);
});

// --- failure is a no-op, never a downgrade ----------------------------------

test('a throwing feed leaves the table untouched', async () => {
  script.throws = 'ENOTFOUND raw.githubusercontent.com';
  const res = await syncPricing();
  assert.equal(res.ok, false);
  assert.equal(res.changed, false);
  assert.match(res.reason, /ENOTFOUND/);
  assert.equal(activeVersions()[0].version, 'seed-1');
  assert.equal(existsSync(PRICING), false);
});

test('an empty feed leaves the table untouched', async () => {
  script.models = {};
  const res = await syncPricing();
  assert.equal(res.ok, false);
  assert.equal(activeVersions()[0].version, 'seed-1');
});

test('a feed with a garbage rate is rejected whole — no partial table', async () => {
  script.models = { 'model-a': { input: 20, output: 100 }, 'model-bad': { input: 'free', output: 1 } };
  const res = await syncPricing();
  assert.equal(res.ok, false);
  assert.match(res.reason, /model-bad/);
  assert.equal(priceFor('model-a', tokens({ input: 1_000_000 })).costUSD, 10);
});

// --- repricing the ledger ----------------------------------------------------

test('reprice fills in null-cost rows and never touches a priced row', () => {
  writeLedger([
    { sessionId: 's1', project: 'p', model: 'model-a', tokens: tokens({ input: 1_000_000 }), costUSD: 3.5, pricingVersion: 'old', backfilled: false },
    { sessionId: 's2', project: 'p', model: 'model-b', tokens: tokens({ output: 1_000_000 }), costUSD: null, pricingVersion: 'old', backfilled: false },
  ]);
  const res = repriceLedger();
  assert.equal(res.repriced, 1);
  assert.deepEqual(res.byModel, { 'model-b': 1 });
  const [priced, filled] = readLedger();
  assert.equal(priced.costUSD, 3.5, 'an already-priced row keeps its locked-in cost');
  assert.equal(priced.pricingVersion, 'old');
  assert.equal(priced.backfilled, false);
  assert.equal(filled.costUSD, 5);            // 1M output tokens at $5/MTok
  assert.equal(filled.backfilled, true);      // priced after the fact
});

test('reprice is idempotent and preserves row count', () => {
  writeLedger([
    { sessionId: 's1', project: 'p', model: 'model-a', tokens: tokens({ input: 1_000_000 }), costUSD: null },
    { sessionId: 's2', project: 'p', model: 'model-b', tokens: tokens({ input: 1_000_000 }), costUSD: null },
  ]);
  assert.equal(repriceLedger().repriced, 2);
  const after1 = readFileSync(LEDGER, 'utf8');
  assert.equal(repriceLedger().repriced, 0);
  assert.equal(readFileSync(LEDGER, 'utf8'), after1, 'a second run is byte-identical');
  assert.equal(readLedger().length, 2);
});

test('reprice --dry-run reports without writing', () => {
  writeLedger([{ sessionId: 's1', project: 'p', model: 'model-a', tokens: tokens({ input: 1_000_000 }), costUSD: null }]);
  const before = readFileSync(LEDGER, 'utf8');
  const res = repriceLedger({ dryRun: true });
  assert.equal(res.repriced, 1);
  assert.equal(readFileSync(LEDGER, 'utf8'), before);
});

test('a model the table still cannot price is reported, not guessed', () => {
  writeLedger([{ sessionId: 's1', project: 'p', model: 'model-unknown', tokens: tokens({ input: 1_000_000 }), costUSD: null }]);
  const res = repriceLedger();
  assert.equal(res.repriced, 0);
  assert.deepEqual(res.stillUnpriced, { 'model-unknown': 1 });
  assert.equal(readLedger()[0].costUSD, null);
});

// --- the pairing that makes it self-healing ---------------------------------

test('refreshPricing: a sync that adds a model reprices the rows it unblocks', async () => {
  writeLedger([{ sessionId: 's1', project: 'p', model: 'model-new', tokens: tokens({ output: 1_000_000 }), costUSD: null }]);
  script.models = { 'model-a': { input: 10, output: 50 }, 'model-b': { input: 1, output: 5 }, 'model-new': { input: 5, output: 25 } };
  const res = await refreshPricing();
  assert.equal(res.sync.changed, true);
  assert.deepEqual(res.sync.added, ['model-new']);
  assert.equal(res.reprice.repriced, 1);
  assert.equal(readLedger()[0].costUSD, 25);
});

test('refreshPricing: an unchanged table skips the reprice pass entirely', async () => {
  script.models = { 'model-a': { input: 10, output: 50 }, 'model-b': { input: 1, output: 5 } };
  const res = await refreshPricing();
  assert.equal(res.sync.changed, false);
  assert.equal(res.reprice, null);
});

test('refreshPricing: a failed sync neither throws nor reprices', async () => {
  script.throws = 'timeout';
  const res = await refreshPricing();
  assert.equal(res.sync.ok, false);
  assert.equal(res.reprice, null);
});
