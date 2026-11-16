// drivers/claude/pricing-sync.mjs — where Claude model rates come from.
//
// The `pricing` seam's upstream half (docs/DRIVERS.md). The engine polls this
// (core/pricing.mjs → syncPricing) and owns the storage decision; all this file
// does is fetch a feed and shape it into the seam's `{model: {input, output}}`,
// $ per MILLION tokens. No filesystem, no caching, no policy.
//
// WHY a third-party feed: Anthropic publishes no pricing API — GET /v1/models
// returns ids, limits and capability flags, no rates, and needs an API key
// cogyard doesn't have. LiteLLM's price file is the machine-readable option, and
// its keys are the EXACT model-id strings Claude Code transcripts carry
// (`claude-opus-5`, `claude-opus-4-8`, dated variants like
// `claude-haiku-4-5-20251001`), so no name mapping is needed. Its Anthropic
// rates track Anthropic's own pricing page, including introductory rates.
//
// Cache tiers are taken as STATED rates rather than left to the engine's
// fallback ratios. For current Claude models the two agree exactly (upstream's
// cache numbers are the published 0.1x / 1.25x / 2x of input), so this changes
// no Claude cost — it removes the assumption. Retired models where the ratios
// don't hold now price correctly, and a future driver whose provider prices
// cache on its own schedule needs no engine change at all.

const FEED_URL = process.env.COGYARD_PRICING_URL
  || 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// The feed is ~1.6MB; generous but bounded, and never on a request path.
const TIMEOUT_MS = Number(process.env.COGYARD_PRICING_TIMEOUT_MS || 20_000);

const PER_MILLION = 1_000_000;

// Float noise: per-token rates round-trip to things like 0.19999999999999998.
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Feed object → {'<model-id>': {input, output}} in $ per MILLION tokens.
//
// Selection rule, in order: the entry must be Anthropic's (`litellm_provider`),
// must be a first-party model id (`claude-` prefix — this is what transcripts
// record), and must carry no `/` (that drops the `bedrock/…`, `vertex_ai/…`,
// `anthropic/…` re-listings of the same models at platform-specific rates,
// which cogyard never prices). Entries missing usable numbers are skipped
// rather than defaulted — a missing rate must stay unpriced and visible.
function modelsFromFeed(feed) {
  const models = {};
  for (const [id, entry] of Object.entries(feed || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.litellm_provider !== 'anthropic') continue;
    if (!id.startsWith('claude-') || id.includes('/')) continue;
    const input = entry.input_cost_per_token;
    const output = entry.output_cost_per_token;
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    if (input <= 0 || output <= 0) continue;
    const rates = { input: round6(input * PER_MILLION), output: round6(output * PER_MILLION) };
    // Cache tiers only when upstream states them; an absent tier falls back to
    // the engine's ratio rather than being invented here.
    const tiers = [
      ['cacheRead', entry.cache_read_input_token_cost],
      ['cacheWrite5m', entry.cache_creation_input_token_cost],
      ['cacheWrite1h', entry.cache_creation_input_token_cost_above_1hr],
    ];
    for (const [key, cost] of tiers) {
      if (Number.isFinite(cost) && cost >= 0) rates[key] = round6(cost * PER_MILLION);
    }
    models[id] = rates;
  }
  return models;
}

// → {models, source}. Throws on network/HTTP/parse failure; the engine catches
// and keeps the last known-good table (fail-closed).
async function fetchPricing() {
  const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${FEED_URL} → HTTP ${res.status}`);
  const feed = await res.json();
  return { models: modelsFromFeed(feed), source: FEED_URL };
}

export { FEED_URL, modelsFromFeed, fetchPricing };
