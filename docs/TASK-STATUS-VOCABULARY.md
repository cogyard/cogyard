# Task status vocabulary

The `status` frontmatter field on every `_tasks/NNN-*.md` file is one of:

| status        | meaning                                                                 | counts as backlog? | done_date |
|---------------|-------------------------------------------------------------------------|--------------------|-----------|
| `OPEN`        | active backlog — pickable now (or waiting on an unmet dep)              | yes                | null      |
| `PARKED`      | deliberately shelved; not being worked, not abandoned                   | yes (waiting)      | null      |
| `ENOUGH` | a version of done — see below                                           | **no**             | should be set |
| `DONE`        | fully complete; nothing left                                            | no                 | set       |
| `OBSOLETE`    | abandoned / superseded; will not be done                                | no                 | —         |

## No "blocked" status — `BLOCKED_ON` is retired

Blocked-ness was a hand-set copy of what the dependency graph already derives,
so it could (and did) go stale. The two-way rule:

- **Blocked on another task** → list it in `depends_on:` and stay `OPEN`. The
  portal derives `waiting on #N` and self-clears it the moment task N closes —
  no file edit.
- **Blocked on something external** (a decision, a vendor, a launch window) →
  `PARKED`. A deliberate hold, whatever the reason; a human un-parks it.

Legacy files still carrying `status: BLOCKED_ON` parse with a validator
warning (never an error) and show in the portal's Waiting bucket.

## `ENOUGH`

"Satisfied with it for now; closed, not active backlog." The feature shipped. Known
leftovers are recorded in the file body for possible later harvesting. It is **not**
in-progress and **not** something actively owed.

Treated as a **closed/done-family** state everywhere DONE is:
- excluded from active-backlog counts (open/ready/blocked) in the overview;
- never flagged stale (staleness is noise on a closed task);
- **satisfies a dependency** — a task that `depends_on` an `ENOUGH` task counts as met;
- carries a `done_date` (it's closed), unlike `OPEN`;
- gets its own bucket/column/filter in the portal and its own section in `INDEX.md`,
  positioned with the closed states, not the active backlog.

### Convention — record the leftovers

An `ENOUGH` file SHOULD keep a `## Leftovers` (or `## Remaining`) section listing
the unharvested bits — the whole point of the status is finding these later to mine
them. Example:

```markdown
## Leftovers
- Pagination on the results list (works fine for <100 rows; revisit if it grows)
- No retry on the upload path — acceptable for now
```

### Exit paths

- **Harvest something** → spin a new `OPEN` task for that leftover (link it with
  `related`); leave this file `ENOUGH`.
- **Decide it's fully done** → flip to `DONE`.
- **Decide a leftover matters now** → flip back to `OPEN`.
