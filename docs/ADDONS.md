# Add-ons — extending what cogyard does

cogyard core is **agnostic and add-on-free**: nothing platform-, service-, or
owner-specific ships in the published tree. Capabilities beyond the core —
exposing a dev server at a public hostname, fronting the portal with a local
reverse proxy, anything the community dreams up — are **add-ons**: trusted code
you install outside the repo, discovered at runtime, and rendered as cards on
the global **/settings** page.

**An add-on extends COGYARD ITSELF — it is machine-level, never per-project.**
If an add-on operates on a project (tunnel points at one project's dev server),
that targeting is the add-on's own config (`type: 'project'` field, below) —
the framework has no per-project structure at all.

**The surface is a compact list, not a wall of forms.** /settings shows one ROW
per installed add-on (icon, name, activation switch, status pill, one-line
summary); the add-on's whole interaction surface — prereqs, config form, action
buttons, results — opens in a DIALOG from the row's Configure button. Both the
row and the dialog are generated from the manifest: an add-on ships zero UI code,
and the page doesn't grow as add-ons accumulate.

**Install ≠ activate.** The row's switch is a framework-level toggle (persisted
as `disabledAddons: [id, …]` in `~/.cogyard/config.json`, saved through
`POST /api/config`): a switched-off add-on stays listed but is INERT — the
loader never calls its functions and its actions refuse to run.

Core ships exactly three things for this: the **contract** (below), the
**loader/registry** (`core/addons/index.mjs`, plus `schedule.mjs` + `jobs.mjs`
for scheduled jobs), and the **Settings surface**
(`frontend/src/app/settings/addons/`). Everything else lives in your add-on.

## Three extension concepts — don't confuse them

| Concept | Axis | Lives at | Discovered by |
|---|---|---|---|
| **Add-on** (this doc) | what cogyard *does* — runtime capabilities with status/config/actions | `~/.cogyard/addons/<id>/` (outside the repo) | `core/addons/index.mjs` |
| **Driver** | which *agent* drives cogyard (Claude Code, …) | `drivers/<name>/` (in-repo) | `core/drivers.mjs` — see `docs/DRIVERS.md` |
| **Scaffold** | what a project *kind* templates at `init` (skeleton + package.json + wiring defaults + description) | built-ins in `core/scaffolds/`; additions at `~/.cogyard/scaffolds/<kind>/scaffold.mjs` | `core/scaffolds/index.mjs` |
| **`.claude-plugin/`** | Claude Code packaging of this repo (marketplace/plugin metadata) | repo root | Claude Code itself |

A scaffold has no status/actions/prereqs and renders no Settings card — it's
resolved once at project creation. Its descriptor contract is documented in
`core/scaffolds/index.mjs`; a drop-in kind appears in the New/Add drawer and
`/settings` kind picker (with its description) after a server restart, and it
cannot shadow a built-in kind.

Both add-ons and drivers extend `~/.cogyard/`, in distinct namespaces:
drivers use the `driver` key in `config.json`; add-ons own the
`addons/` directory. Keep them separate.

There is also a fourth, non-mechanism resident of "outside core": **extras** —
self-contained workspaces/build targets the portal does NOT manage at runtime
(no manifest, no Settings card), e.g. the desktop shell. An extra is just a
directory/repo you build yourself; do not force one through the add-on loader.

## Install / distribution (the Phase-0 decision)

**Drop-in directory.** An add-on is installed by placing a folder — copy, clone,
or symlink — at:

```
~/.cogyard/addons/<id>/addon.mjs        # (or $COGYARD_HOME/addons/<id>/)
```

then restarting the server (manifests are resolved once per process; for the
production portal that's the LaunchAgent reload). No npm, no registry, no
auto-update — you chose the code, you own it. npm- or git-based distribution
can layer on later as sugar over the same directory.

Add-ons are **trusted code**: the loader `import()`s your module into the server
process. There is no sandbox. Install only what you'd run by hand.

## The contract — `addon.mjs`

Your module exports a `manifest` object (named export; default export also
accepted). `id` MUST equal the folder name.

```js
// ~/.cogyard/addons/tunnel/addon.mjs
export const manifest = {
  id: 'tunnel',
  label: 'Cloudflare Tunnel',
  description: "Expose this project's current worktree dev server at a stable public hostname.",
  icon: '🌐',                       // emoji / short glyph shown on the card
  thirdParty: true,                 // external service involved → bias actions to 'manual'
  platforms: ['darwin'],            // omit (or []) = everywhere; else hidden/disabled elsewhere

  // MACHINE checks, displayed with fixHints, NEVER auto-installed. Both
  // arguments are optional — see "Reporting a missing credential" below.
  prereqs(cfg, { agentCredential, whereToSet }) {
    return [{ id: 'cloudflared', label: 'cloudflared installed', ok: false, fixHint: 'brew install cloudflared' }];
  },

  // Renders the card's config form. Types: 'string' | 'enum' | 'boolean' | 'project'.
  // A 'project' field renders a dropdown of registered projects; the chosen SLUG
  // arrives in cfg like any other value — the only project awareness anywhere.
  configSchema: [
    { key: 'project', label: 'Project', type: 'project', required: true },
    { key: 'hostname', label: 'Public hostname', type: 'string', required: true, placeholder: 'dev.example.com' },
    { key: 'side', label: 'Port', type: 'enum', options: ['frontend', 'backend'], default: 'frontend' },
  ],

  // Live, derived MACHINE-LEVEL roll-up — inspect whatever your add-on itself
  // owns (files, processes, APIs; e.g. tunnel reads its own tunnels.json and
  // reports every tunnel-enabled project in details). The registry stores NOTHING.
  status() {
    return { enabled: false, summary: 'no tunnels enabled', healthy: null, details: {} };
  },

  // tier 'safe'  → the portal EXECUTES it server-side via run().
  // tier 'manual' → the portal NEVER executes it; it shows command()'s output.
  actions: [
    { id: 'enable',  label: 'Enable',  tier: 'manual', needsConfig: true },
    { id: 'here',    label: 'Repoint to current worktree', tier: 'safe' },
    { id: 'disable', label: 'Stop',    tier: 'safe' },
    { id: 'delete',  label: 'Delete (tunnel + DNS)', tier: 'manual', destructive: true },
  ],

  // SAFE actions only. May be async. Return { ok, message? }.
  run(actionId, cfg) {
    return { ok: true, message: `repointed ${cfg.project}` };
  },

  // MANUAL actions only. MUST be side-effect-free: render the exact copy-paste
  // command for the user to run themselves. Return { command, note? }.
  command(actionId, cfg) {
    return { command: `cogyard tunnel enable ${cfg.project} ${cfg.hostname}`, note: 'runs cloudflared login first if needed' };
  },
};
```

### Tiered execution — enforced by core, not by convention

The registry routes by the action's `tier`:

- **safe** → `run(actionId, cfg)` executes in the server process.
  Reserve this for local, reversible operations.
- **manual** → `run()` is **never called**. The registry calls your
  side-effect-free `command()` and the card shows the command with a Copy
  button and a Recheck. Anything third-party, destructive, or auth-requiring
  (logins, DNS, deletes) belongs here — the portal will not do it for you.

### Setup walkthroughs — `setup()`

Some add-ons need a one-time setup the owner performs OUTSIDE cogyard: obtaining
a credential, installing a binary. A `fixHint` string cannot carry that — it
needs paragraphs, ordered steps, and a copyable command per step. Declare
`setup()` and the dialog renders one:

```js
setup(cfg, ctx) {
  if (nothingLeftToDo) return null;   // the guide disappears when setup is done
  return {
    intro: ['What this is for, in plain words.', 'What cogyard does and does not do with it.'],
    steps: [
      { what: 'Get a token.', why: 'Run this in a terminal; it prints a value.', command: 'your-agent login' },
      { what: 'Save it.',     why: 'Replace <paste the value> and run it.',      command: ctx.addSecretCommand('YOUR_TOKEN') },
      { what: 'Restart cogyard.', why: 'It is read once, at startup.',           command: 'launchctl …' },
      { what: 'Check it worked.', why: 'Press Recheck — this row should go green.' },
    ],
    warning: 'Something wrong right now, if anything is.',
    warningCommand: 'the command that fixes it',
  };
}
```

Your add-on ships no UI: it supplies the words, the dialog owns the look. Take
every machine-specific string from `ctx` (`addSecretCommand`, `secretsPath`,
`agentCredential.env`) rather than hardcoding a path or an agent's variable name.

**Worked example:** `extras/addons/scheduled-tasks/` runs nothing itself — it is
the one switch for "cogyard may run jobs overnight", one row saying whether the
agent's token resolves, and the walkthrough for setting one. The credential sits
there rather than in a job's dialog because it belongs to no single job: every
job that calls an agent uses the same variable, and none of them can run without
it.

### Config — where the owner's settings live

The values behind `configSchema` are saved in `~/.cogyard/config.json` under
`addons.<your-id>`, written by the Configure dialog and validated against your
schema (an undeclared key is refused, an enum outside its options is refused, an
empty value clears the key). They arrive as the `cfg` argument to `run()`,
`command()`, `prereqs()`, and — the one that matters — `runScheduled()`.

**Your defaults still apply.** A field's `default` fills in whatever the owner
never set, so an add-on works before anyone configures it. What is stored is only
the difference.

That your nightly job receives the owner's settings is worth stating plainly,
because it did not always: in earlier versions the config existed only in the browser
and the scheduler passed none, so an unattended run saw `{}` no matter what the
Settings dialog showed. If you are reading an add-on written against the older
behaviour, that is why it re-derives everything from its own defaults.

### Credentials

Two different credentials get confused here, so be clear which one you have.

**The AGENT's credential is not yours.** If your job calls `ctx.agent`, the thing
that authenticates is the agent binary, which the *driver* spawns. Every
scheduled job needs the same one variable, and its name is an agent-specific
literal. So it is declared once in `drivers/<name>/adapter.mjs`
([DRIVERS.md](DRIVERS.md)) and surfaced by the **Scheduled tasks with LLM analysis**
add-on (`extras/addons/scheduled-tasks/`). **Do not
declare it in your manifest.** Doing so duplicates it across add-ons and hardcodes
an agent literal in community code — the exact thing the driver seam exists to
prevent. Your job only *reports* it, via `prereqs()` (below).

**Your OWN third-party credential** — a Slack token, a Linear key, something only
your add-on talks to — is a different case, covered below.

### An add-on's own third-party credential

Not supported today, deliberately. A `secret` field type existed briefly and was
removed with nothing using it — the case that motivated it (the agent's token)
turned out to belong to the driver, and core does not carry contract surface on
speculation. If your add-on genuinely needs its own credential, say so and it
gets added for that add-on rather than in advance of one.

What it must never be is a `string` field you paste a token into:
`~/.cogyard/config.json` is world-readable and the portal rewrites it whenever a
setting is saved.

### Reporting a missing credential — say WHERE to fix it

A credential is **set in one place and used in another**. "Missing" on its own
is a dead end: the reader is looking at the job that failed, not at the file that
would make it work. So core hands `prereqs()` everything needed to point:

```js
prereqs(cfg, { agentCredential, whereToSet }) {
  const rows = [];

  // The AGENT's credential — the driver's, reported without naming any literal.
  if (agentCredential) rows.push({
    id: 'credential',
    label: `${agentCredential.label} — the agent this job calls`,
    ok: agentCredential.set,
    fixHint: agentCredential.set ? undefined
      : whereToSet(agentCredential.env)
        + (agentCredential.howTo ? ` Get the value with: ${agentCredential.howTo}` : ''),
  });

  return rows;
}
```

| Argument | What it is |
|---|---|
| `cfg` | your resolved config |
| `agentCredential` | the active driver's `{ env, label, howTo, set }`, or `null` if it needs none |
| `whereToSet(name)` | core's one sentence naming the file, the mode, and the restart. Render it rather than wording your own, so the instruction can't drift between surfaces or go stale when the path changes |

A scheduled job that declares `needsAgent: true` gets this for free on its
**Scheduled jobs** row too: when the agent credential is missing, the row says so
and points at where to set it, because that row is where someone looks in the
morning. Without that flag the row says nothing — core has no way to know your
job calls an agent, and a false alarm on that row is worse than silence.

## Scheduled jobs — the third tier

Both tiers above are **user-triggered**: someone opened a dialog and pressed a
button. A scheduled job is a third thing — it runs **unattended, on a timer,
with nobody watching** — so it has its own entry point and its own rules.

Declare `schedule` and your add-on becomes a job. Nothing else about the add-on
changes, and an add-on with no `schedule` is completely unaffected.

```js
export const manifest = {
  id: 'project-brief',
  label: 'Nightly project brief',
  // …the ordinary manifest fields…

  schedule: {
    every: 'day',       // 'day' | 'week'
    at: '05:00',        // local wall-clock, 24h. "05:00" stays 05:00 across a DST change.
    weekday: 1,         // 'week' only. 0 = Sunday, default 1 (Monday).
    catchUp: true,      // default. Machine asleep at 05:00 → run on next wake.
  },

  // Does this job call the agent? Declare it and your Settings row warns when
  // the driver's credential is missing, before the slot arrives. Core cannot
  // infer this, and a job that only reads git and files needs no credential —
  // so omitting it means your row is never told it needs one.
  needsAgent: true,

  // What core enforces vs what you enforce. `timeoutMs` is enforced BY CORE:
  // the run is aborted through ctx.signal. The other two are handed to you in
  // ctx.bounds to honour yourself, because only your job knows what a "unit" of
  // its work is — core cannot count something it has no concept of.
  bounds: { timeoutMs: 900000, maxUnits: 25, maxCostUsd: 2 },

  // Called by the core scheduler ONLY — never from a dialog. Unattended means
  // no prompts, no stdin, nothing that waits for a human.
  // MUST be idempotent: a catch-up run after a missed night must not double-write.
  async runScheduled(cfg, ctx) {
    if (!ctx.agent?.supported) return { ok: false, error: 'no agent driver active' };
    ctx.log('starting');                       // one line in this job's run log
    return { ok: true, summary: '4 written, 7 unchanged', cost: 0.42 };
  },
};
```

**What `ctx` carries** — everything core owns, so you never reimplement it:

| Field | What it is |
|---|---|
| `ctx.projects` | the registry rows, same shape as `discoverProjects()`, plus `formerSlugs` (see "When a project's slug changes" below) |
| `ctx.agent` | the driver's headless agent seam (`docs/DRIVERS.md`), or an unsupported stub |
| `ctx.bounds` | your normalized `bounds`, defaults filled in |
| `ctx.signal` | `AbortSignal` — fires on timeout. Honour it or you cannot be stopped |
| `ctx.lastRunAt` | ISO string, or null on the first run |
| `ctx.trigger` | `'schedule'` or `'manual'` (someone pressed Run now) |
| `ctx.log(line)` | appends to this run's log, visible in Settings |

**Return** `{ ok, summary, cost?, skipped?, error? }`. `summary` is what the
Settings row shows in the morning, so write it for a human. `cost` accumulates
into a rolling total. `skipped: true` records a deliberate no-op — a job with
nothing to do should skip and spend nothing, not manufacture work.

### What core guarantees

- **Single-flight.** Never two runs of one job at once. A nightly job that
  overruns its own next slot does not get a second copy piled on top.
- **Timeout.** `bounds.timeoutMs` aborts through `ctx.signal`, and the run is
  recorded as a timeout even if your job swallows the abort.
- **Never crashes the portal.** A `runScheduled()` that throws is caught and
  reported on the row. So is a job that declares a schedule but forgets
  `runScheduled()`, and one whose `schedule` core cannot parse — a garbled
  schedule makes the add-on *not scheduled*, never scheduled at some other time
  than you wrote.
- **Switched off means off.** The Settings activation switch applies here as
  everywhere: an inactive add-on never fires.
- **A fresh install does not fire immediately.** Core records when it first saw
  a job and treats that as the floor, so installing at 06:00 with `at: '05:00'`
  waits for tomorrow rather than counting every slot since the epoch as missed.
- **A missed night is a missed night.** With `catchUp: false`, a slot older than
  an hour is skipped rather than queued — waking a laptop never floods.

State (last run, next run, outcome, rolling cost, run log) lives in
`$COGYARD_HOME/jobs.json`, written atomically. Core owns it; your job stores
nothing.

**Where a job's agent usage is filed.** The `ctx.agent` your job receives runs
every call in that job's own empty folder, `$COGYARD_HOME/run/<job-id>`, and the
usage ledger files any transcript recorded there under the job, never under a
project. On the portal's All page those calls appear under **Scheduled tasks**,
one row per job, counted in the grand total; in "Where your time went" they are
one cost-only lane, because a job's prompts are the machine's and not your
attention. That figure and the Settings row's `COST` are two different numbers
from two different sources: `COST` adds up what your `runScheduled()` *returned*,
while the ledger reads the agent's own transcripts token by token. Both are
API-equivalent figures, not a bill.

Prereqs follow the same philosophy: **detect + instruct, never auto-install**
(`ok: false` + a `fixHint` string the card displays).

### Scheduled jobs shipped in `extras/addons/`, as worked examples

None is core; each is installed by symlinking into `~/.cogyard/addons/`, and
each is switchable on its own. Read them before writing another.

```bash
ln -s <repo>/extras/addons/project-brief ~/.cogyard/addons/project-brief
```

Then restart the portal — manifests resolve once per process, so a new add-on is
not seen until the next start (`docs/DEPLOY.md`). The job then appears under
**Scheduled jobs** on `/settings` with its schedule, last run, next run, rolling
cost and log, and "Run now" fires it without waiting for 05:00. A symlink install
is the one to prefer while developing: the add-on tracks the checkout, and its
`import` of the engine resolves to that same checkout rather than to whatever the
registry points at.

- **`project-brief`** — once a night, an agent reads each project's tasks,
  commits and last session, and writes three paragraphs into
  `$COGYARD_HOME/briefs/<slug>/YYYY-MM-DD.md`. The example of a job whose unit of
  work is a PROJECT, and whose change detection ("nothing since the last brief")
  is what keeps it from spending anything on a quiet night.
- **`doc-drift`** — once a night, finds docs the tasks left behind: a doc whose
  own declared area kept changing long after the doc did, reported to
  `$COGYARD_HOME/drift/<slug>.md`. The example of a job that is **cheap first and
  expensive second**: the candidate query (`core/doc-drift.mjs`) is git and file
  reads with no agent at all, and the agent is asked only about what survives it.
  Also the example of a job that **reports and never fixes** — it writes about
  docs, never to them, because the prose it audits records the owner's decisions.
- **`chat-archive`** — once a day, copies every agent conversation and chat
  record into `$COGYARD_HOME/chat-archive/`, adding and updating, never deleting;
  a file the agent removes stays, marked gone from source in the archive's
  manifest. The example of a job with **no agent and no settings**: it asks the
  driver where the stores are (`transcripts.root()`, `sessions.root()`), so no
  agent's folder is named outside `drivers/`, and its destination follows
  `COGYARD_HOME`. It is machine-level, not per-project, so its heartbeat is
  written at the archive (`chat-archive/heartbeat.md`) rather than under a
  project's slug, and it does not appear on the Daily tab.

**`project-brief` and `doc-drift` render nothing themselves.** Each writes a file
under `$COGYARD_HOME`, keyed by the project's registry slug, and the portal's
**Daily** tab — which is CORE, permanent, and present for every project whether
or not any job is installed — reads whatever is there. `briefs/<slug>/YYYY-MM-DD.md`
becomes the brief history; `drift/<slug>.md` becomes the drift section. Uninstall
both and the tab is still there, empty and correct.

#### Where a job's output goes — never into a task store

A job writes under `$COGYARD_HOME`, beside `jobs.json`, never inside a project
or its task store. The layout core reads (`core/job-output.mjs`):

```
$COGYARD_HOME/briefs/<slug>/YYYY-MM-DD.md
$COGYARD_HOME/heartbeats/<slug>/<job-id>.md
$COGYARD_HOME/drift/<slug>.md
```

`<slug>` is the project's registry slug (`ctx.projects[i].slug`); one that is
not a plain path segment (letters, digits, `.`, `_`, `-`) is refused. An add-on
installs outside the repo and cannot import core synchronously, so it spells
these paths itself from `$COGYARD_HOME` — this section is the contract.

**When a project's slug changes.** A checkout that moves, or
several merged into one, is re-registered under a new slug, with the old paths
kept as `aliases` on the registry entry. Output written before the move still
sits under the old slug, and nothing moves it. So:

- Core hands each job `ctx.projects[i].formerSlugs` — the slugs the project was
  registered under before (derived from `aliases`, the same way the usage
  ledger maps old rows). Empty for almost every project.
- A job **writes only under the current slug**, never under a former one.
- A job that **reads its own earlier output** (the brief job finding last
  night's brief) also looks under each former slug, the current slug's file
  winning when both have one. Otherwise a move reads as the project's first
  night and pays for an agent call.
- Core's readers already do this for the Daily tab and Overview: briefs and
  heartbeats are the union across slugs, one file per name. A drift report
  under a former slug is shown only until a job writes a heartbeat under the
  current slug — after that, a clean pass removes the current slug's report
  only, so the old one would otherwise read as a live finding forever.

Why not the store: these files used to live in each project's task store,
chosen so the store's git would keep their history. A job
may not commit, so nothing ever committed them, and they sat pending until an
unrelated `cogyard tasks sync push` swept them into someone else's commit. A
heartbeat is also a fact about ONE machine, which is wrong in a shared team
store. And not `<project>/.cogyard/` either: every worktree has its own copy of
that folder, so output there would split per worktree. The accepted cost: no
git history of briefs and no cross-machine sync. A plain `sync push` now
commits only task files (`core/store-audit.mjs`), so anything a job did leave
in a store stays pending rather than riding along.

#### The heartbeat — say that you looked, separately from what you found

A job that correctly writes nothing on a quiet night has a problem: silence stops
being evidence. "This project has been quiet for a week" and "this job died a
week ago" produce the same empty page, and a nightly job's failure mode is
ABSENCE, which is what nobody notices.

So a scheduled job that can decline to write should record that it LOOKED:

```
$COGYARD_HOME/heartbeats/<slug>/<job-id>.md

---
job: project-brief
checked: 2026-08-25                       # local day, YYYY-MM-DD
checked_at: 2026-08-25T05:00:12.482Z      # exact moment, ISO
outcome: unchanged                        # written | unchanged | failed — see below
---

Looked at this project on 2026-08-25. Nothing had happened since the last
brief, so none was written.
```

One file per job, overwritten each run — a year of heartbeats is one file, not
365. The body is one plain sentence, because someone will open this in an editor
one day with no idea what wrote it. Core reads them with
`readHeartbeats(slug)` (`core/briefs.mjs`) and the Daily tab renders **one
line per job** — quiet reassurance, or an alarm past three days. Per job, not per
project: two jobs fail independently, and a single merged line would report the
healthy one while hiding the dead one.

**`outcome` has exactly three values, and they are about the RUN, not about your
job's internal vocabulary.** Resist widening this field — a contract that grows a
term every time a job is added stops being a contract and becomes a list:

| value | means |
|---|---|
| `written` | it looked and produced a report |
| `unchanged` | it looked and there was nothing new to say |
| `failed` | it looked and could not finish |

Your job's own distinctions belong in the **note**, which is free text. `doc-drift`
is the worked example: it has five internal outcomes and maps them onto the three
(`findings`→`written`; `clean` and `unchanged`→`unchanged`; `unjudged`→`failed`,
because a doc that came back without a verdict is a blind spot, not a clean bill
of health), while the note still says which one it was.

**Write the format; do not import another add-on's writer.** Add-ons install
separately and may not import one another, so this document is the shared thing,
not the code — `project-brief` and `doc-drift` each implement the writer, and
`test/doc-drift-addon.test.mjs` pins the two together by asserting core parses
both identically. If you add a third job, add it to that test.

Two rules that are easy to get wrong:

- **Write it for every outcome you actually reached, including the quiet one.**
  The quiet heartbeat is the whole point — it is the affirmative "it ran, and
  there was nothing to say" that an empty page cannot give.
- **Do NOT write it for a unit you skipped.** A project the run never reached
  (`maxUnits`, `maxCostUsd`, an abort) genuinely went unobserved, and claiming
  otherwise hides exactly what the owner needs to see.

No heartbeat at all is not an alarm and must never render as one: most projects
have no job watching them and never will.

That is the whole integration, and it is deliberate: an add-on contributes no
panel, registers no tab, and needs to know nothing about the portal. If you want
a job of your own on that page, write one of those files — or propose a new file
shape for core to read, which is a core change and a deliberate one.

Both illustrate the same three habits worth copying: skip the agent entirely
when there is nothing to ask it, keep a fingerprint of what was already judged so
a re-run costs nothing, and lead the `summary` with what needs acting on — a
failure ALWAYS outranks a clean verdict on that line, or "nothing looks wrong"
gets read as "everything was checked".

### Platforms

Core is cross-platform, so an add-on declares where it runs. On a host not in
`platforms`, the card renders dimmed/disabled and none of your functions are
called. A macOS/Cloudflare tunnel and a Windows/ngrok equivalent are two
different add-ons — that's the point.

### Degradation rules (what the loader guarantees)

- No `addons/` dir → empty catalog; the portal shows "No add-ons installed".
- A module that fails to import, exports no manifest, mismatches its folder
  name, or lacks a label → listed under **Broken installs** with the error;
  never crashes the engine.
- A throwing `prereqs()`/`status()` → reported on the card (unhealthy /
  prereqError); never crashes the engine.

## API surface (portal ⇄ server)

| Endpoint | Method | Returns |
|---|---|---|
| `/api/addons` | GET | catalog: wire-safe manifests (functions stripped; `supported` + `active` flags added) + machine prereqs + broken installs |
| `/api/addons/status` | GET | every installed add-on's machine-level `status()` + prereqs |
| `/api/addons/:id/config` | POST | persist the owner's config values (declared keys only) |
| `/api/addons/:id/:action` | POST | body = the card's config values, overlaid on what is stored; safe → `run()`'s `{ ok, manual: false, message }`; manual → `{ ok, manual: true, command, note }` — never executed |

The POST goes through the same `requireSameOrigin` write seam as every other
portal write (`server/http.mjs`); everything else non-GET still 405s; no CORS.

`config` is a **reserved action id**: the config route is matched first, so an
action you call `config` can never be triggered. Name it something else.

## Writing your first add-on (5 minutes)

1. `mkdir -p ~/.cogyard/addons/hello`
2. Write `~/.cogyard/addons/hello/addon.mjs` with a manifest like the one above
   (id `hello`; a `status()` returning `{ enabled: true, summary: 'hi' }` is
   enough).
3. Restart the server (`npm run api` in dev, or reload the LaunchAgent).
4. `curl localhost:7440/api/addons` — your manifest is in the catalog.
5. Open **/settings** (the sidebar cog) — your add-on appears as a row under
   Add-ons; Configure opens its dialog. No change to core, server, or frontend.
   That's the whole ecosystem mechanism.

## Candidate add-ons (worked examples of the boundary)

- **tunnel** — ONE card: "cogyard can expose dev servers at stable
  Cloudflare hostnames." Machine prereqs (cloudflared installed, logged in);
  `status()` rolls up every tunnel-enabled project from its own tunnels.json;
  `project`/`hostname` config fields; `enable`/`delete` manual, `repoint`/
  `disable` safe. macOS + Cloudflare specific, which is exactly why it's an
  add-on and not core. Its CLI (`cli/tunnel.mjs`) predates this framework and is
  the prototype to re-author against the contract (`docs/TUNNELS.md`).
- **serving/reverse-proxy** — the local Caddy/nginx layer that puts a clean
  hostname + TLS in front of `:7437` (`docs/DEPLOY.md`). Same platform-specific
  shape; mostly `manual` actions (the portal shows your Caddyfile stanza, it
  doesn't rewrite it).
