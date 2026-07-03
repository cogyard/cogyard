# Integrations — driving cogyard with any agent (task 038)

cogyard's engine (`core/`) and CLI (`cli/`) are **agent-agnostic**: any agent —
Claude Code today, Codex / Ollama / a human tomorrow — drives the same task /
claim / port / worktree machinery by calling `cli/tasks.mjs` and `cli/env.mjs`.

Three things in the engine are inherently agent-specific, though, and a different
agent would not satisfy them. Task 038 moved all three behind a small **adapter**
interface so the shared engine asks the *active* integration instead of hardcoding
Claude Code:

| Seam | What's agent-specific | Engine consumers |
|------|-----------------------|------------------|
| **worktree** | the on-disk layout + branch prefix an agent uses for its worktrees (Claude: `<repo>/.claude/worktrees/<name>`, `claude/*`) | `core/usage.mjs`, `hooks/worktree-ports.mjs`, `hooks/worktree-session.mjs`, `cli/tunnel.mjs` |
| **transcripts** | where the agent stores session transcripts + how to parse one into token rows | `core/usage.mjs`, `cli/usage.mjs` |
| **pricing** | the agent's model-id → price table + shorthand aliases | `core/pricing.mjs` |

## How it resolves — `core/integrations.mjs`

`core/integrations.mjs` resolves and loads the **active adapter once at import**
(top-level await) and exports it as `adapter`. Every engine consumer imports that
resolved object and uses it synchronously.

Resolution order:

1. `COGYARD_INTEGRATION` env var (`claude`, `none`, or any `integrations/<name>`).
2. `~/.cogyard/config.json` → `{ "integration": "<name>" }`.
3. **Auto-detect** — the first `integrations/<name>/adapter.mjs` whose `detect()`
   returns true claims the environment. (Claude's `detect()` is true under Claude
   Code or when `~/.claude` exists.)
4. **Fallback: the built-in no-op adapter** (`NOOP` in `core/integrations.mjs`).

The no-op adapter ships inside `core/` so the CLI and portal run with **no agent
active at all** — a plain human user gets a working engine; the usage tab simply
has nothing to harvest and degrades gracefully.

## The adapter contract

A driver is a directory `integrations/<name>/` containing an `adapter.mjs` whose
default export is an object with this shape. Every field is required; an
unsupported seam returns the documented "off" value rather than throwing.

```js
// integrations/<name>/adapter.mjs
export default {
  name: '<name>',

  // Is THIS integration the active driver for the current environment?
  // Used only by core/integrations.mjs auto-detection (step 3 above). Keep it
  // cheap and side-effect-free.
  detect() { return /* boolean */ },

  // --- seam 1: worktree -----------------------------------------------------
  worktree: {
    // Given ANY checkout path, return {parentRepo, name} when it is one of this
    // agent's worktrees, else null. (Generic .planet / .claude/worktree-config.json
    // markers are handled by the engine; this is the agent-SPECIFIC positional
    // fallback that identifies the project root + worktree name from the path.)
    detect(path) { return { parentRepo: '<abs repo root>', name: '<worktree>' } /* | null */ },
    // Branch-name prefix this agent uses for worktree branches (metadata).
    branchPrefix: '<prefix>/' /* | null */,
  },

  // --- seam 2: transcripts --------------------------------------------------
  transcripts: {
    supported: true,                 // false → usage harvesting is a no-op
    root() { return '<abs dir>' },   // where transcripts live (or null)
    list() { return [/* abs file paths */] },          // every transcript file
    findBySession(sessionId) { return [/* abs paths */] }, // this session's transcript(s)
    // One raw transcript line (string) → normalized record, or null to skip.
    //   { sessionId, cwd, usage, prompt }  — sessionId/cwd may be null on a line.
    //   usage (the billable turn, or null):
    //     { model, timestamp, dedupeKey, tokens }
    //   tokens: { input, output, cacheRead, cacheWrite5m, cacheWrite1h }
    //     (the ledger's fixed token shape — map your agent's fields onto it;
    //      leave cache tiers 0 if your agent has no prompt caching).
    //   prompt (a HUMAN prompt event, or null — task 064's attention signal):
    //     { timestamp, dedupeKey }
    //     Emit it ONLY for messages the human actually typed — not tool results,
    //     not injected/meta lines. If your agent's log can't tell those apart,
    //     always return null: the attention views then show nothing for this
    //     agent instead of counting machine noise as human attention.
    parseLine(line) { return { sessionId, cwd, usage, prompt } /* | null */ },
  },

  // --- seam 3: pricing ------------------------------------------------------
  // The engine (core/pricing.mjs) owns the cache-tier math and version-locking;
  // the adapter only supplies the data:
  pricing: {
    // Newest first. `models` keys are the exact model strings parseLine emits.
    versions: [{ version, effective, source, models: { '<model-id>': { input, output } } }],
    aliases: { /* shorthand → full model id */ },   // rates are $ per MILLION tokens
  },
};
```

### The built-in no-op adapter (reference for "off" values)

```js
{
  name: 'none',
  worktree:    { detect() { return null }, branchPrefix: null },
  transcripts: { supported: false, root() { return null }, list() { return [] },
                 findBySession() { return [] }, parseLine() { return null } },
  pricing:     { versions: [], aliases: {} },
}
```

With the no-op adapter: worktree detection falls back to the engine's generic
markers + registry/basename; `collectUsage()` harvests nothing (usage AND
activity); `priceFor()` returns `{ costUSD: null }` so tokens still ledger but
cost is never invented. The portal's attention/cost activity views render empty;
the commits heatmap (pure git) keeps working with no agent at all.

## Adding an agent

1. Create `integrations/<name>/adapter.mjs` implementing the contract above.
2. Implement `detect()` so it claims only environments your agent actually runs in.
3. Ship your driver files (skills / commands / hooks / instructions) in whatever
   shape your agent consumes — see `integrations/claude/` for the reference, which
   is also packaged as a Claude Code plugin.
4. Select it with `COGYARD_INTEGRATION=<name>` or `~/.cogyard/config.json`, or rely
   on auto-detect.

The contract is the only coupling — the engine never imports your adapter by name.
