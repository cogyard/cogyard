# Configuration

Everything cogyard assumes about your machine, and every knob you can turn. The
design goal: **sensible defaults for a common setup, an override for every
assumption, and nothing personal hardcoded.**

## How settings are resolved (first match wins)

1. **Environment variable** — per-invocation override.
2. **`~/.cogyard/config.json`** — persistent machine config (see schema below).
3. **Per-project committed file** — `.cogyard/worktree.json` (opt-in worktree
   wiring).
4. **Built-in default.**

## Environment variables

| Variable | Default | What it controls |
|---|---|---|
| `COGYARD_HOME` | `~/.cogyard` | Where all per-machine config + state lives (registry, ports, tunnels, usage, logs). Move it and everything follows. |
| `COGYARD_PROJECTS_ROOT` | `~/gitroot` | The conventional parent of your project clones, and the root of the shared task-store (`<root>/_tasks/<slug>`). Falls back to `config.json.projectsRoot` (settable in `/settings`), then `~/gitroot`. **Only a default + a label-shortener — never required.** A repo anywhere still works. |
| `COGYARD_DRIVER` | auto-detect → no-op | Which agent adapter is active (e.g. `claude`). Falls back to `~/.cogyard/config.json`, then auto-detection, then a built-in no-op (runs fine with no agent). See [DRIVERS.md](DRIVERS.md). |
| `COGYARD_LAUNCHD_PREFIX` | `com.cogyard` | Reverse-DNS prefix for the macOS LaunchAgents that `tunnel` creates (e.g. `com.cogyard.cloudflared.<name>`). Set it to your own domain if you prefer. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where `cogyard claude install` writes the driver's skills/commands. (Honored by Claude Code itself, too.) |
| `PORT` | `7440` | Port the portal server binds. `cogyard serve --port N` sets this for you. |
| `EDITOR` | `vi` | Editor opened by `cogyard tasks analyze --backfill`. |
| `COGYARD_PRICING_URL` | LiteLLM's `model_prices_and_context_window.json` | Where the Claude driver pulls live model rates from. Point it elsewhere to pin, mirror, or test against a fixture. |
| `COGYARD_PRICING_TIMEOUT_MS` | `20000` | Timeout for that fetch. |
| `COGYARD_PRICING_SYNC_MS` | `86400000` (24h) | How often the portal server re-pulls rates. It also pulls once on boot. |

Set by the host agent (you don't set these): `CLAUDE_PROJECT_DIR`, `CLAUDECODE`
(read by the worktree hooks and driver auto-detection), and `COGYARD_DEV_GUARD`
(internal orphan-guard set by `scripts/dev.sh`).

## `~/.cogyard/` — state files

All under `COGYARD_HOME`. Created on demand; safe to inspect, back up, or delete
(cogyard rebuilds what it can).

| Path | Contents |
|---|---|
| `projects.json` | The project registry (`cogyard tasks projects list`). |
| `ports.json` | Worktree port allocations **and** the allocatable ranges (see Ports). |
| `tunnels.json` | Tunnel-enabled projects + their hostnames. |
| `config.json` | Persistent machine config (schema below). Optional. |
| `secrets.env` | Credentials, mode **0600** (see Secrets). Optional. |
| `usage/` | The token/cost usage ledger. |
| `run/<job-id>/` | One empty folder per scheduled job, created on its first run. The job's agent calls run there so the usage ledger files them under the job. Safe to delete; it is recreated. |
| `pricing.json` | Model rates synced from upstream (`cogyard usage pricing`), keyed by driver, newest version first. Delete it and pricing falls back to the active driver's built-in seed table until the next sync. |
| `logs/` | LaunchAgent + worktree-hook logs. |
| `scaffolds/<kind>/scaffold.mjs` | Community project kinds, added to the four built-ins at the next process start (a kind can't replace a built-in). How a kind declares its dev command, version stamping and the files that mark its projects: `docs/PROJECT-INIT.md`, Kinds. |

### `config.json` schema

Optional. Recognized keys:

```jsonc
{
  "driver": "claude",        // active agent adapter
  "projectsRoot": "/abs/path",    // overrides the ~/gitroot default
  "defaults": {                   // New / Add-existing drawer prefill
    "kind": "single"              // single | fullstack | static | library, or an installed kind
  },
  "addons": {                     // per-add-on settings, edited in /settings
    "doc-drift": { "minAgeDays": "30" }
  },
  "ui": {                         // portal UI preferences
    "weekStart": "sunday",        // activity heatmap first row: sunday | monday
    "dayStart": 0,                // first hour (0-23) on the punch-card axis
    "hiddenTabs": [],             // project-tab-strip tabs to hide, e.g. ["plan", "branches"]
    "defaultTab": "tasks",        // the tab a project opens on; must be a visible tab
    "projectIcons": {             // sidebar icon per project: slug → path INSIDE that repo
      "cogyard": "frontend/public/favicon.svg"
    },
    "projectIconBorders": []      // slugs whose icon gets a white border on the dark rail
  }
}
```

- `driver` — the active agent adapter, same values as `COGYARD_DRIVER`
  (the env var wins if both are set). Omit the file entirely to auto-detect.
- `projectsRoot` — overrides the `~/gitroot` default for `PROJECTS_ROOT` (below).
  `COGYARD_PROJECTS_ROOT` wins if both are set.
- `defaults` — the project-creation defaults the portal's New / Add-existing drawer
  prefills with (and the `/settings` view edits). An invalid `kind` is ignored,
  falling back to the built-in (`single`). Every built-in kind assumes an npm
  web app, including how it stamps the version and commit into the running app
  (`scripts/generate-version.mjs` → `version.json`). For an Xcode or firmware
  project no built-in meets that yet: an installed kind supplies its own
  stamping, or the project wires it into its own build (`docs/PROJECT-INIT.md`, Kinds). The task store is always shared (the
  `normal` choice was removed), so there's no settable `store` default. There is no
  default git `remote` — it's inherently per-project, so the drawer's remote field
  is always entered fresh.
- `addons` — each installed add-on's saved settings, keyed by add-on id, written
  by the Configure dialog on `/settings`. Only keys the add-on declares in its
  `configSchema` are accepted, and these are what a scheduled job receives when
  it runs at 05:00 — not just when someone presses a button. **Never a
  credential:** those live in `secrets.env` (see Secrets below).
- `ui` — portal UI preferences, edited in `/settings`. `weekStart`/`dayStart` drive
  the activity views. `hiddenTabs` hides tabs from every
  project's tab strip — any of `daily`, `tasks`, `plan`, `branches`, `worktrees`,
  `graph`, `files` (unknown ids are ignored; an old `board` reads as `plan`).
  Hiding only trims
  the strip: deep links to a hidden tab still render it, the global `/settings`
  view (sidebar cog) is always reachable, and a project's **Admin** tab (pinned
  to the right of its strip) is not a hideable id at all — so you can't lock
  yourself out of any settings surface. Admin has inner tabs of its own — **Info**
  (where the project is on disk, how it publishes), **Settings** (its switches,
  icon and label axes), **Stats** and **Cleanup** — at `/p/<slug>/admin/<inner
  tab>`. Stats and Cleanup used to be top-level tabs, so an older
  config's `stats` / `cleanup` (or `activity`) in `hiddenTabs` is dropped, and a
  `defaultTab` of either reads as unknown. `defaultTab` ("Open projects on" in
  the Portal tabs card) is the tab switching to a project opens — also
  the root URL and a project link with no tab. Default `tasks`; an unknown value
  reads as `tasks`, and a hidden one as the first visible tab in strip order, so
  you never land on a hidden tab. A task link always opens `tasks`.
  `projectIcons` maps a project slug to the icon shown beside it in the sidebar —
  a path to an image **inside that project's own repo**, relative to the repo root
  (`.svg .png .ico .jpg .jpeg .gif .webp .avif`). Absolute paths, `..` segments,
  and non-image extensions are rejected on write and dropped on read; the file is
  served by `GET /api/project-icon?slug=…` behind realpath containment, so a path
  that later becomes a symlink out of the repo stops being served. A project with
  no entry shows no icon — its name still lines up, because the rail renders the
  icon slot either way. You set it from the Icon card on that project's
  Admin → Settings tab (Admin is pinned right of its tab strip): **Browse** lists every
  image in the repo, each shown rendered, or you type a path. Nothing auto-detects
  it. (Detection was built and removed: any heuristic for "which file in this repo
  is THE icon" is wrong often enough to be worse than an empty field. A picker is
  not detection — it lists, and you choose; nothing ranks or pre-fills.)
  The card validates as you type — it says whether the file exists, and why a path
  was rejected, **before** you save — and previews the artwork on both backgrounds
  it has to survive (below).

  **An icon must read on TWO backgrounds.** The rail is indigo (`#3f3d9e`), but the
  SELECTED row puts a white plate behind the icon, so the same artwork is seen on
  indigo and on white. A single-ink glyph on a transparent background therefore
  fails one of the two — black art vanishes on the rail, white art vanishes on the
  plate. Artwork that survives both carries its own background, or is two-tone or
  outlined. The Icon card previews both states side by side, and its **Copy
  instructions** button puts this whole spec (colour, pixel size, formats, path
  rules, all read from the live CSS and API rather than restated) on the clipboard
  as a brief to hand an agent working inside that project.

  The rail's icon URL carries a `v` from the derived `projectIconVersions` map on
  `GET /api/config` — the version changes when the stored path changes *or* the
  file's mtime/size does, so a re-pointed or re-drawn icon appears at once instead
  of being replayed from the browser cache for the response's `max-age`.
  `GET /api/project-images?slug=…` backs the picker (repo images, gitignore
  honoured); `GET /api/project-icon?slug=…&path=…` previews an unsaved path, under
  the same containment and extension rules as a stored one.

  `projectIconBorders` lists the slugs whose icon gets a white border behind it on
  the dark rail — a checkbox in the same card. Most project icons are
  favicons drawn for white browser chrome; the dark-inked ones sink into the
  indigo rail and the light/colored ones don't, so it's a per-project call the
  owner makes, never inferred from the artwork. **The selected row always gets a
  border regardless of the checkbox** — on the accent fill every icon needs the
  separation.

All of this is editable in the portal under **Settings** (the same form is the
first-run setup wizard shown when no projects are registered yet). `COGYARD_HOME`
and `driver` are shown read-only there — `COGYARD_HOME` is where `config.json`
itself lives (env/CLI-only), and the driver selector arrives with a second
adapter.

**`PROJECTS_ROOT` resolution**: `COGYARD_PROJECTS_ROOT` env →
`config.json.projectsRoot` → `~/gitroot`, mirroring how `driver` resolves. It's
read at process start, so a `projectsRoot` change made in `/settings` (or by editing
the file) takes effect on the next server start — for the always-on portal, the
LaunchAgent reload in the deploy step.

## Secrets — `~/.cogyard/secrets.env`

The one place a credential lives on this machine. Scheduled jobs shell out to
tools that authenticate from their **process environment** — an agent CLI, say —
and a child process inherits the portal's environment, so this file is how a
token reaches them.

**Where to find out which credential you need.** Install the **Scheduled tasks
with LLM analysis** add-on (`extras/addons/scheduled-tasks/`), the one switch that lets cogyard run
jobs overnight. Its row in **Settings → Add-ons** says whether the agent's token
resolves, and its Configure dialog walks through setting one up. The variable's
name comes from the active driver
([DRIVERS.md](DRIVERS.md)); every job that calls an agent uses that same one
variable, so setting it once serves all of them.

cogyard core asks for no credential at all — nothing in core calls an agent, so
an install with no add-ons has no credential requirement.

**Onboarding is two lines.** Put the credential in the file, and lock the file:

```
echo 'SOME_TOKEN=<paste the value>' >> ~/.cogyard/secrets.env
chmod 600 ~/.cogyard/secrets.env
```

That is the whole setup. There is nothing to edit in a LaunchAgent plist, nothing
platform-specific, and nothing to re-do after reinstalling anything.

**Format.** `KEY=value` per line. `#` starts a comment line, blank lines are
ignored, an `export ` prefix is accepted (so a line copied out of a shell profile
works), and values may be single- or double-quoted — quote anything containing
spaces. An **unquoted value runs to the end of the line**, including any `#`:
truncating an opaque credential at a character it happens to contain would
produce an auth failure nobody could explain, so comments go on their own line.

**The rules, and why each one is there:**

- **Loaded once, at server start**, into `process.env`. Dev (`npm run api`) and
  the always-on portal (`bin/serve`) run the same file, so they behave
  identically. Adding a credential takes effect on the next server start — for
  the portal, the LaunchAgent reload in the deploy step.
- **An existing value wins.** A name already set in the environment (a shell
  export) is left alone, so `SOME_TOKEN=x npm run api` still overrides the file
  for one-off testing.
- **Mode 0600 or it is refused.** A file any user on the machine can read is the
  problem this replaces; loading it anyway would launder that into something
  that looks solved. The refusal is logged with its exact `chmod`, and the
  portal still boots — refusing to start over a file permission would be the
  worse failure.
- **A value never leaves the machine.** Nothing reports one: not an `/api`
  response, not a log line, not a job summary, not a task file. Every surface is
  limited to whether a name resolves. An add-on is handed the variable's NAME
  and a boolean — never the credential — and the tool it spawns picks the value
  up from the environment. The agent's credential is declared by the active
  driver ([DRIVERS.md](DRIVERS.md)) and set up from the **Scheduled tasks with
  LLM analysis** add-on's Configure dialog.
- **cogyard never obtains, refreshes, or rotates anything.** Getting the
  credential is your step, done however the tool issues one; cogyard reads what
  is there and tells you when it is missing.

**Not the Keychain, deliberately.** A Keychain read from a LaunchAgent context
prompts or fails depending on how the item was stored, which is precisely the
unattended 05:00 path that must not break. `core/secrets.mjs` is written as a
resolver with one source so a vault backend can be added later without touching
any caller — but a machine-local file with owner-only permissions is the v1
threat model, and encrypting it without a key store would be theatre.

## Per-project / per-worktree files

| File | Tracked? | Written by | Purpose |
|---|---|---|---|
| `.cogyard/worktree.json` | committed | `init` / `onboard`, then you | **Opt-in.** Presence makes the SessionStart hook wire env files / `launch.json` so dev servers bind the worktree's reserved ports. The old `.claude/worktree-config.json` is no longer read. |
| the `env_files` targets (e.g. `.env.development`) | gitignored links | SessionStart hook | A link in each worktree to the project root's file of the same name — never a copy, so an edit through one edits that file. No env file carries a port: a dev script asks `cogyard env ports`, which reads `~/.cogyard/ports.json`. |
| `.claude/launch.json` (in a worktree) | gitignored | SessionStart hook | The worktree's preview entry. Rewritten every session start; a hand edit is refused by the Edit/Write hook. The main checkout's file also lists every worktree's entry, beside the project's own. |
| `.tunnel` | committed marker | `cogyard tunnel` | Marks the project tunnel-enabled. |
| `.cogyard/tasks` | gitignored symlink (by a committed `.cogyard/.gitignore`) | `init` / `onboard` / `convert` / `join`; `cogyard tasks mount` in a worktree | The link to the task store — the shared store at `<PROJECTS_ROOT>/_tasks/<slug>`. The old top-level `_tasks` link is no longer read. Shared is the only model; an in-repo `_tasks/` folder an existing repo already has is adopted into a new store by `convert` / `onboard`. |
| `<task store>/switches.json` | committed in the task store | the project's settings page (Switches card), or by hand | The project's **switches** — see below. Absent = every default. |

### Project switches — `<task store>/switches.json`

The few places a project works differently from cogyard's defaults. The file
sits in the project's task store next to `axes.json`, so every worktree sees a
change at once and a team store shares it.

```json
{
  "rebase": "always",
  "version": "minor"
}
```

| Switch | Values | Default | Read by |
|---|---|---|---|
| `rebase` | `always` — rebase onto main without asking (a conflict still stops); `ask` — ask first | `always` | `merge-to-main` step 1 (the branch is behind main before merging); `pickup-task` when resuming a task whose branch is behind main |
| `version` | `off` — no bump; `minor` / `patch` — `npm version <value> --no-git-tag-version` on the root `package.json`; `{ "command": "…", "file": "…" }` — the project's own command, run from the repo root, and the file that holds the version | `minor` when the repo root has a `package.json`, else `off` | `merge-to-main` step 7. If the merge itself already changed the version in that file, no bump. |

- **Reading:** `cogyard tasks switches` prints each switch's value and whether it
  is set or the default; `--json` prints `{ rebase: { value, set }, version: {
  value, set, file } }`. The skills call this and never read the file, so the
  defaults live in one place (`core/switches.mjs`).
- **Invalid entries** (an unknown key, a bad value, a file that isn't a JSON
  object) are ignored on read and the default applies; `cogyard tasks switches`
  and the settings card list what was ignored. Saving from the card refuses an
  invalid value and rewrites the file with only valid entries.
- **Committing:** saving writes the file but does not commit it. Commit it from
  the project with `cogyard tasks sync push "<msg>" -- switches.json`.
- Portal API: `GET /api/switches?p=<slug>`, `POST /api/switches { slug, switches }`
  (a key left out or `null` goes back to its default).

## Ports

| Role | Default | Configure |
|---|---|---|
| Portal server (prod, behind a reverse proxy) | `7437` | `PORT` env / `cogyard serve --port` |
| Portal server (dev) | `7440` | `PORT` env / `--port` |
| Angular dev server (`npm start` in `frontend/`) | `4200` | Angular CLI |
| Per-worktree backend | first free in **30000–30999** | edit `ranges` in `~/.cogyard/ports.json` |
| Per-worktree frontend | first free in **31000–31999** | edit `ranges` in `~/.cogyard/ports.json` |

To change the worktree ranges, edit the `ranges` object in `~/.cogyard/ports.json`:

```json
{ "ranges": { "backend": [30000, 30999], "frontend": [31000, 31999] }, "allocations": {} }
```

## Tools & platform

> Run **`cogyard doctor`** to check this whole list at once — it reports ok/warn/fail
> for the Node version, `git`, a writable `~/.cogyard/`, the registry, and more, with
> a fix line per problem (it diagnoses only; it never changes anything).

**Required**

- **Node 22 LTS or newer** (Node 20 reached end-of-life on 2026-04-30; the engine
  uses global `fetch` and the built-in `node --test` runner, and the optional
  desktop build needs ≥ 22.12). Enforced via `engines` in `package.json`.
- **git** — used by nearly every command (init, the portal's git views, task sync,
  env detection). `cogyard` fails with a clear message if it's missing.
- **npm** — `npm i -g cogyard` (or, from a clone, install + `npm link`).

**Platform:** macOS and Linux. **Windows is supported via WSL** — the worktree
hooks are bash scripts and port-ownership checks use `lsof`, neither of which runs
on native Windows.

**Optional / feature-specific**

- **`lsof`** — `cogyard env port-owner` and dev-server ownership checks (Unix).
- **`cloudflared`** — the `tunnel` feature.
- **`launchctl`** + **`~/Library/LaunchAgents`** — macOS background services
  (the always-on portal recipe and tunnels).
- **`nvm`**, **`/opt/homebrew`** — referenced only by the example macOS LaunchAgent
  in `bin/` (an optional deployment recipe — see [DEPLOY.md](DEPLOY.md)).
- **`caddy`** — the documented reverse-proxy example for a clean hostname.
- **`python3`** — only the `static` project skeleton's default dev server.
