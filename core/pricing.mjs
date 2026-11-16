// core/pricing.mjs — versioned model pricing for the usage ledger.
//
// Cost is computed ONCE, at collection time, with the table version in effect;
// ledger rows store {costUSD, pricingVersion} and are never recomputed. Adding
// a new version entry changes future collections only — historical rows keep the
// version they were priced with. The one exception is a row that never got a
// cost at all (unknown model → costUSD null); core/usage.mjs → repriceLedger()
// may fill those in once the model becomes priceable.
//
// The price TABLE and shorthand ALIASES come from the active driver's
// adapter (see core/drivers.mjs + docs/DRIVERS.md): Claude
// ships the reference table; the no-op adapter ships an empty one (tokens still
// ledger, cost stays null). A hand-written table goes stale the day a model
// ships, so the driver may also expose `pricing.sync()` — an upstream feed the
// engine polls (syncPricing) and stores in $COGYARD_HOME/pricing.json
// (core/pricing-store.mjs). Synced versions sit AHEAD of the built-in ones, which
// stay as the offline seed. The cache-tier math + version-locking below are
// engine-generic and stay here. Rates are $ per MILLION tokens. Cache multipliers
// per Anthropic pricing: read = 0.1× input, 5-minute write = 1.25×, 1-hour = 2×.

import { adapter } from './drivers.mjs';
import { storedVersions, appendPricingVersion, storedEntry, PRICING_PATH } from './pricing-store.mjs';

// FALLBACK ratios, used only for a rate entry that gives no explicit tier price
// — a hand-written seed table, or a feed that doesn't publish cache rates. They
// are Anthropic's published multipliers, so they are right for the Claude driver
// and a guess for anyone else; a driver whose provider prices cache differently
// (OpenAI charges nothing to write a cache entry, and discounts reads by a
// different ratio) supplies real per-tier rates instead and never touches these.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;

// The active adapter's BUILT-IN price versions (newest first) — the seed table
// that ships in the repo. Snapshotted at import for the barrel re-export.
const PRICING_VERSIONS = adapter.pricing.versions;

// What pricing actually reads: versions synced from upstream (newest first)
// ahead of the driver's built-in seed. Re-read live on every call, so a sync
// takes effect without restarting the process, and a swapped driver is
// reflected immediately. With no store and a no-op driver this is [] and
// priceFor() invents nothing.
function activeVersions() {
  return [...storedVersions(adapter.name), ...(adapter.pricing.versions || [])];
}

// Same rate set? Compares every rate field a model carries (input, output, and
// any explicit cache tiers), so re-running a sync that fetched identical numbers
// never appends a version — and a cache-only change still counts as a change.
const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
function sameModels(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((m) => RATE_KEYS.every((r) => a[m][r] === b[m][r]));
}

// Refresh the price table from the active driver's upstream feed.
//
// The driver fetches and shapes ({models, source}); the engine decides whether
// anything changed and owns the write. FAIL-CLOSED by design: a driver with no
// sync(), a network error, a shape change, or an empty result all leave the
// current table exactly as it was — a bad sync must never be able to un-price
// the world.
// → {ok, changed, reason?, version?, added: [], changed: [...], models: n}
async function syncPricing() {
  if (typeof adapter.pricing.sync !== 'function') {
    return { ok: false, changed: false, reason: 'driver has no pricing.sync()' };
  }
  let fetched;
  try {
    fetched = await adapter.pricing.sync();
  } catch (err) {
    return { ok: false, changed: false, reason: `fetch failed: ${err.message}` };
  }
  const fetchedModels = fetched && fetched.models;
  if (!fetchedModels || typeof fetchedModels !== 'object' || !Object.keys(fetchedModels).length) {
    return { ok: false, changed: false, reason: 'feed returned no usable models' };
  }
  for (const [id, r] of Object.entries(fetchedModels)) {
    if (!r || !Number.isFinite(r.input) || !Number.isFinite(r.output)) {
      return { ok: false, changed: false, reason: `bad rate for ${id}` };
    }
  }

  // The seed is a FLOOR, not a rival: a version stores the seed's models with
  // the feed layered on top, so upstream always wins on a rate it carries, and
  // a model the feed doesn't list (limited-availability models are absent from
  // public feeds) keeps its seed price instead of silently falling back to $0.
  // Only versions[0] is ever consulted, so anything missing from it is unpriced.
  const seedModels = (adapter.pricing.versions[0] || {}).models || {};
  const models = { ...seedModels, ...fetchedModels };
  const unfetched = Object.keys(seedModels).filter((m) => !fetchedModels[m]).sort();

  const current = activeVersions()[0];
  if (current && sameModels(current.models, models)) {
    return { ok: true, changed: false, models: Object.keys(models).length, version: current.version, unfetched };
  }

  // What moved, for the log — new models are the interesting case (they're what
  // was pricing at null), rate changes the one worth eyeballing.
  const before = (current && current.models) || {};
  const added = Object.keys(models).filter((m) => !before[m]).sort();
  const rateChanges = Object.keys(models)
    .filter((m) => before[m] && (before[m].input !== models[m].input || before[m].output !== models[m].output))
    .sort()
    .map((m) => `${m}: $${before[m].input}/$${before[m].output} → $${models[m].input}/$${models[m].output}`);

  const stamp = new Date().toISOString();
  const version = {
    version: stamp,
    effective: stamp,
    source: fetched.source || 'driver sync',
    models,
  };
  appendPricingVersion(adapter.name, version, { source: fetched.source });
  return {
    ok: true,
    changed: true,
    version: stamp,
    models: Object.keys(models).length,
    added,
    rateChanges,
    unfetched,
  };
}

// What the table looks like right now — for `usage pricing` and the portal.
function pricingStatus() {
  const versions = activeVersions();
  const current = versions[0] || null;
  const stored = storedVersions(adapter.name);
  const entry = storedEntry(adapter.name);
  return {
    driver: adapter.name,
    synced: stored.length > 0,
    version: current ? current.version : null,
    source: current ? current.source : null,
    updated: entry ? entry.updated : null,
    storePath: PRICING_PATH,
    models: current ? Object.keys(current.models).sort() : [],
    storedVersions: stored.length,
    seedVersions: (adapter.pricing.versions || []).length,
  };
}

function resolveModel(model) {
  if (!model) return null;
  const aliases = adapter.pricing.aliases || {};
  if (aliases[model]) return aliases[model];
  // Date-suffixed full ids (claude-haiku-4-5-20251001) → strip the suffix.
  const m = model.match(/^(.*)-\d{8}$/);
  return m ? m[1] : model;
}

// What a cache bucket costs per MTok: the rate the table states, else the input
// rate scaled by the fallback ratio. Stated beats derived — a provider whose
// cache pricing isn't a ratio of its input rate can only be priced correctly if
// it can state the number.
function tierRate(rates, key, fallbackMult) {
  return Number.isFinite(rates[key]) ? rates[key] : rates.input * fallbackMult;
}

// tokens: {input, output, cacheRead, cacheWrite5m, cacheWrite1h}
//
// The five buckets are the ledger's fixed shape, not a claim about any provider:
// a driver whose provider has one cache-write tier fills cacheWrite5m and leaves
// cacheWrite1h at 0; one that charges nothing to write a cache entry leaves both
// at 0 and only reports cacheRead.
//
// Returns {costUSD, pricingVersion}; costUSD is null for unknown models
// (tokens still get ledgered — cost can never be backfilled retroactively,
// that's by design).
function priceFor(model, tokens) {
  const current = activeVersions()[0];
  if (!current) return { costUSD: null, pricingVersion: null }; // no-op adapter
  const rates = current.models[resolveModel(model)];
  if (!rates) return { costUSD: null, pricingVersion: current.version };
  const perTok = 1 / 1_000_000;
  const costUSD =
    (tokens.input || 0) * rates.input * perTok +
    (tokens.output || 0) * rates.output * perTok +
    (tokens.cacheRead || 0) * tierRate(rates, 'cacheRead', CACHE_READ_MULT) * perTok +
    (tokens.cacheWrite5m || 0) * tierRate(rates, 'cacheWrite5m', CACHE_WRITE_5M_MULT) * perTok +
    (tokens.cacheWrite1h || 0) * tierRate(rates, 'cacheWrite1h', CACHE_WRITE_1H_MULT) * perTok;
  return { costUSD: Math.round(costUSD * 1e6) / 1e6, pricingVersion: current.version };
}

export { PRICING_VERSIONS, activeVersions, priceFor, resolveModel, syncPricing, pricingStatus };
