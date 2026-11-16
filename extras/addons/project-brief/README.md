# Nightly project brief — an add-on

Once a night, per project, an agent reads the task bodies, the commits since the
last brief, and the last session transcript, and writes three paragraphs:

1. **What happened** — since the previous brief only.
2. **Where it stands** — honestly, including the half-done and the abandoned.
3. **What's next** — the concrete next move, with its task id.

The brief is written to `$COGYARD_HOME/briefs/<slug>/YYYY-MM-DD.md` (beside
`jobs.json`, never in the project's task store) and rendered at
the top of that project's Tasks tab in the portal.

Not core. cogyard works without it; it starts paying for itself somewhere north
of ten concurrent projects.

## Install

The source lives in the cogyard repo; add-ons load from `~/.cogyard/addons/`.
Symlink is the recommended install — the add-on then tracks the checkout, and
its `import` of the engine resolves to the same checkout:

```bash
ln -s ~/gitroot/cogyard/extras/addons/project-brief ~/.cogyard/addons/project-brief
```

A copy works too (the engine is then resolved through `~/.cogyard/projects.json`
instead, so the `cogyard` project must be registered):

```bash
cp -R ~/gitroot/cogyard/extras/addons/project-brief ~/.cogyard/addons/
```

Then restart the portal so the manifest is picked up — manifests resolve once
per process:

```bash
launchctl bootout gui/$(id -u)/com.cogyard.serve
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cogyard.serve.plist
```

The job's schedule, last run, next run, rolling cost and run log show in its own
row under **Add-ons** on `/settings`; scheduled jobs run only while the
**Scheduled tasks with LLM analysis** add-on is on. "Run now" fires it
immediately.

## The credential

The portal process must be able to run an agent headlessly and unattended. For
the Claude driver that means a `CLAUDE_CODE_OAUTH_TOKEN` in
`~/.cogyard/secrets.env` (mode 0600; `docs/CONFIGURATION.md`, "Secrets"), minted
once with:

```bash
claude setup-token
```

The **Scheduled tasks with LLM analysis** add-on (`extras/addons/scheduled-tasks/`)
walks through this in its Configure dialog and says whether the token resolves.

**Not** `claude auth login` — that credential expires on its own schedule and
its refresh does not fire in a subprocess with no TTY, which produces a silent
401 and a skipped job. Re-mint the token annually.

If the credential dies, the job does not go quiet: the night's brief file says
so in place of the paragraphs, the portal renders it as an alert, and the
message escalates each night it repeats.

## Configuration

On the job's Settings row:

| Field | Default | What it does |
|---|---|---|
| Model | the driver's default | Which model writes the brief |
| Per-project timeout | 240s | Aborts one project's agent call; core's `timeoutMs` bounds the whole run |
| Detail block | on | The collapsed evidence block under the paragraphs |
| Skip | — | Project slugs to leave out, comma-separated |

Run-level bounds are declared in the manifest: at most 25 projects get an agent
call in one run, and the run stops calling the agent once it has spent $3.

## Cost, and the silence rule

Most projects most nights produce nothing. Before any agent call the job checks
for new commits, new sessions, and task-file edits since the last brief; when
there are none it stamps the previous brief as still current and spends nothing.
Paying an agent to write "no change" twelve times a night is what would kill
this feature's economics and its credibility at the same time.

Each brief's footer carries what that run cost, and the Settings row carries the
rolling total.

## What it will not do

Reads, and writes one markdown file per project per night under
`$COGYARD_HOME/briefs/<slug>/`, plus its heartbeat at
`$COGYARD_HOME/heartbeats/<slug>/project-brief.md`. Nothing goes into the task
store: these used to, nothing committed them, and an unrelated `sync push`
swept them into its commit.
No commits, no PRs, no edits to project source or docs, no notifications.

The brief is never a source of truth — the task files are. If a brief is wrong,
delete the file; nothing is lost and the next run rewrites it.
