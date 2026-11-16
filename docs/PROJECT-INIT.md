# Project init + onboard — turning a directory into a first-class cogyard project

cogyard owns project creation. Two user-facing commands turn a directory into a
project that the portal sees and that worktrees get ports for — the two things
that silently failed when a project was hand-stitched (the classic failure
mode: a loose folder, never registered, invisible to the portal).

They split on **precondition only**:

| Command | Precondition | What it does |
|---|---|---|
| `cogyard init <name>` | **greenfield** — nothing on disk, and not inside another git repo | create the dir + `git init` + initial commit + a README, then wire (no app code — see "Thin New" below) |
| `cogyard onboard [path]` | **adopt** an existing folder (with or without git) | `git init` if absent, then wire — **additive-only**, never overwrites a file you already have |

Both converge on one shared core (`ensureProjectWiring()` in
[`core/scaffold.mjs`](../core/scaffold.mjs)) and end in a state where
`cogyard tasks doctor` reports the project clean. The portal's "New / Adopt"
sidebar button POSTs to the same core through the `requireSameOrigin` write seam —
identical behaviour, no second implementation.

## Thin New — cogyard does not scaffold your app

`init` is a **thin bootstrap**: it wires the project (git, portal registration, a
local-only shared task store, worktree ports, build-time version stamping) and seeds
a README — and nothing else. cogyard does **not** generate application code and does
**not** run anyone's scaffolding process. The usual flow is to make the app scaffold
your **first task**: create the project, then open it in your agent and scaffold the
app (framework, entry points, dev server) as your first task. The task store is created
**local-only**; publish it to a remote later (`cogyard tasks convert --remote <url>`)
only when the project becomes team-shared. The point of a fresh project is that the
write-a-task → do-the-task (worktree) loop works immediately.

## Two guarantees

- **Idempotent.** Safe to re-run on a half-set-up project. A second run reports
  every step "present" and changes nothing (clean working tree, no new commit).
  This is the recovery path: if a project is half-wired, just run `onboard` again.
- **Additive-only.** Every write is create-if-absent. `.gitignore` is the one
  append target (original content preserved as a prefix). An existing `package.json`
  is **never** modified — if it lacks a `version`, you get a warning, not an edit.
  `onboard` leaves every pre-existing file byte-identical — with one exception,
  and only on your explicit choice: a **process document** (a merge or commit
  process that sits beside cogyard's skill) is reduced to a pointer, plus the
  one agent setting that turns a cogyard skill off when you keep the project's
  own process. See [One process, one place](#one-process-one-place).

## Usage

```sh
# greenfield
cogyard init <name|path> --kind <k> [--remote <url>] [--no-wiring]
# adopt an existing folder
cogyard onboard [path]   --kind <k> [--remote <url>] [--no-wiring]
```

The task store is always **shared**: a new `~/gitroot/_tasks/<slug>` store (its
own git repo on a `tasks` branch), which the project reaches through the
`.cogyard/tasks` link, so every worktree mounts the same target. A repo that
already keeps its tasks in an in-repo `_tasks/` folder has that folder adopted
into the new store. (The old `--store normal` in-repo mode was removed — it's
broken under worktrees.)

| Flag | Default | Notes |
|---|---|---|
| `--kind` | *(required)* | `single` · `fullstack` · `static` · `library`, plus any installed community kind ([Kinds](#kinds)). Picks the wiring defaults (worktree ports on/off, dev command, version stamping) + the README; seeds **no** app code. |
| `--remote` | none | git remote for the shared task store (passed through to `convert`). |
| `--no-wiring` | off | skip `.cogyard/worktree.json`. Auto-skipped for `kind=library`. |

The portal: click **+ New** / **Adopt** at the bottom of the sidebar project list.

**`init` refuses a folder inside an existing git repo.** A bare name is created
under the current folder, so running `cogyard init demo` from inside any repo
asks for a project nested in that repo — and the wiring, which works from the
git root, would register, gitignore and commit into the OUTER repo instead.
Before creating anything, `init` checks the target (or, when it does not exist
yet, the nearest folder above it that does); if that is inside a repo, it stops,
names the repo it found, and writes nothing. The two ways out: choose a folder
outside that repo, or adopt the repo itself with `cogyard onboard <repo>` (in the
portal, **Add existing**). An empty folder that is its own fresh repo
(`git init` and nothing else) is still accepted. `onboard` is unchanged: given a
folder inside a repo, it adopts that repo. Both the CLI and the portal's
**+ New** go through `prepareInitDir` in `core/scaffold.mjs`, so both refuse the
same way.

## The wiring steps (`ensureProjectWiring`)

Each step is create-if-absent and reuses an existing primitive rather than
reimplementing it:

1. **git** — `git init -b main` if absent.
2. **register** — `registerProject()` → portal visibility (this is the step that
   was skipped on cogyard-site). The registry slug is the single source of truth.
3. **package.json** — create minimal (with a `version`) if absent; never touch an
   existing one (warn if it has no `version`).
4. **.gitignore** — append the essentials (`node_modules`, `dist/`, `version.json`,
   `.claude/launch.json`, `.env.worktree`). The task link is ignored by
   `.cogyard/.gitignore`, which `convert` commits — the root `.gitignore` gets no
   task line.
5. **skeleton** (init only) — a per-`kind` `README.md` only. No app code: the README
   states that cogyard seeds only wiring and that you scaffold the app as your first task.
   (`kind` still shapes wiring — e.g. `static` seeds a port-correct `dev` script,
   `library` sets `package.json` `main` — but never writes an entry file.)
6. **version stamping** — the kind's `versionStamp` decides. The default
   (`true`, every built-in but `library`) is a generated
   `scripts/generate-version.mjs` (the build-time version+SHA pattern from this
   repo's own [`scripts/generate-version.mjs`](../scripts/generate-version.mjs)),
   which writes `version.json`; `library` opts out (it exposes its version via
   `package.json`). A kind for a non-npm target names its own stamping files
   instead — see [Kinds](#kinds). Runs on onboard too.
7. **worktree wiring** — `.cogyard/worktree.json`, the **real opt-in** the
   port hook keys on ([`hooks/worktree-ports.mjs`](../hooks/worktree-ports.mjs)).
   Nothing else is seeded. There is no `worktree-projects.list` — that was
   documented but read by no code. **The port contract:** a worktree's ports live
   only in `~/.cogyard/ports.json`, and your `npm run dev` asks for them when it
   starts — `eval "$(cogyard env ports --shell || echo 'exit 1')"` — binding
   `$FRONTEND_PORT` (and `$PORT`). Never a hardcoded port, and never a port read
   out of a file: a copy goes stale, and a stale copy is how two worktrees bind one
   port with nobody noticing. Keep the `|| echo 'exit 1'` — `eval` reports its own
   status, not the command's. Outside a worktree the command prints nothing and the
   repo's own defaults stand. `cogyard init --kind static` seeds a `dev` script that
   already does all of this; `single`/`fullstack` leave `dev` to you (the config's
   `_comment` + the README state the contract).

   The config's `dev_script` is the kind's `devScript` — `npm run dev` unless the
   kind names another command, and **absent** when the kind declares none
   (`devScript: null`). No `dev_script` means "no dev server here": the port
   hook still reserves the worktree's ports but registers no preview entry, and
   the Stop-hook server check skips it (`docs/WORKTREE-PORTS.md`).

   A project that wants its env files in every worktree adds an `env_files` entry
   per file; each worktree gets a link to the project root's file, never a copy
   (`docs/WORKTREE-PORTS.md`). It must never carry a port.
8. **task store** — always shared via `convertToSharedStore` (extracted from
   `cogyard tasks convert`); the `⚠ no task directory` fix. No-ops when
   `.cogyard/tasks` is already a link; adopts a pre-existing in-repo `_tasks/`
   folder into the new store; otherwise starts an empty store. An old top-level
   `_tasks` LINK is refused with the steps to replace it.
9. **process docs** — a merge or commit process already written into the
   project's docs is moved into one place, on your choice. See
   [One process, one place](#one-process-one-place).

**Onboard looks at what it is adopting.** After wiring, onboard checks the
folder (its root and one folder down) for an `*.xcodeproj`, `*.xcworkspace`,
`Package.swift` or `platformio.ini`, plus any file an installed kind lists in its
`markers`. If the chosen kind does not claim what it finds, it **warns and
carries on** — it never refuses or picks a kind for you. The warning names the
file, what the kind seeded that may not fit (the `dev_script`, the npm stamper),
and an installed kind that claims it, or says none is installed. Onboard is
additive-only, so switching kinds afterwards means removing those files first.
The portal's Adopt shows the same warning.

## One process, one place

A project adopted into cogyard often already has its own way of merging or
committing, written in a doc. cogyard's `merge-to-main` and `commit` skills
apply there too, and unless something says which one wins, an agent follows
whichever it read last — including a doc that stopped being true long ago
(one that still said a push to main deploys production, weeks after that was
switched off).

**The rule: a process lives in exactly one place, and that place is a channel
the agent actually loads.** A doc is not such a channel for a skill: the agent
reads `CLAUDE.md` (always loaded) and runs skills, but a skill never reads
`CLAUDE.MERGE.md`. And a project skill with the same name as a cogyard skill
does not replace it:

- installed with `cogyard claude install`, cogyard's are personal skills named
  `cogyard-<name>`, and the project's loads beside them — both apply (a link an
  older install made under the bare name still beats the project's, which then
  never runs, until install is re-run);
- installed as a plugin, cogyard's are `cogyard:<name>` and the project's loads
  beside it — both apply.

So a project **replaces** a cogyard skill by turning cogyard's off for the
project (for Claude Code, `"skillOverrides": { "cogyard-merge-to-main": "off" }`
in `.claude/settings.json` — cogyard's personal name, so the project's own stays
on) and giving its own skill a name that is **not cogyard's**. Under a plugin install a skill can't be turned off for one project
(the plugin is on or off as a whole), so the always-loaded file says which
skill to use. No skill can extend another, which is why a project skill that
replaces cogyard's must be **complete on its own** — "follow cogyard's, except…"
points at a skill that is turned off.

**What onboard does.** Step 9 looks for a section of the agent's instruction
files (`CLAUDE.md` and its `CLAUDE.<topic>.md` siblings, for Claude Code) or of
`docs/*.md` that runs one of cogyard's processes — a numbered list or a code
block of two or more steps, containing `git merge` (merging) or, under a
heading about committing, `git commit` — with no project skill that replaces
that cogyard skill. A command only mentioned in prose ("never `git merge
main`") is not a step. A deploy or rollback process collides with nothing:
cogyard has no skill that deploys, so those docs stay the project's own facts.
For each process it finds, you choose:

| outcome | what happens |
|---|---|
| **adopt** | cogyard's skill runs it. The section becomes a one-line pointer to the skill. Anything in the old steps that is still true and that the skill doesn't know (what a push deploys) is yours to move into `CLAUDE.md`; onboard says so, and the old text is in git history |
| **keep** | the section becomes a project skill named `<slug>-merge` (or `-commit`) — never cogyard's name — with `Replaces cogyard's <skill>. Last reconciled against it: <date>.` at its top, and cogyard's skill is turned off for the project. The doc becomes a pointer. Under a plugin install, `CLAUDE.md` also says to use the project's skill |
| **facts** | cogyard's skill runs it. The old steps move into `CLAUDE.md`, quoted under a heading saying they are this project's differences from cogyard's skill, for you to trim to what really differs. The doc becomes a pointer |

In a terminal, `onboard` asks. Anywhere else (no terminal, the portal's Adopt)
it never guesses: it changes nothing, lists the doc in its warnings, and
`cogyard tasks doctor` keeps flagging it. `--reconcile merge-to-main=keep`
(comma-separated for more) makes the choice up front. Each choice is one commit
naming exactly the files it changed; the pointer carries a marker
(`<!-- cogyard:process merge-to-main=keep <date> -->`), so a re-run reports
"already reconciled" and changes nothing. With no agent driver active, only
`docs/*.md` is read and only **adopt** is offered.

**`cogyard tasks doctor`** runs the same check over every registered project,
so projects onboarded before it existed are covered, and adds two more:

- a project skill or command with a cogyard skill's or command's name — it
  runs beside cogyard's, never runs (an older install's bare-name link hides
  it), or (when that link is turned off) neither runs — with the fix: rename
  it, turn cogyard's off and add the replaces line, or delete it (and, for a
  bare-name link, re-run `cogyard claude install`);
- a project skill whose `Last reconciled against it` date is older than the
  last change to the cogyard skill it replaces — compare the two, then move
  the date.

The check lives in [`core/process-docs.mjs`](../core/process-docs.mjs); every
agent-specific name (instruction files, the skill folder, turning a skill off)
comes from the driver's `skills` seam ([`docs/DRIVERS.md`](DRIVERS.md), seam 7).

`cogyard init` and `cogyard onboard` are the only ways to set a project up.
(An older `cogyard tasks init`, which made only the store and the registry
entry, was removed: `onboard` on a repo that is already set up changes
nothing, so it covers that case too.)

## The shared seam

The conversion logic lives in `core/scaffold.mjs` (`convertToSharedStore`), so
`init`/`onboard`, the portal route, and `cogyard tasks convert` all share one
implementation. The portal endpoints (`server/routes/projects.mjs`) are the second
writes on the read-mostly `/api` surface — they go through the documented
`requireSameOrigin` + `readBody` seam in `server/http.mjs` and nowhere else.

## Verify it worked

```sh
cogyard tasks doctor          # the slug's LINK column says ok, FLAGS says ok
cogyard tasks projects list   # the slug appears without ⚠
# → project visible at http://cogyard/ ; a worktree in it gets a port pair
```

## Kinds

Kinds are a **drop-in registry**: the built-ins (`single` / `fullstack`
/ `static` / `library`) ship in `core/scaffolds/`, and a community kind drops into
`~/.cogyard/scaffolds/<kind>/scaffold.mjs` — additions only, nothing hardcodes the
list. The `--kind` pickers (CLI + the New/Add drawer) read the registry rows from
`/api/config`, so a new scaffold appears with no UI change. `fullstack` seeds only
the cogyard wiring — you supply the application scaffold (e.g. an Angular +
Node/Express + SQL monorepo shape). Contract: `docs/ADDONS.md`; the descriptor
fields are documented at the top of `core/scaffolds/index.mjs`.

The four built-ins all assume an npm web app. Three descriptor fields let a kind
describe anything else, each defaulting to what the built-ins do:

| field | default | what it says |
|---|---|---|
| `worktreePorts` | `true` | reserve worktree ports and write `.cogyard/worktree.json` |
| `devScript` | `'npm run dev'` | the dev command that config names; `null` = no dev server |
| `versionStamp` | `true` | `true` = the npm stamper (`scripts/generate-version.mjs` → `version.json`); `false` = none; a function `(slug) => ({ relPath: content })` = the kind's own stamping files, seeded instead |
| `markers` | none | file names or `*.ext` patterns that mark a project as this kind's, so onboard can name it |

`worktreePorts` and `devScript` are independent: an iOS app beside a Node server
wants both; an Xcode-only app may want neither. **Kinds for Apple platforms and
for firmware are not built in yet** — until one is installed, an onboarded Xcode
or PlatformIO project gets a warning and the npm defaults, and its version stamp
(the project's version and commit, visible in the running app) has to be wired
by hand in its build — an Xcode build phase, a generated firmware header.
