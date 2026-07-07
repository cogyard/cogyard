# drivers/claude — the Claude Code driver

This directory is **both** the reference driver adapter (`adapter.mjs`, the
three engine seams — see `../../docs/DRIVERS.md`) **and** a Claude Code plugin
(the `skills/`, `commands/`, `hooks/`, `.claude-plugin/plugin.json`). Cloning
cogyard gets you a working driver.

## Install

The plugin references **nothing outside itself** — its skills/commands call the
`cogyard` CLI on PATH and its hooks run `cogyard hook …` (the engine entrypoints).
So the engine is installed separately (as the `cogyard` command) and the plugin is
copy-to-cache-safe:

```
# 1. the engine → puts `cogyard` on PATH
npm i -g @cogyard/cli          # or, in a clone: npm link

# 2a. the driver, Claude-native (works as a remote OR local marketplace):
/plugin marketplace add cogyard-dev/cogyard
/plugin install cogyard@cogyard

# 2b. or, where /plugin is unavailable (some Claude UIs):
cogyard claude install         # copies skills/commands into ~/.claude, prints the
                               # settings.json hook lines to add
```

**Dev loop** (single source of truth = this repo, nothing copied):

```
npm link                                                         # `cogyard` → this repo; cli/+core/ edits live
claude --plugin-dir /abs/path/to/cogyard/drivers/claude     # skill/hook edits load from the repo in place
```

Skill edits apply live mid-session; hook/command edits need `/reload-plugins` or a
new session. `plugin.json` may carry a `version` (for published releases) or omit it
(commit-SHA versioning) — either works now that the plugin is self-contained.

## What ships here

The plugin ships the task system itself: the `pickup-task` / `write-task` /
`handoff` / `commit` / `debt-cleanup` skills, the `/cogyard` portal command, and the
worktree-wiring + frontmatter-validator + task-skill hooks. Everything is
self-contained — skills and commands call the `cogyard` CLI on PATH, hooks run
`cogyard hook …`, so nothing references a path outside this directory.

When editing skills, keep the portability bar: no machine-specific paths, no dead
features — CLI invocations go through the `cogyard` bin on PATH, `commit` gates
itself to cogyard-managed repos, `handoff`/`debt-cleanup` state the `_tasks/`
assumption with a fallback, and every referenced file/tool must resolve on a clean
install.
