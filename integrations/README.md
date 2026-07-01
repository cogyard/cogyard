# integrations/ — driving cogyard with any agent

cogyard's engine (`core/`) and CLI (`cli/`) are **agent-agnostic**. Three things are
inherently agent-specific — worktree layout, transcript format, model pricing — and
they live behind a small **adapter** the engine resolves at runtime (task 038). An
integration is a directory here:

```
integrations/
  claude/          <- the reference adapter AND a Claude Code plugin
    adapter.mjs    <- implements the three engine seams
    skills/ commands/ hooks/ .claude-plugin/   <- the plugin (Claude's driver files)
    instructions.md
  <your-agent>/    <- same shape: your adapter.mjs + your own driver files
```

## Adding an agent — the contract

1. Create `integrations/<name>/adapter.mjs` whose default export implements the
   adapter interface. The full contract + the no-op reference values are in
   **[`../docs/INTEGRATIONS.md`](../docs/INTEGRATIONS.md)**. The three seams:

   - **`worktree`** — `detect(path)` → `{parentRepo, name}` for your agent's
     worktree layout (or null); `branchPrefix`.
   - **`transcripts`** — `supported`, `root()`, `list()`, `findBySession(id)`,
     `parseLine(line)` → `{sessionId, cwd, usage}` for the usage ledger. Return
     `supported: false` if your agent has no transcripts (usage degrades gracefully).
   - **`pricing`** — `versions` (price table) + `aliases`.

   Plus `detect()` — is your agent the active driver in this environment?

2. Ship your driver files (skills / commands / hooks / instructions) in whatever
   shape your agent consumes. `claude/` is the worked example.

3. Select your integration with `COGYARD_INTEGRATION=<name>`, `~/.cogyard/config.json`
   `{ "integration": "<name>" }`, or rely on auto-detect (`detect()`).

The engine never imports your adapter by name — the contract is the only coupling.
With **no** integration active, the built-in no-op adapter in `core/integrations.mjs`
keeps the CLI + portal working for a plain human user.
