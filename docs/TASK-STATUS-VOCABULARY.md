# Task status vocabulary

The `status` frontmatter field on every `NNN-*.md` task file is one of:

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
  no file edit. A task in **another project** is written `<project-slug>#<id>`
  (`depends_on: [cogyard#166]`); it resolves through the registry the same way,
  and the other project's Plan tab shows it as blocking this one.
- **Blocked on something external** (a decision, a vendor, a launch window) →
  `PARKED`. A deliberate hold, whatever the reason; a human un-parks it.

`status: BLOCKED_ON` is now an invalid status like any other unknown value:
the validator reports it as an error and the Plan tab lists it under problems.

## Order, and running at the same time — three lists each task keeps about itself

Two separate questions, each answered from lists a task keeps about **itself**.
A task never names another task it might collide with, so adding a task never
means editing another one.

| Question | Answered from | Read by |
|---|---|---|
| **Can this task start yet?** | `depends_on` — it can start once every task listed is finished. | The Tasks tab, the Plan tab's waiting groups, autopilot's order. The **only** thing that makes a task wait. |
| **Can these two tasks run at the same time?** | `touches_paths` (the files it edits) and `resources` (what it uses that isn't a file: `prod-db`, `dns`, `app-store-submission`, a device). Two tasks can run at once when they share no file and no resource. Sharing one never makes either wait — either may go first. | Each task's `clash` list in `cogyard tasks plan --json`, the Plan tab's **Autopilot** filter, autopilot's batches. |

- A task can be handed off now when its `depends_on` is finished **and** it
  shares no file or resource with a task in progress.
- A `resources` name is lowercase words joined by `-`. Two tasks using the same
  live thing must spell it the same. Names are compared within one project only.
- A shared Markdown file never counts: docs merge easily.
- Shared files are a **guess**, used before any work exists (choosing which tasks
  to start together). Once tasks are running, the real answer comes from git:
  `cogyard tasks conflicts <id>` does a dry-run merge of the task's branch
  against every other task branch in progress and main, changing nothing, and
  exits 1 only when one would actually conflict. Two tasks editing one file
  usually merge cleanly; the working chat runs it after each commit and stops
  only on a real conflict.
- `related` is a reading link and affects neither question.
- **Retired:** `coordination` and `parallel_safe`. A "must finish first" rule
  is `depends_on`; a "shares a live thing" rule is `resources`; advice on how to
  edit alongside another task goes in the task's body (Branch strategy); a hold
  from outside any task is `PARKED`. The validator warns when an `OPEN` or
  `PARKED` task still carries either field; a closed task keeps them as history.

## Steps only the owner can do — `(you: …)` on a checkbox

When a step needs the owner, mark **that checkbox** — not the task — at the start
of its text:

```markdown
- [ ] (you: credential) Log in to the machine Cloudflare account
- [ ] Move every tunnel config to the new account
```

The need lives on the step, so it clears itself when the box is ticked, and the
task is autopilot work up to the first marked box. An owner step is only
something the agent can't get past without the owner **partway through the
work**. Kinds (closed list, `core/status.mjs` `OWNER_STEP_KINDS`; several
allowed, comma-separated):

| kind         | the owner must…                                             |
|--------------|-------------------------------------------------------------|
| `decision`   | choose something the task can't settle                      |
| `credential` | supply a login, token, account or secret only they hold     |
| `purchase`   | spend money                                                 |

**The owner's "merge it" is their review.** The owner always looks at the work
(on their phone, in the browser, in the worktree's portal) before saying "merge
it". So a task has no box for the owner looking at it, trying it on their
phone, living with it for a few days or confirming it, and no box for anything
after a production deploy (deploying is the owner's; a problem found there is a
new bug task). When the owner says "merge it", `merge-to-main` ticks every open
owner box as reviewed — "Owner reviewed it and said "merge it", <date>" — and
the task closes as DONE. That covers older files too.

An older kind, `device` ("check it on real hardware"), still reads without a
complaint so older files validate, but is no longer written. An unknown or
missing kind is a badly written marker (see "Badly written markers" below).

## Boxes settled without being done — `(dropped: …)`, `(moved: …)`, `(optional)`

A box that was decided rather than done stays `[ ]` and says what happened, at
the start of its text, in one of three words (`core/status.mjs` `SETTLED_KINDS`):

```markdown
- [ ] (dropped: push not now) Watchers inside the portal process
- [ ] (moved: 050) Create the fresh public repo          ← another project: (moved: other-project#12)
- [ ] (optional) Icons in the hidden-tabs list
```

| word | means | stops a plain `tasks close`? |
|------|-------|------------------------------|
| `dropped: <why>` | won't be done | no |
| `moved: <id>` | continues in another task (must exist) | no |
| `optional` | left behind — a leftover | yes: close as `ENOUGH` (`--enough`) |

A box whose text starts with `~~strikethrough~~` reads as `dropped` with no reason.

**DONE means there is nothing left to see in the task** (owner, 2026-10-21):
every box is ticked, dropped or moved. Anything left behind is `optional` and
makes the task `ENOUGH`, so a DONE task never has to be reopened to hunt for
what was skipped. To pick the word for an unticked box: still wanted → file a
task and write `(moved: <its id>)`; not needed → `(dropped: why)`; fine to leave
behind → `(optional)`. There is no "wanted, but nobody holds it": the
`(deferred)` marker was retired for that reason, and a `(deferred)`
still in a file is a badly written marker whose message says what to write instead.

The progress fraction (the Tasks tab's Sub column, the Plan card's squares,
the recently-done strip, `tasks doctor`) counts the same way: a `dropped` or
`moved` box leaves the total, and an `optional` box stays in it as unfinished.
A task closed with 20 boxes ticked and 6 dropped or moved reads
20/20. `cogyard tasks doctor` lists DONE tasks that still hold open boxes —
unmarked or `optional` — and for an unmarked box that already says
in prose how it was settled ("→ MOVED to the follow-up task", "OBSOLETE (…)", "Deferred …")
it shows the marker that prose reads as. It only lists; marking a box, or
reopening the task and closing it as ENOUGH, is the owner's decision.
Write the word, never prose like "→ MOVED to the follow-up task" or "Deferred (owner's
call)": a computer can't read prose, and `cogyard tasks close` treats an
unmarked open box as unfinished work. Moving work to another task? Write that
task first, then mark the box `(moved: <its id>)`. Markers combine with an owner
step in either order (`(you: decision) (dropped: moot) …`). A misspelt word, a
`(moved: …)` naming a task that doesn't exist, or `(dropped)` with no reason is
a badly written marker (below).

## Checks that wait for the merge — `(after merge)`

Some checks can only run once the work is on main: the always-on local server
has to be serving it, or the hooks that would show it run the main checkout's
code. (Never a production deploy: that is the owner's, and not part of the
task.) Mark those boxes `(after merge)`:

```markdown
- [ ] (after merge) The Plan card reads "idle" on the real portal
```

| | |
|---|---|
| whose work | the agent's, never the owner's |
| when | right after the merge: `merge-to-main` runs each one against the merged code, ticks it with what was seen, then closes |
| stops a plain `tasks close`? | yes, until ticked; the refusal lists these apart from other open boxes and tells the agent to run them, not to ask the owner |

It combines with the other markers in any order. A near-miss such as
`(post-merge)` or `(after-merge)` is a badly written marker, because it would
read as an ordinary open box. No check may need the owner to close or restart
their own chat.

## Badly written markers — an error, caught when written and before a merge

A checkbox marker that is misspelt (`(dropepd: …)`), retired (`(deferred)`),
incomplete (`(dropped)` with no reason, `(moved)` with no task, `(you)` with no
kind), points at a task that doesn't exist (`(moved: 999)`), carries a note
inside it (`(you: decision, added at pickup)`), or is a near-miss of
`(after merge)` silently means something else to `tasks close` and the
progress fraction. Each is a validator **error**, and every message says what
to write instead:

- **When written:** the Edit/Write hook refuses a write that adds a new one. A
  file's existing ones stay editable, so it can always be fixed.
- **Named:** `cogyard tasks validate` lists each one and exits 1; `cogyard
  tasks doctor`'s schema section names the file and the problem; the portal's
  Tasks tab flags the file.
- **Before a merge:** `merge-to-main` checks the task's file before merging and
  stops on one; `cogyard tasks close` refuses while the task's file has one.

Fixing a typo is mechanical. Choosing what a box becomes — `(optional)`,
`(moved: <id>)` or `(dropped: why)` — is the owner's decision.

## Closing a task — `cogyard tasks close <id>`

One command does all three closing steps: `status` + today's `done_date`, the
claim release (`env release`), and the store commit. It goes ahead only when:

- every box in the file is ticked or settled (see above);
- `status` is `OPEN`;
- the task's `env.branch` is merged into main — or there is no branch to merge
  (none recorded, or it never got a commit of its own);
- the claim, if any, is yours.

Otherwise it changes nothing, exits 1, and lists the reasons. Open
`(after merge)` boxes come first, as "check(s) waiting on the merge"; when they
are the only reason, the refusal tells the agent to run them and close again.
Any other refusal tells an agent to leave the task OPEN and tell the owner
what's left, never to ask and never to offer the flags below; only the owner,
running the command themself, sees them. `--enough` closes
as `ENOUGH` (open and `(optional)` boxes become the recorded leftovers);
`--force` closes as `DONE` regardless. `cogyard tasks doctor` lists every OPEN
task in every project that would close cleanly — it only lists them; nothing
closes until the owner runs the command (`merge-to-main` runs it on the
owner's "merge it").

A close also rewrites the status word in the task's `> **Status: X.**` line, when
the file has one, so the text never contradicts the frontmatter; and it clears
the id reservation `next-id` left for the chat that filed the task.

### The owner's calls — `--enough`, `--force`

Overruling a refused close overrides the owner's sign-off, so it is the
owner's call — but the owner telling an agent to do it counts the same as
running it themself. Started by an agent (any installed driver's
`inSession()`, the check `cogyard publish` uses), `close --enough` and
`close --force` go ahead only with `--asked "<the owner's exact words>"`, and
only when those words:

- are in a message the owner typed in this chat — the driver's
  `transcripts.ownerTurns()`, which leaves out the agent's own text, tool
  output, a skill's expanded arguments, pasted text and other chats;
- say "close" and the outcome: **enough** for `--enough` ("close it as
  enough"), **done** for `--force` ("close it as done"). A bare "close it" is
  neither, and "close it when it's done" asks for a plain close later.

The words go into the store commit (`close #N as ENOUGH — owner said: "…"`).
Anything else refuses, changes nothing, says which check failed, and prints
the exact command for the owner. The agent never offers either flag; it runs
one only when the owner already said so. A plain `close` — every box ticked
or settled — stays open to agents and the autopilot (which, unattended, never
uses the flags).

At the owner's "merge it", the agent runs its own `(after merge)` checks and
ticks each with what it saw, ticks every open owner box as reviewed (the
owner's "merge it" is their review), and closes the task as DONE. It never asks
for a go. If the close still refuses (a check of the agent's failed, the
agent's own work is unfinished, someone else's claim), the task stays OPEN with
its claim and the merge report says what's left; the owner is asked nothing.
The agent never offers ENOUGH or DONE-anyway. Settling an open box (dropped,
moved, optional) so a close goes through is the owner's
decision, in the owner's words.

### Undoing a close — `cogyard tasks reopen <id>`

`reopen` puts a `DONE` or `ENOUGH` task back to `OPEN`, clears `done_date`,
rewrites the status line, and commits `reopen #N (was X)` — plus the
`--why "<reason>"` given and, when an agent ran it, that chat's id. It does not
claim the task. A wrong close is fixed with `reopen` and then the right
`close` — two commits that say what happened. `close` on a task that is
already closed refuses and names `reopen`.

Agents may run it: it only makes a task less done, and more work
that belongs to a closed task reopens it — pickup-task does it right after
claiming a DONE or ENOUGH task, because the owner asking for the follow-up is
the reason. A DONE file with new open boxes would say the work is finished
when it isn't, and the next merge's `close` would refuse it.

### What stops the shortcuts

- The Edit/Write hook (`cogyard hook validate-frontmatter`) refuses, in an
  existing task file, a `status:` change into or out of `DONE`/`ENOUGH` and any
  `done_date:` change. New files, `OPEN`↔`PARKED` and `OBSOLETE` pass.
- The Bash hook `cogyard hook guard-task-store` refuses git commands that write
  (commit, revert, reset, checkout, stash, …) inside a registered project's task
  store. Reading it with git is always allowed; changes go through `sync push`,
  `close`, `reopen` and `env claim`/`release`.

## A claim is valid only on an `OPEN` task

A claim means "being worked". A closed task with more work is reopened first
(`cogyard tasks reopen`), so it is `OPEN` again: the plan puts it under "In
progress" while claimed and "Can start" when not. Nothing closed or parked is
ever held.

- `cogyard env claim` refuses a task that isn't `OPEN` (exit 4, nothing
  written), naming `tasks reopen` for a `DONE` or `ENOUGH` one.
- `cogyard tasks current` lists only `OPEN` claimed tasks — the same set as the
  plan's "In progress".
- A claim left on a task that isn't `OPEN` is a validator error, so parking or
  obsoleting a claimed task by hand is refused at the edit and at the commit.
  Release the claim (`cogyard env release <file>`), or reopen the task.
- `env claim` and `env release` commit the task file themselves, on every store.

## Where task files are checked

One validator, `core/validate.mjs`, holds every rule. One regression rule
(`introducedErrors`) decides what may be written: a new version of a task file
may keep the errors it already had, never gain one, and a new file must be clean.
It runs in four places:

| Where | When | What happens on an error |
|---|---|---|
| Edit/Write hook (`cogyard hook validate-frontmatter`) | an agent edits a task file with its edit tools | the edit is refused if it adds an error |
| `cogyard tasks sync push` | anything is committed to a store — including edits made in a shell or an editor, which the hook never sees | nothing is committed if any staged task file gains an error |
| `cogyard tasks validate [<id>]` | on demand; `merge-to-main` runs it on the task before merging | exits 1, listing each error |
| `cogyard tasks doctor`, the Tasks tab | as reports | error counts per project; a schema flag on each task with an error |

Hand edits of `status:` between `OPEN`, `PARKED` and `OBSOLETE` are allowed (no
command owns them yet); these checks are what keeps them honest.

## `ENOUGH`

"Satisfied with it for now; closed, not active backlog." The feature shipped. Known
leftovers are recorded in the file body for possible later harvesting. It is **not**
in-progress and **not** something actively owed.

ENOUGH is for a task that is **partly done**, where the owner deliberately leaves
items and decides what shipped is enough. Every leftover lives here, `(optional)`
nice-to-haves included: DONE has none. It is never the normal way a task
closes: a finished task closes as DONE at the owner's "merge it", and only the
owner ever chooses ENOUGH, by running `close --enough` themself.

Treated as a **closed/done-family** state everywhere DONE is:
- excluded from active-backlog counts (open/ready/blocked) in the overview;
- never flagged stale (staleness is noise on a closed task);
- **satisfies a dependency** — a task that `depends_on` an `ENOUGH` task counts as met;
- carries a `done_date` (it's closed), unlike `OPEN`;
- gets its own bucket/column/filter in the portal, positioned with the closed
  states, not the active backlog.

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
