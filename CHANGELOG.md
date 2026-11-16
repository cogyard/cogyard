# Changelog

All notable changes to cogyard are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and cogyard adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Only *released* versions appear here. cogyard's version counter (the root
`package.json`) advances on every merge, but npm and the public GitHub repo see
only the versions actually cut with `bin/publish-snapshot` — so this history
mirrors the `v*` release tags, not every intermediate bump.

## [Unreleased]

## [2.0.0] — 2026-11-15

**Upgrading from 1.x.** This release changes what you type and where cogyard
looks for its files:

- cogyard's skills and commands are now `/cogyard-<name>` (`/cogyard:<name>`
  as a plugin). Re-run `cogyard claude install` to move an older install's
  links to the new names.
- `.claude/worktree-config.json` and a top-level `_tasks` link are no longer
  read. Move them into `.cogyard/` — the steps are under Removed below.
- `cogyard tasks init` is gone. Use `cogyard init` for a new project and
  `cogyard onboard` for an existing folder.
- A dev script gets its worktree ports from `cogyard env ports`;
  `.env.worktree` no longer carries them.
- An `env_files` entry with `strategy: "copy"` or `strategy: "merge"` is
  refused. Delete the `"strategy"` key.

### Added

- **Plan tab** — what's left, as lanes in the order it can run, filtered by who
  does it and what it blocks. A Recently done strip sits at the top; each card
  shows the task's type icon, its tags, and one square per checkbox, marking
  whether a ticked box's code is on `main`.
- **Live agent state** — each claimed task shows whether its agent is working,
  needs you, stopped, or is idle with a background job still running, on the
  Plan and Tasks tabs.
- **Project switches** — two per-project settings: rebase onto main (`always`
  or `ask`) and the version bump on merge (`off`, `minor`, `patch`, or your own
  command). `cogyard tasks switches` shows them; the project's Admin → Settings
  page changes them. A project that sets nothing keeps today's version bump.
- **Admin tab** — each project's cog is now an Admin tab with Info (where the
  project and its tasks live on disk, publishing), Settings (switches, sidebar
  icon, label axes), Stats and Cleanup. You can also choose which tab a project
  opens on, and give each project a sidebar icon.
- **Cleanup** — one place to see what can be reclaimed across every project:
  finished worktrees, disk, and chats, with what blocks archiving each one.
  Remove several worktrees at once; `cogyard cleanup` can also remove a clean,
  unmerged worktree once its branch is pushed.
- **Task store view** — the Graph tab's Code / Task store switch shows a
  project's task-store commits, its uncommitted files, and a flag on any commit
  that took something a store shouldn't hold.
- **`cogyard tasks close` and `cogyard tasks reopen`** — closing a task is a
  command that checks every box is ticked or settled and the branch is merged;
  a wrong close can be undone. `--enough` and `--force` are for the project
  owner.
- **`cogyard publish`** — a project declares how it deploys in
  `.cogyard/publish.json`, and publishing is one checked sequence: main matches
  origin, checks pass on that commit, deploy, `/health` serves exactly that
  commit, then the version is tagged. Only a person can run it, never an agent.
  A push to main no longer deploys anything.
- **Scheduled add-on jobs** — an add-on can run on a timer, unattended, with
  its own section on the Settings page. Three ship under `extras/addons/`: a
  nightly project brief (shown on the Daily tab), a doc-drift check that finds
  docs your tasks left behind, and a chat archive that keeps a private copy of
  every Claude Code chat.
- **Credential store** — `~/.cogyard/secrets.env` (mode 0600) holds the
  credentials add-ons and publish steps need; no other surface ever sees a
  value.
- **Model prices update themselves** from a published rate table, and
  scheduled jobs' usage appears in the cost ledger as its own rows.
- **`cogyard env ports`** — one line for a dev script to ask which ports it
  should bind in a worktree.
- **`cogyard sessions show` and `cogyard sessions search`** — read or search
  your Claude Code chats from the terminal (and `/cogyard-lookup-chat` in a
  session). A task's Chats panel shows the Claude Desktop chat title.
- **Autopilot skill** — runs several tasks through pickup and merge without
  you: its questions are asked up front, and it stops at the merge point.
- **Onboarding reconciles a project's own process** — when a project already
  has its own merge or commit instructions, `cogyard onboard` asks which one
  wins, and `cogyard tasks doctor` flags projects where both apply.
- **Project kinds beyond npm web apps** — a kind can say it has no dev server,
  stamp its version its own way, and name the files onboard should expect.
- **Files tab compares against `main` or against the last commit**, with one
  status badge used everywhere.
- **An Update pill** appears when a newer portal build is out; switching tab or
  project loads it.
- **cogyard's own guards ship with the plugin** — refusing a `git add` on the
  task link, `pkill` / `killall` (which would stop the portal), moving the main
  checkout off `main`, git commands that write inside a task store, and hand
  edits to a task's status, its claim fields, or a worktree's launch file.
  `cogyard claude install --rules` also writes cogyard's operating rules into
  your `CLAUDE.md`.

### Changed

- **cogyard's skills and commands are now `/cogyard-<name>`** when installed
  with `cogyard claude install` (`/cogyard` stays `/cogyard`), and
  `/cogyard:<name>` as a plugin, so they never take a name your own skills, a
  project's, or Claude Code's use. Re-running `cogyard claude install` moves an
  older install's bare-name links to the new names. A name that is in use
  anyway is not linked, and the output says why; `--link-anyway <name>` links
  it regardless. Asking in your own words ("merge it") works as before.
- **A project's cogyard files live in `.cogyard/`.** The worktree config is
  `.cogyard/worktree.json` and the link to the project's task store is
  `.cogyard/tasks` (ignored by a committed `.cogyard/.gitignore`). Nothing about
  the task store itself moves: it stays at `<COGYARD_PROJECTS_ROOT>/_tasks/<slug>`.
- **`cogyard init` and `cogyard tasks convert` create the store directly.** A
  repo that already keeps its tasks in an in-repo `_tasks/` folder has it adopted
  into the new store; otherwise the store starts empty.
- **The Plan tab waits only on real dependencies.** A task waits only for the
  tasks in its `depends_on`. Two tasks that edit the same file (or use the same
  `resources`) are noted on the card, never held back.
- **A task's status changes only through its commands**, and a claim is valid
  only on an OPEN task. `cogyard env claim` and `release` now commit the task
  file themselves on a store with no remote.
- **Merging closes the task.** `merge-to-main` runs the checks that waited on
  the merge, treats the owner's "merge it" as their review, and closes the task
  as DONE.
- **Picking up a task always works in that task's own worktree**
  (`task-<id>-<slug>`), and asks no "worktree or main?" question unless you say
  "on main".
- **Task chips** use distinct, colour-blind-safe colours ("Ready" is now
  "Idle"), and clicking one opens the task expanded.
- **The Tasks tab toolbar** has Grouping and Filters rows, with the search box
  and its clear button among the filters.
- **`cogyard tasks doctor`** shows each project's task link as ok, broken,
  missing or folder, with the fix.
- **Every release is tested as a user meets it** — a clean install in an empty
  container, an upgrade over the previous release, the Claude plugin, and the
  copy npm actually serves.

### Removed

- **`cogyard tasks init`.** `cogyard init` (new project) and `cogyard onboard`
  (existing folder) are the only ways to set a project up.
- **Ports in `.env.worktree`.** The worktree hook no longer writes a copy of
  the worktree's ports there; a dev script asks `cogyard env ports` instead.
- **The multi-clone ("planet") layout.** One registry entry is one project.
- **Env files are always linked into a worktree, never copied.** The
  `strategy: "copy"` and `strategy: "merge"` options of `env_files` in
  `.cogyard/worktree.json` are gone: every entry becomes a link to the project
  root's file. A copy was one more place a secret sat and drifted, and writing it
  replaced whatever was at the target — including a link to env files kept
  outside the repo. A config that still names either is refused, and the
  worktree is not wired until it is fixed. **Upgrading:** delete the
  `"strategy"` key from each such entry (or set it to `"symlink"`) in the
  project's main checkout and commit; every worktree then reads the main
  checkout's file.
- **The old paths are no longer read.** `.claude/worktree-config.json` and a
  top-level `_tasks` link are ignored everywhere. A project still on them loses
  its worktree wiring and its task list until it is moved. **Upgrading from an
  older version**, in each project's main checkout:
  `git mv .claude/worktree-config.json .cogyard/worktree.json` (if the project
  has one), then replace the `_tasks` link with a `.cogyard/tasks` link to the
  same store, add `/tasks` to `.cogyard/.gitignore`, and commit. Each worktree
  needs its own `.cogyard/tasks` link too — `cogyard tasks mount` inside it.
- **`INDEX.md` is no longer generated.** `cogyard tasks sync push` and
  `cogyard tasks close` stop writing and committing it, and `cogyard tasks` with
  no subcommand prints help instead of writing it. Nothing read it; it put a
  generated file into every task-store commit. Use `cogyard tasks plan` (what's
  left), `cogyard tasks current` (what's claimed) or `cogyard tasks find <id>`.
  A store that still holds an `INDEX.md` shows a "leftover INDEX.md" flag in
  `cogyard tasks doctor` and the portal until the file is deleted
  (`git rm INDEX.md` in the store, then commit).

### Fixed

- **Plugin users got none of cogyard's hooks** — the plugin's hooks file was in
  a shape Claude Code didn't load.
- **`cogyard init` inside an existing repo wired the outer repo** — it asked git
  for the repo root, got the enclosing repo, and edited its `.gitignore` and
  registered it. It now refuses, with a message.
- **A chat the desktop app starts in a worktree got no worktree setup** — the
  hook was handed the main checkout's path. It now finds the worktree from the
  folder the session started in.
- **A chat that moves into a worktree partway through couldn't start its dev
  server** — the preview tool read the main checkout's `launch.json`. Each
  worktree now gets its own.
- **`sync push` committed other chats' task files** (same-branch claims and
  unclaimed new files), **refused a deleted file whose folder was gone**, and
  **let the shell expand `$` and backticks** in the commit message. It also
  **crashed on a machine with no git name or email**, and now **accepts a
  repo-relative path** after `--`.
- **A claim on a local-only store was never committed**, so every other chat's
  `sync push` refused the file.
- **Writing or ticking a task file raised a permission prompt** — sessions were
  handed the task link's path, not the real store path.
- **`tasks find 033` failed when the file said `id: 33`.**
- **The Plan tab hid tasks** — parked tasks, tasks on the retired BLOCKED_ON
  status, and a claimed task whose worktree was gone.
- **The progress fraction counted settled boxes as unfinished.**
- **Nightly job output was written into task stores**, never committed, and
  swept into unrelated commits. It now lives under `~/.cogyard/`, and a project
  whose slug changes keeps its Daily history.
- **A slow agent call was killed as if it were dead** — scheduled jobs now tell
  a stalled call from a slow one.
- **The portal re-checked about ten times a second** on pages with a single
  task chip, swallowing clicks and flickering tooltips.
- **Clicking a task chip hid most of the Tasks list** behind a filter you
  couldn't see.
- **The Git graph** showed no node for uncommitted changes, and never showed an
  old branch's head (it loaded only the newest 250 commits). The release tag is
  now gold, not the same green as an Idle chip.
- **The Branches tab** cut off its second Tracking flag, and a branch's task
  link lagged until a ref moved. The main checkout showed an unrelated task
  chip on the Worktrees tab.
- **The Files tab tree** indented root-level files under the last folder.
- **The Cleanup tab** held finished chats as "task not done" because of tasks
  they had only looked up, and hid empty tables.
- **"Chat closed" showed on chats still open in Claude** — it now says "chat
  archived" or "chat deleted". A rewound chat no longer loses its title.
- **The dev-server guard** refused `node --test server/…` and one-shot scripts
  under `server/`, and its done-check blocked every reply instead of once per
  chat.
- **`session-start` silently did nothing on a relative path.**
- **`cogyard env release --help` crashed**, and `port-owner --help` treated
  `--help` as a port.
- **`cogyard doctor` said "no projects registered"** when a project was still
  on the old `_tasks` link; both doctors now name it and its fix.
- **The Category axis selector** listed axes with no lanes.

## [1.53.0] — 2026-08-05

### Added

- **Tab icons** — each tab in the per-project strip (Tasks, Board, Branches,
  Worktrees, Graph, Files, Stats) now carries a small outline icon before its
  label, tinting with the tab's active state.
- **`cogyard tasks find <id | slug | file>`** — resolves a task reference to its
  file path. The authoritative answer to "where is task NNN", replacing guesses
  at the filename convention.
- **Escape collapses an expanded task row**, whether the pointer is over the row
  or over its expanded detail region.
- **The live demo shows a task's chats** — expanding a task in the demo now
  renders the Chats box with real labels across its created, implemented, and
  mentioned buckets, and clicking a chat opens the transcript popup with
  content.

### Changed

- **The demo endpoint-coverage guard runs at merge time.** The check that
  catches an SPA endpoint the demo crawler doesn't export now runs in CI on
  every push to `main`, not only in the nightly demo refresh. Previously the
  gap was introduced on one commit, passed CI green, rode into the next release
  tag, and only surfaced days later as a red nightly against a stale tree. It
  stays in the nightly too.

### Fixed

- **`tasks sync push` no longer commits other sessions' work.** A project's task
  store has a single working tree shared by every worktree, and `sync push`
  staged and committed all of it (`git add .` followed by a pathspec-less
  commit). Whichever session pushed first absorbed every other session's
  uncommitted task edits under its own message; the other session's later push
  then printed "Nothing to commit." with no sign that anything had been taken.
  `sync push` and `analyze --apply` now commit only the caller's paths, and
  report other pending files rather than swallowing them.
- **Task lookup no longer depends on a stale index.** Resolving a task id to a
  file was documented as reading `_tasks/INDEX.md`, but nothing ever read that
  file back and it had gone months out of date, while the CLI quietly used a
  different directory scan. `sync push` now regenerates `INDEX.md` and folds it
  into the same commit, so it stays current.
- **`sync push` on a plain `_tasks/` directory.** Git reports paths relative to
  the repository root, not the directory it was invoked in. For projects whose
  `_tasks/` is a normal tracked directory rather than a shared-store symlink,
  `sync push` built pathspecs like `_tasks/001-foo.md` and ran them from inside
  `_tasks/`, failing with `fatal: pathspec ... did not match any files`.
- **The Files tab scrolls properly.** The tree sidebar and the open-file pane
  now scroll independently instead of the whole page moving as one block. Their
  own CSS was already correct but inert — no ancestor passed a bounded height
  down the chain, so neither pane had a fixed-height box to scroll inside.
- **The Graph tab** no longer lists worktree pseudo-rows alongside real branches
  and commits.

## [1.47.2] — 2026-07-24

### Added

- **Find the chats behind a task** — every task now links to the Claude chats
  that created, implemented, and mentioned it, and you can read a chat's
  transcript in a popup right from the portal (or from the CLI with
  `cogyard sessions chats <id>`, or the `/task-chats` command). The lookup is
  durable: it survives archiving a chat and removing its worktree.
- **Archived-chat cleanup** — `cogyard sessions audit` / `archivable` / `retire`
  (and a `/retire-chat` command) find finished chats and, once a chat's branch is
  merged and its worktree clean, archive the chat and remove the leftover
  worktree — gated, one typed confirmation at a time, never touching transcripts.
- **Label axes** — group and color tasks by label in the portal. A category
  grouping renders two-level lanes, a Settings axis manager curates the axes, and
  each project's axis map lives in its task store.
- **Per-task cost** — token cost is attributed to a task from its banked activity
  (its own commits and references), not only from formal claims, and the Tasks
  view gains a sortable Cost column.
- **Worktrees Links column** — quick links surfaced per worktree.

### Changed

- **Tasks view redesign** — status, type, and label-category are now three
  independent axes: flat or grouped, a group-by control, and a type filter, so
  each answers exactly one question.
- **Task `category` field renamed to `type`** (one of feature / maintenance /
  bug / docs). Older files that still carry `category:` are read transparently.
- **Portal design-system pass** — the SPA moved onto shared typography, spacing,
  badge, and button recipes with a single type ramp, spacing scale, and table
  density. A large visual-consistency cleanup with no behaviour change.
- **Pre-push safety** — pushing to `main` now runs the CI gates (tests,
  leak-scan, manifest-check) locally first and blocks a push that would break CI.
- **Worktree port pool** relocated to 30000–30999 / 31000–31999.

### Fixed

- The chats list no longer over-attributes a task from an incidental mention in a
  transcript (a `git log` dump, a directory listing): only a chat's dominant
  signal counts, so a task's chats are the chats that actually worked it.
- The Files tab distinguishes untracked files and directories from real
  additions.
- Per-task cost stays numeric on the wire — a stringified id had silently emptied
  the per-task usage box.
- Table layout fixes across Branches, Worktrees, and the git graph: narrow-width
  column collapse, cell truncation, ref chips showing the branch name, and the
  worktrees table filling the available width.

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
