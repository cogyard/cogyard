# Changelog

All notable changes to cogyard are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and cogyard adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Only *released* versions appear here. cogyard's version counter (the root
`package.json`) advances on every merge, but npm and the public GitHub repo see
only the versions actually cut with `bin/publish-snapshot` — so this history
mirrors the `v*` release tags, not every intermediate bump.

## [1.32.0] — 2026-07-14

### Changed

- **Messaging** — cogyard now describes itself as *"from AI chats to shipped
  products"*: keep track of multiple projects running at once — every task,
  worktree, and merge across every project in one place. The README tagline and
  npm description were reframed accordingly (previously "task coordination for
  parallel AI coding agents").
- CI actions bumped to v5 (`actions/checkout`, `actions/setup-node`) for the
  Node 20 runtime deprecation.

### Added

- **Push-triggered CI** — the test suite and a secret/leak scan now run on every
  push to `main` (Ubuntu), not only when cutting a release.
- **Manifest-completeness gate on every push** — CI checks the public-publish
  allowlist against the tree (the same Layer 1 check `bin/publish-snapshot`
  runs), so any new file that hasn't been classified public-or-private is caught
  on push rather than at release time.

## [1.27.3] — 2026-07-12

### Added

- **Live demo** — a clickable, read-only copy of the portal at
  [cogyard.com/demo](https://cogyard.com/demo): five sample projects with
  tasks, worktrees, branches, git graphs, files, and cost stats to explore
  without installing anything.
- **All-projects cost heatmap** — a git-style contribution grid at the bottom
  of the overview page showing spend across every project at a glance.

### Changed

- **Task buckets rework** — task lists now group into Ready / Claimed /
  Waiting / Done, each bucket showing only the columns that matter for it.
  The hand-set "blocked" status is retired: a task waiting on another derives
  its state from `depends_on`, and external holds are `PARKED`.
- **Sidebar and dock badges** now count worktrees with unmerged work instead
  of claimed tasks — the number now answers "what's in flight," not "what's
  on paper."
- The logo's star center is now a six-tooth cog.
- Release tags on the Graph tab render as solid green milestone chips and
  lead the ref-chip row.

### Fixed

- `claude-sonnet-5` was missing from the model price table, so sessions on it
  showed no cost (`costUSD: null`) in every cost view.
- Files tab threw Angular NG0100 errors — a worktree pill's relative-time
  label read the clock during template rendering.
- Overview table columns overlapped and garbled at ~1200 px viewports.
- The Tasks table's Claimed column truncated claimant names.
- The claimed-by checkmark tooltip rendered as a one-character-wide vertical
  column.

## [1.15.0] — 2026-07-06

### Added

- **Add-on ecosystem** — a per-project Settings tab that renders whatever add-ons
  you install. Drop-in runtime capabilities loaded from `~/.cogyard/addons/`; core
  ships the contract, loader, and `/api/addons` surface and zero add-ons. Project
  `kind` is a discovered scaffold registry too.
- **File editing in the Files tab** — edit and save small changes in place via the
  portal's first write endpoint, `POST /api/file` (same-origin, hash-guarded,
  atomic), with optional prettier format-on-save.
- **Stats tab** — the per-project Activity tab is now **Stats**: a month calendar
  (cost, commits, and per-day merge badges), an attention heatmap, and a sortable
  Cost column on Worktrees. The usage/cost table moved here out of the Tasks tab.
- **Hide unused project tabs** — a global Settings preference (`ui.hiddenTabs`)
  hides any subset of the tab strip.
- **Multi-user v1 (team task stores)** — share a project's task store across a team
  over its git remote: claims carry the holder's identity, `cogyard tasks join
  <remote>` onboards a member, and id reservation syncs so two machines can't mint
  the same id.
- **Release notes** — releases now ship a CHANGELOG, notes embedded in the git
  tags, and a GitHub Release, enforced by the publish pipeline (a release can't
  ship without notes).
- **One-command project bootstrap** — creating a "New" project wires the folder,
  `git init`, a shared task store, the registry entry, and worktree ports end to
  end; scaffolding the actual app is a separate step afterward.

### Changed

- **`driver` is the settled name** for the agent-adapter concept — directory, env
  var, config key, API field, and docs all use it now.
- **Claims persist until merge** — a finished-but-unmerged task stays claimed
  ("in review"); releasing moves to the merge step.
- **Plugin skills scoped for third-party install** — the shipped Claude Code skills
  trigger only in cogyard repos, and the hardcoded co-author trailer was removed.

### Removed

- **The `normal` task-store mode** — the shared symlink store is now the only model;
  `normal` was broken under worktrees (each worktree got a divergent per-branch copy).

## [1.0.0] — 2026-07-03

Initial public release — the full cogyard system, agent-agnostic end to end.

- **Markdown task files** (`_tasks/NNN-*.md`) with a v2 YAML frontmatter schema,
  a Node data/CLI engine (`core/` + `cli/`), and an Angular + PrimeNG portal
  reading a read-mostly `/api`.
- **Worktrees, claims, and ports** — atomic task claims across parallel sessions,
  per-worktree port allocation, shared task stores via symlink, and a SessionStart
  hook that wires it all up automatically.
- **Agent-agnostic core** — Claude Code ships as the reference driver under
  `integrations/claude/` (and the repo is its own Claude Code marketplace); any
  other agent plugs in against the `docs/INTEGRATIONS.md` contract.
- **Tunnels** — expose a worktree's dev server at a stable Cloudflare hostname
  that follows whichever worktree you're working in.
- **The always-on portal** at `http://cogyard/` — the live cross-project view.
