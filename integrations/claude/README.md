# integrations/claude — the Claude Code driver

This directory is **both** the reference integration adapter (`adapter.mjs`, the
three engine seams — see `../../docs/INTEGRATIONS.md`) **and** a Claude Code plugin
(the `skills/`, `commands/`, `hooks/`, `.claude-plugin/plugin.json`). Cloning
cogyard gets you a working driver; before task 038 the driver lived only in the
owner's private `~/.claude` dotfiles and shipped with nothing.

## Install

The plugin references **nothing outside itself** — its skills/commands call the
`cogyard` CLI on PATH and its hooks run `cogyard hook …` (the engine entrypoints).
So the engine is installed separately (as the `cogyard` command) and the plugin is
copy-to-cache-safe (Phase 2.5, task 038):

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
claude --plugin-dir /abs/path/to/cogyard/integrations/claude     # skill/hook edits load from the repo in place
```

Skill edits apply live mid-session; hook/command edits need `/reload-plugins` or a
new session. `plugin.json` may carry a `version` (for published releases) or omit it
(commit-SHA versioning) — either works now that the plugin is self-contained.

## Provenance (task 038, 2026-06-19)

The skills + commands + the task-skill hook were **copied** from the owner's
`~/.claude` dotfiles (a separate git repo, so history isn't preserved — this note is
the record). The `bd-` prefix was dropped (the `cogyard:` namespace disambiguates):

| dotfiles source | here |
|---|---|
| `skills/bd-pickup-task` | `skills/pickup-task` |
| `skills/bd-write-task` | `skills/write-task` |
| `skills/bd-handoff` | `skills/handoff` |
| `skills/commit` · `debt-cleanup` | same names |
| `commands/cogyard.md` | `commands/cogyard.md` |
| `hooks/userpromptsubmit-task-skill-guard.sh` | `hooks/userpromptsubmit-task-skill-guard.sh` |

**Deliberately NOT vendored.** The cogyard driver ships only the task system itself
(plus its hooks + the portal command). Things specific to the owner or the owner's
projects stay in the dotfiles (they're a personal dev toolbox / future add-on, not
the cogyard core):

- `skills/bd-scaffold-angular`, `skills/bd-scaffold-fullstack` — the owner's exact
  frontend/backend stacks (PrimeNG, Font Awesome Pro, DigitalOcean, Supabase,
  pg-boss, …) and named projects.
- `skills/bd-verify-deploy` — assumes the owner's DigitalOcean `/health` deploy shape.
- `skills/merge-to-main` — the owner's versioning policy + named per-project exceptions.
- `commands/bd-chats.md` — a general local-transcript browser, not cogyard.

Also out (global/personal or private-dep): `hooks/pretooluse-bash-guard.sh`,
`pretooluse-edit-guard.sh`, `read-claude-md-files.sh`, the `/brain` command (needs
the owner's private Open Brain MCP), and the `auto-capture` / `panning-for-gold` /
`team` skills.

## Known follow-up (not in task 038's scope)

The vendored skills still contain **hardcoded `~/gitroot/cogyard/...` CLI paths** —
correct on the owner's machine, but a stranger's clone lives elsewhere. Task 038
scoped this as "copy verbatim + provenance note"; generalizing those paths (to a
repo-relative / `${CLAUDE_PLUGIN_ROOT}`-relative invocation) is a follow-up before a
public release. The clean-install test (task 038 Phase 3) surfaces it.
