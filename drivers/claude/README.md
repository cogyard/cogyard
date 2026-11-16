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
npm i -g cogyard          # or, in a clone: npm link

# 2. the driver:
cogyard claude install         # links skills/commands into ~/.claude (--copy to
                               # copy), prints the settings.json hook lines to add

# 2, as a plugin instead (works as a remote OR local marketplace):
/plugin marketplace add cogyard/cogyard
/plugin install cogyard@cogyard
```

`cogyard claude install` is the main route: every skill and command is
`/cogyard-<name>` (the `/cogyard` command keeps its name), and any skill can be
switched off per project (below). The plugin wires the hooks for you, but its skills
are `/cogyard:<name>` and switch on or off only as a whole. Either way you rarely
type a name: asking in your own words ("pick up 37", "merge it") runs the skill.

## Name clashes

In Claude Code a **personal** skill or command — which is what install puts in
`~/.claude` — beats a project's skill or command of the same name in every repo
on the machine, and replaces a built-in command of the same name
(code.claude.com/docs/en/skills, "Resolve skills that share a name"). People add
their own personal skills, and projects carry their own, so cogyard must never
take one of their names:

| Route | Name | A project's or person's own `merge-to-main` |
|---|---|---|
| `cogyard claude install` | `/cogyard-merge-to-main` (a personal skill named by its link's folder) | untouched — loads beside cogyard's |
| plugin | `/cogyard:merge-to-main`; bare `/merge-to-main` only while nothing else uses it | untouched — loads beside cogyard's |

The shipped skills carry no `name:` line in their frontmatter, so Claude Code
names each by its folder: the link's name personally, the source folder under
the plugin. A `name:` line would claim the bare name again.

An older install linked them under the bare names. Re-running
`cogyard claude install` moves those links (from the same checkout) to the new
names and lists each move; a bare-name link into another cogyard checkout is
left, with a note to re-run install from there.

Install still checks each `cogyard-` name before linking it — against every
registered project's `.claude/skills/` and `.claude/commands/` and against
Claude Code's built-in command names (`builtin-names.json`, copied from Claude
Code's docs — it exposes no list to read; the file says when it was last
checked). A name in use is **not linked**; the output says who uses it and what
would happen, and offers two ways on:

- take that one from the plugin, as `/cogyard:<name>`;
- or link it regardless: `cogyard claude install --link-anyway <name>[,<name>…]`.

A link left by an earlier install is never removed by a re-run when it clashes —
install prints what it hides and the `rm` that removes just that link. Uninstall
removes cogyard's links under both names, and leaves any bare-name folder that
is not a link (it may be the person's own). On an existing install,
`cogyard tasks doctor` lists every clash in one section: a project skill or
command that never runs (a bare-name link from an older install hides it), one
that runs beside cogyard's, and any cogyard name that is a built-in. To resolve
one in a project: rename the project's skill or command, or delete it — or, for
a skill, keep it as the project's replacement (below). Neither command edits
another repo.

Keeping `builtin-names.json` current: re-read the two docs pages, update the
lists and `checked`. `COGYARD_NET_TESTS=1 node --test test/claude-install.test.mjs`
compares the file with the live commands page.

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
`handoff` / `commit` / `debt-cleanup` / `autopilot` skills, the `/cogyard` portal command, and the
worktree-wiring + frontmatter-validator + task-skill hooks. Everything is
self-contained — skills and commands call the `cogyard` CLI on PATH, hooks run
`cogyard hook …`, so nothing references a path outside this directory.

When editing skills, keep the portability bar: no machine-specific paths, no dead
features — CLI invocations go through the `cogyard` bin on PATH, `commit` gates
itself to cogyard-managed repos, `handoff`/`debt-cleanup` state the task-directory
assumption with a fallback, and every referenced file/tool must resolve on a clean
install.

## Skipping or replacing a skill in one project

Claude Code never merges two skills. cogyard's never share a name with a
project's (above), so a project skill named `merge-to-main` loads BESIDE
cogyard's: both apply, and nothing says which wins. Pick one per project.

**Installed with `cogyard claude install`** — the skills are personal skills
(`~/.claude/skills/cogyard-<name>`), and can be turned off per project:

- **Skip a skill in one project** — in that project's `.claude/settings.json`
  (shared with everyone on the repo) or `.claude/settings.local.json` (just you):
  ```json
  { "skillOverrides": { "cogyard-merge-to-main": "off" } }
  ```
  `"off"` hides it from Claude and the `/` menu; `"user-invocable-only"` keeps
  `/cogyard-merge-to-main` typeable but stops Claude reaching for it on its own.
  The key is cogyard's personal name, so a project skill named `merge-to-main`
  stays on. (An older install's bare-name link answers to `"merge-to-main"`.)
- **Replace a skill in one project** — turn the cogyard one off as above and give
  the project's skill a name of its own (e.g. `publish`), not cogyard's. Put
  `Replaces cogyard's <name>. Last reconciled against it: <date>.` at its top:
  the project's skill must be complete on its own (cogyard's is off), and
  `cogyard tasks doctor` warns when cogyard's has changed since that date.
  `cogyard onboard` does all of this for a merge or commit process it finds in
  the project's docs, when the owner chooses to keep it (`docs/PROJECT-INIT.md`,
  "One process, one place"), and doctor flags a project skill that is merely
  named like a cogyard skill and runs beside it.

**Installed as a plugin** — the skills are namespaced (`cogyard:merge-to-main`), so
a project skill named `merge-to-main` loads beside it rather than replacing it, and
`skillOverrides` does not apply to plugin skills (the plugin is turned on or off as
a whole, through `/plugin`).

**Adding a project's own steps to a skill** — there is no way to extend a skill.
Put the project's specifics in its `CLAUDE.md` — always loaded, and every cogyard
skill follows it (e.g. the after-merge steps `merge-to-main` and `autopilot` run).
A longer set can live in its own doc that `CLAUDE.md` points at.
