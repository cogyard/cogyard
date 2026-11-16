# Multi-user v1 — the team model

N developers share ONE project's task store via a git remote. Nothing else is
shared: each member keeps their own machine, own `~/.cogyard/` (registry,
ports, usage, tunnels), own worktrees, and own localhost portal reading the
same synced store. There is no server, no accounts, no auth — git is the
backbone. (Real users + auth + one shared team portal is the vNext design.)

## How it fits together

```
                 origin (e.g. GitHub repo, branch `tasks`)
                /            |             \
   ~/gitroot/_tasks/<slug>   |    ~/gitroot/_tasks/<slug>
        (lead's clone)       |       (member's clone)
             ▲               |              ▲
   <project>/.cogyard/tasks  |    <project>/.cogyard/tasks
        (symlink)            |         (symlink)
      lead's checkout        |      member's checkout
                             |
              each member's own portal on localhost
```

- The store is the project's task files in their own git repo on branch
  `tasks`, cloned per machine under `<PROJECTS_ROOT>/_tasks/<slug>`.
- Every checkout/worktree on a machine reaches that machine's clone through
  the absolute `.cogyard/tasks` symlink (the SessionStart hook mounts it in
  worktrees). A member whose checkout still has an old top-level `_tasks` link
  must replace it with `.cogyard/tasks` (same target) — cogyard no longer reads
  `_tasks`. The store is what is shared, not the link.
- Consistency between machines is git consistency: pull/rebase/push. The claim
  and id commands below do that automatically at the moments that matter.

## Setup

**Team lead (one-time).** From the project checkout, publish the store:

```
cogyard tasks convert --remote git@github.com:you/yourproject-tasks.git
```

`convert` gives the project its own store repo (branch `tasks`, adopting an in-repo `_tasks/` folder if there is one), links
`.cogyard/tasks` to it, commits the `.cogyard/.gitignore` entry, and pushes. The remote should be an
empty repo the whole team can push to.

**Every other member (one command).** Clone the project repo as usual (its
task link is gitignored, so you have none yet), then:

```
cogyard tasks join git@github.com:you/yourproject-tasks.git
```

`join` clones the store to `<PROJECTS_ROOT>/_tasks/<slug>` (override with
`--slug` / `--store`), mounts the absolute `.cogyard/tasks` symlink, registers the
project in your local registry, and runs the `doctor` audit. Idempotent —
re-running against a healthy setup is a no-op; it refuses to repoint an
existing link (of either name) at a different store.

## Claims — who's working on what

`cogyard env claim <task-file> <session-id>` on a remote-backed store:

1. **Pulls first** (`--rebase --autostash`), so the check runs on fresh state.
2. Records `env.claimed_at`, `env.branch`, and **`env.claimed_by`** — the human
   identity: `$COGYARD_USER`, else `git config user.name`, else `$USER`. Set
   `COGYARD_USER` if your git name isn't what teammates should see. The worktree
   folder and the chat session are this machine's business and never enter the
   shared file: they go to `~/.cogyard/claims.json`. `cogyard env where
   <task-file>` shows both halves together.
3. **Pushes the claim commit immediately** (only the task file), so teammates
   see it without waiting for an unrelated `sync push`.

A lost race — someone claimed between your pull and push — is unwound
automatically (touching only that task file) and reported as a normal refusal:

```
{ "error": "already_claimed", "claimed_by": "Alice", "claimed_at": "…", … }
```

never a raw rebase conflict. `release` follows the same pull → edit → push
protocol. The portal's tasks view and `cogyard tasks current` show the holder's name.

**Claims persist until merge.** A claim means "owned", not "a session is live
right now": finished-but-unmerged work stays claimed (that's "in review" —
teammates see who owns it), and the merge flow (`merge-to-main` step 10)
closes the task with `cogyard tasks close` (status DONE + `done_date`, claim
released — it refuses a claim held by someone else). Release
manually only to return a task to the pool.

## Task ids

`cogyard tasks next-id <slug>` on a remote-backed store pulls before scanning,
then commits + pushes the placeholder file as the reservation. If a
competitor's file with the same number arrives concurrently, the reservation
is renamed to the next free id before pushing — two machines can never end up
with duplicate ids. (`validate` / `doctor` also flag any duplicate id as a
schema error, as the backstop.)

## Day-to-day

Everything else is unchanged from single-user cogyard:

- `cogyard tasks sync pull` / `sync push "<msg>" -- <file>…` — the general-purpose sync
  for task body edits (box ticks, scope changes). Claims and id reservations
  push themselves; ordinary edits still ride sync push.
- Offline is tolerated everywhere: claims, releases, and reservations commit
  locally with a warning and publish on your next `sync push`.
- To see what everyone has committed into the store, open the project's Graph
  tab and switch it to **Task store**: teammates' commits arrive there with
  your next pull, each flagged if it took job output, a non-task file or
  another task's file. The toolbar shows how many of your commits are
  unpushed.

## Limits of v1 (by design)

- **Claims are advisory.** `claimed_by` is self-reported; there is no auth and
  nothing stops a hostile writer. Fine for a trusting team; not a security
  boundary.
- **Eventual consistency.** The pull→push window is small but not zero; the
  loser of a rare race gets a clean refusal, not corruption.
- **No shared dashboard.** Each member's portal shows the store as of their
  clone's last sync. A single hosted team portal with accounts, auth, and an
  authoritative claim service is a planned vNext design.

## Single-user / local-only stores

A shared store without a remote gets NONE of the above behavior: no pulls, no
pushes, byte-identical to pre-070 cogyard. (An in-repo `_tasks/` folder is not a
supported layout at all — `convert` / `onboard` adopt it into a shared store.) The
team machinery activates only when the canonical store has an `origin` remote and a
`tasks` branch.
