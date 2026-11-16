# Doc drift — an add-on

Once a night, per project: which docs have the tasks left behind?

1. **The candidate query** (free, no agent) — a doc whose own declared area kept
   changing long after the doc itself last changed. Derived from `touches_paths`
   and git history, both of which already exist.
2. **The judgement** (one agent call per candidate) — read the doc, read what
   those tasks actually did, and decide whether some claim in it is now *wrong*.

Findings are written to `$COGYARD_HOME/drift/<slug>.md` (never into the
project's task store), one file per project,
overwritten each run and **deleted when there is nothing to say**.

**It never edits a doc.** Architectural prose records the owner's decisions; a
nightly agent rewriting it would mean never trusting again that a doc says what
was decided. Fixing a doc is a normal task, picked up by a human.

Not core. cogyard works without it, and the candidate query behind it
(`core/doc-drift.mjs`) is useful on its own.

## What a finding looks like

```markdown
## docs/ADDONS.md

Last changed 2026-07-06 (f6376016), 31 days before the newest work in its area.

**It says:** “Core ships the contract, the loader, and zero add-ons.”

**Now:** Two add-ons ship in-repo under extras/addons/ and are installed by symlink.

**Contradicted by:** #113 Self-updating model price table · #118 Scheduled jobs
```

## Install

The source lives in the cogyard repo; add-ons load from `~/.cogyard/addons/`.
Symlink is the recommended install — the add-on then tracks the checkout, and
its `import` of the engine resolves to the same checkout:

```bash
ln -s ~/gitroot/cogyard/extras/addons/doc-drift ~/.cogyard/addons/doc-drift
```

A copy works too (the engine is then resolved through `~/.cogyard/projects.json`
instead, so the `cogyard` project must be registered):

```bash
cp -R ~/gitroot/cogyard/extras/addons/doc-drift ~/.cogyard/addons/
```

Then restart the portal so the manifest is picked up — manifests resolve once
per process:

```bash
launchctl bootout gui/$(id -u)/com.cogyard.serve
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cogyard.serve.plist
```

It appears in **/settings** under Add-ons (activate it there) and under
Scheduled jobs, where you can move its time or press **Run now**.

## Configuration

| Field | Default | What it does |
|---|---|---|
| Which files count as docs | `CLAUDE.md, docs/**/*.md, _docs/**/*.md` | `_tasks/` is always excluded — task files record the moment they were written and cannot be stale |
| Minimum contradicting tasks | `2` | A doc needs sustained churn in its area, not one commit |
| Minimum days between the doc and the newest work | `30` | Yesterday's work is not drift |
| Model | the driver's default | |
| Per-doc timeout (seconds) | `180` | Core's `timeoutMs` bounds the whole run; this bounds one call |
| Skip these projects | — | Comma-separated slugs |

Raise the two thresholds if the report ever tells you something you already
knew. A report that cries wolf once is a report you stop reading, and that is
the only way this feature fails.

### The credential

This job runs at 05:20 with nobody watching, so the agent it calls has to sign in
without a prompt. That token is not this add-on's — every job that calls an agent
uses the same one — so it is handled by the **Scheduled tasks with LLM analysis**
add-on (`extras/addons/scheduled-tasks/`): install that, and its row in Settings says
whether the token resolves and walks through setting one up. Switching it on is
also what shows the Scheduled tasks section this job runs from.

This job only reports it: when the credential is missing, this add-on's prereq
list and its Scheduled jobs row both say so. Nothing here ever holds the value.

## What it costs

Nothing on a quiet night. The candidate query is git and file reads; the agent
is called only for docs that pass the threshold, and not at all when the same
candidates were already judged (the fingerprint of what was examined is kept in
`~/.cogyard/doc-drift.json`). Bounds: at most 12 docs and $2 per run by default,
both adjustable in the manifest.

## Files

| | |
|---|---|
| `addon.mjs` | the manifest, the schedule, and the per-project loop under its bounds |
| `prompt.mjs` | the question asked about one doc, and the strict reading of the answer |
| `report.mjs` | `$COGYARD_HOME/drift/<slug>.md` and the heartbeat at `$COGYARD_HOME/heartbeats/<slug>/doc-drift.md` — written, rendered, and removed |
| `state.mjs` | `~/.cogyard/doc-drift.json` — what was already judged, so it isn't re-judged |
| `cogyard.mjs` | reaching the engine from outside the repo |
