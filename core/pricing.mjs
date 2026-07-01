// core/pricing.mjs — versioned model pricing for the usage ledger (task 026).
//
// Cost is computed ONCE, at collection time, with the table version in effect;
// ledger rows store {costUSD, pricingVersion} and are never recomputed. Adding
// a new version entry changes future collections only — historical rows keep the
// version they were priced with.
//
// The price TABLE and shorthand ALIASES come from the active integration's
// adapter (task 038 — see core/integrations.mjs + docs/INTEGRATIONS.md): Claude
// ships the reference table; the no-op adapter ships an empty one (tokens still
// ledger, cost stays null). The cache-tier math + version-locking below are
// engine-generic and stay here. Rates are $ per MILLION tokens. Cache multipliers
// per Anthropic pricing: read = 0.1× input, 5-minute write = 1.25×, 1-hour = 2×.

import { adapter } from './integrations.mjs';

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;

// The active adapter's price versions (newest first). Snapshotted at import for
// the barrel re-export; priceFor() re-reads the adapter live so a swapped
// integration is reflected without a reload.
const PRICING_VERSIONS = adapter.pricing.versions;

function resolveModel(model) {
  if (!model) return null;
  const aliases = adapter.pricing.aliases || {};
  if (aliases[model]) return aliases[model];
  // Date-suffixed full ids (claude-haiku-4-5-20251001) → strip the suffix.
  const m = model.match(/^(.*)-\d{8}$/);
  return m ? m[1] : model;
}

// tokens: {input, output, cacheRead, cacheWrite5m, cacheWrite1h}
// Returns {costUSD, pricingVersion}; costUSD is null for unknown models
// (tokens still get ledgered — cost can never be backfilled retroactively,
// that's by design).
function priceFor(model, tokens) {
  const current = adapter.pricing.versions[0];
  if (!current) return { costUSD: null, pricingVersion: null }; // no-op adapter
  const rates = current.models[resolveModel(model)];
  if (!rates) return { costUSD: null, pricingVersion: current.version };
  const perTok = 1 / 1_000_000;
  const costUSD =
    (tokens.input || 0) * rates.input * perTok +
    (tokens.output || 0) * rates.output * perTok +
    (tokens.cacheRead || 0) * rates.input * CACHE_READ_MULT * perTok +
    (tokens.cacheWrite5m || 0) * rates.input * CACHE_WRITE_5M_MULT * perTok +
    (tokens.cacheWrite1h || 0) * rates.input * CACHE_WRITE_1H_MULT * perTok;
  return { costUSD: Math.round(costUSD * 1e6) / 1e6, pricingVersion: current.version };
}

export { PRICING_VERSIONS, priceFor, resolveModel };
