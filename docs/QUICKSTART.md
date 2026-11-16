# Quick start — your first project, first task, and first agent run

This guide takes you from nothing installed to a task an agent has picked up and
finished, shown in the portal. Follow it top to bottom in one sitting; it takes
about fifteen minutes. Every command here was run in this order on a clean
machine, and the output shown is what it printed.

You will:

1. install the engine,
2. install the Claude driver,
3. create a project,
4. write your first task,
5. open the portal and see the task,
6. have an agent pick it up and do it, and watch it move in the portal.

You need Node 22 or newer, `git` with your name and email set, and macOS or
Linux (Windows through WSL). Step 2 and step 6 need
[Claude Code](https://claude.com/claude-code); everything else works with no
agent at all.

## 1. Install the engine

The engine is the `cogyard` command and the portal.

```sh
npm i -g cogyard
cogyard --version
```

```
cogyard 1.161.0
```

This guide matches that version or newer.

Check the machine is ready:

```sh
cogyard doctor
```

```
cogyard doctor — install preflight (/Users/you/.cogyard)

  ✔ Node.js runtime        Node 24.14.0
  ✔ git on PATH            git version 2.39.2
  ✔ config home writable   /Users/you/.cogyard
  ✔ config.json            absent (all defaults)
  ✔ projects root          /Users/you/gitroot
  ! project registry       no projects registered — the portal will be empty until you add one.
      ↳ Run `cogyard onboard <path>` to adopt an existing folder, or `cogyard init <name>` for a new one.
  ✔ agent driver           claude active
  ✔ portal UI built        built
  ! agent hooks wired      couldn't read the agent's hook configuration — wiring is unverified.
      ↳ Check the agent settings file named above, or re-run `cogyard claude install` and paste the block it prints.
  ✔ serve port free        port 7440 free

  8 ok · 2 warn · 0 fail
```

Both warnings are expected at this point: you have no project yet (step 3) and
no agent hooks yet (step 2). A `✘` line is a real problem, and the line under
it says how to fix it.

`~/gitroot` is the **projects root**: where new projects and their task stores
go. Set `COGYARD_PROJECTS_ROOT` to put them somewhere else.

## 2. Install the Claude driver

The driver is the set of Claude Code skills, commands and hooks that let an
agent work your tasks.

```sh
cogyard claude install
```

It links the skills into `~/.claude`, each under a `cogyard-` name:

```
cogyard claude driver linked into /Users/you/.claude:
  + skills/cogyard-autopilot  (/cogyard-autopilot)
  + skills/cogyard-commit  (/cogyard-commit)
  + skills/cogyard-debt-cleanup  (/cogyard-debt-cleanup)
  + skills/cogyard-handoff  (/cogyard-handoff)
  + skills/cogyard-merge-to-main  (/cogyard-merge-to-main)
  + skills/cogyard-pickup-task  (/cogyard-pickup-task)
  + skills/cogyard-write-task  (/cogyard-write-task)
  + commands/cogyard-cleanup-chat.md  (/cogyard-cleanup-chat)
  + commands/cogyard.md  (/cogyard)
  + commands/cogyard-lookup-chat.md  (/cogyard-lookup-chat)
  + commands/cogyard-task-chats.md  (/cogyard-task-chats)

cogyard's skills and commands are /cogyard-<name> here (/cogyard stays /cogyard), so they never take a name your own skills, a project's, or Claude Code's use. Asking in your own words ("merge it") works as before.

Now add these hooks to /Users/you/.claude/settings.json (merge into any existing "hooks"):
```

and then prints a `"hooks"` block. It never edits your settings for you: copy
that block into `~/.claude/settings.json`, merging it with any hooks you already
have. Then run `cogyard doctor` again and look for this line:

```
  ✔ agent hooks wired      all 6 wired
```

If you'd rather not paste a block, the driver also ships as a Claude Code plugin
that wires the hooks itself; the README's
[Install section](../README.md#2-the-claude-driver-optional) compares the two.

## 3. Create a project

Go to your projects root and create a new project called `hello-site`:

```sh
mkdir -p ~/gitroot
cd ~/gitroot
cogyard init hello-site --kind static
```

`init` is for a brand-new project: it makes the folder, so the folder must not
already exist. `--kind static` is a plain static website, and it is the one kind
that comes with a working `dev` script, so the page your agent builds in step 6
is something you can open.

```
Created /Users/you/gitroot/hello-site

Wiring hello-site (kind=static)…
Initialized empty Git repository in /Users/you/gitroot/hello-site/.git/
  + git                          git init -b main
  + register                     hello-site → portal
  + package.json                 minimal, version 0.1.0
  + .gitignore                   +5 line(s)
  + README.md                    written
  + scripts/generate-version.mjs written
  + .cogyard/worktree.json       written
[main (root-commit) f9f2d66] chore: initial commit (cogyard)
 …
  + commit                       initial commit
Created an empty task store at /Users/you/gitroot/_tasks/hello-site.
…
Local-only store (no remote). `sync push` will commit locally and skip pushing.
…
  + store                        shared → /Users/you/gitroot/_tasks/hello-site

✓ hello-site (static) wired.
  repo:   /Users/you/gitroot/hello-site
  store:  /Users/you/gitroot/_tasks/hello-site (shared)
  portal: http://localhost:7440/p/hello-site  (start it with `cogyard serve`)
```

The portal link works once the portal is running, in step 5.

Three things now exist:

- **`~/gitroot/hello-site`**: the project, a git repo with no app code yet.
  cogyard never writes your application; building it is the agent's first task.
- **`~/gitroot/_tasks/hello-site`**: the project's **task store**, a separate
  git repo that holds its task files. The project reaches it through the link
  `hello-site/.cogyard/tasks`, so every worktree of the project sees the same
  tasks.
- **A registry entry** in `~/.cogyard/projects.json`, which is how the portal
  finds the project.

Confirm the project is registered:

```sh
cogyard tasks projects list
```

```
   hello-site                               /Users/you/gitroot/hello-site
```

Already have a folder you want to bring in? That is `cogyard onboard`, not
`init`; see [`PROJECT-INIT.md`](PROJECT-INIT.md). Come back to this guide
afterwards, from step 4.

## 4. Write your first task

A task is one markdown file in the task store: YAML frontmatter on top (status,
type, what it depends on), a description and a checklist below. Reserve the
next number and create the file:

```sh
cd ~/gitroot/hello-site
cogyard tasks next-id home-page
```

```
{"id":1,"padded":"001","file":"/Users/you/gitroot/_tasks/hello-site/001-home-page.md","canonical":"/Users/you/gitroot/_tasks/hello-site"}
```

The file is empty. Open `.cogyard/tasks/001-home-page.md` in your editor and
paste this in, with today's date on the `created` line:

```markdown
---
id: 1
slug: home-page
title: A home page that says hello
status: OPEN
type: feature
created: 2026-10-20
created_at_commit: null
last_reviewed_at_commit: null
last_touched_commit: null
depends_on: []
related: []
touches_paths:
  - index.html
---

# 001: A home page that says hello

## What this is

The project has no page yet. Add an `index.html` at the repo root so
`npm run dev` serves something.

## Scope

- [ ] Write `index.html` with a heading that says "Hello from cogyard".
- [ ] Run `npm run dev` and confirm the page loads.
```

`status: OPEN` puts it in the backlog. `type` is one of `feature`,
`maintenance`, `bug` or `docs`. The three `null` commit fields record where the
task was written and last checked; an agent fills them in, and `null` is fine
for a file you write by hand. The `- [ ]` boxes are the task's checklist: the
portal counts them, and an agent ticks each one as it finishes it.

Check the file:

```sh
cogyard tasks validate
```

```
✓ hello-site — 1 task(s), 0 error(s), 0 warning(s)
```

Then commit it to the task store. The link is ignored by the project's own
git, so `git add` does nothing here; `sync push` commits in the store instead,
and you name every file you changed:

```sh
cogyard tasks sync push "add 001 home page" -- .cogyard/tasks/001-home-page.md
```

```
[tasks 2256458] add 001 home page
 1 file changed, 27 insertions(+)
 create mode 100644 001-home-page.md
Committed locally; skipping push (no remote configured).
```

With the Claude driver installed you can skip the hand-writing: in Claude Code,
say "file this as a task: a home page that says hello", and the `write-task`
skill reserves the number and writes a full task file for you. Writing one by
hand once is the fastest way to learn the format.

## 5. Open the portal

In a second terminal:

```sh
cogyard serve
```

It logs a line containing `"msg":"cogyard API listening"` and `"port":7440`,
then keeps running. Open <http://localhost:7440>, pick **hello-site** in the
sidebar, and open the **Tasks** tab. Your task is there under **Idle**, with
**0/2** in the Sub column: two checklist items, none done.

Prefer a name to a number? <http://cogyard.localhost:7440> is the same portal:
any name ending in `.localhost` points at your own machine, with nothing to
install. [`DEPLOY.md`](DEPLOY.md) shows how to drop the port as well.

Leave the portal open for the next step.

## 6. Have an agent pick it up

Start Claude Code in the project folder:

```sh
cd ~/gitroot/hello-site
claude
```

and say:

> pick up task 1

The `pickup-task` skill takes it from there:

- it **claims** the task, so no other chat can take it at the same time;
- it creates a **worktree**, `task-001-home-page`: a separate checkout on its
  own branch, with its own pair of dev-server ports, so the work never touches
  your `main` until you say so;
- it writes `index.html`, commits, and **ticks** each box as it finishes it;
- it starts the dev server on the worktree's port, so you can open the page.

Watch the portal while it works. The task moves from **Idle** to **Claimed**,
the Sub column counts up (**1/2**, then **2/2**), and the **Worktrees** tab
shows the worktree.

When it is done the agent tells you, and leaves the task claimed: finished but
not merged means **in review**. Open the page, look at the change, and when
you're happy say:

> merge it

The `merge-to-main` skill merges the branch into `main` and **closes** the task.
In the portal it moves to **Done**, **2/2**.

That is the whole loop: write a task, an agent picks it up in its own worktree,
you review, you merge.

### Without an agent

Any agent, script or person can do the same through the CLI; the skills call
these same commands. From `~/gitroot/hello-site`:

```sh
cogyard env claim .cogyard/tasks/001-home-page.md my-session
```

claims it (the last argument names whoever is working it), and the portal
shows it **Claimed**. Do the work, tick the boxes in the file, then commit the
task file:

```sh
cogyard tasks sync push "001: home page written" -- .cogyard/tasks/001-home-page.md
```

and close it, which marks it `DONE` and releases the claim:

```sh
cogyard tasks close 1
```

```
#1 closed as DONE (done_date 2026-10-20), claim released.
```

`close` refuses while a box is still unticked, and tells you which one.

## Where to go next

- [`PROJECT-INIT.md`](PROJECT-INIT.md): `init` and `onboard` in full, the
  project kinds, and what each wiring step writes.
- [`WORKTREE-PORTS.md`](WORKTREE-PORTS.md): how each worktree gets its own
  ports, and how a project's `npm run dev` asks for them.
- [`DRIVERS.md`](DRIVERS.md): driving cogyard from an agent other than Claude
  Code.
- [`MULTI-USER.md`](MULTI-USER.md): sharing a task store with a team through a
  git remote.
- [`TASK-STATUS-VOCABULARY.md`](TASK-STATUS-VOCABULARY.md): what `OPEN`,
  `PARKED`, `DONE`, `ENOUGH` and `OBSOLETE` mean, and how a task is closed.
- The [README](../README.md): every command, in reference form.
