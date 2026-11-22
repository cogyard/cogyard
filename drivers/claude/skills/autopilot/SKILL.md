---
description: A simple manager for several tasks at once — it rehearses the run's commands so nothing will ask mid-run, asks the owner only what is theirs to decide, starts one chat per task doing the normal pickup-task process (side by side, or one at a time when the tasks share a file), waits at the merge point, then merges each task the owner picks itself through merge-to-main, one at a time into local main, checking the work before each merge and main after it, and closes the merged tasks at the end. Branches are pushed; main is not. Trigger when the user says "autopilot", "run the backlog", "run these tasks without me", or asks for a multi-task run with no questions mid-run.
---

# autopilot — a manager for chats doing the normal pickup

Autopilot is a manager. It directs the chats, checks their work and merges it; it does not do
any task's work, beyond handing out the slots that tasks sharing one file compete for (§2). Each
task is worked by its own chat running `pickup-task`, exactly as any chat would. The manager runs
in the project's main checkout.

## 0. Rehearse the run before promising it

The run promises the owner no questions until the merge point. Before asking anything or
starting any chat, check that promise can hold, in the permission mode the owner means to use
for the run:

1. **Local main matches origin.** Run `git fetch origin` first, so the comparison isn't against
   a stale copy; then `git log --oneline origin/main..main` must be empty: each task's worktree
   branches from origin, so a commit only on local main is missing from every one of them, and
   `pickup-task` stops on it. Non-empty → the owner decides (push main first, or leave those
   tasks out).
2. **A worker's half.** Start one rehearsal chat exactly as §2 starts a worker, its brief
   carrying §2's bans. Its brief: make a worktree named `autopilot-rehearsal`, run the worktree
   setup hook in it, make one empty commit, push the branch to origin, leave the worktree with
   ExitWorktree (`keep`), and report every command that asked for permission. It claims no task:
   a claim and release leave the task's branch and worktree recorded, and the real pickup then
   reads them as a worktree made outside the process.
3. **The manager's half.** In this chat, run the commands §4 will run, against the rehearsal
   branch: enter its worktree (EnterWorktree with its path), `git fetch origin main`, an empty
   commit of your own, `git rebase --force-rebase main` (it replays every commit even though
   main hasn't moved, so it really rewrites the branch the worker already pushed, as a real
   merge's rebase does), the project's build, `git push --force-with-lease origin <branch>` (the
   only way a rewritten, already-pushed branch goes up — §4), ExitWorktree (`keep`),
   `git checkout main`, and `merge-to-main` step 6's merge form naming a branch with nothing to
   merge (create one at main's tip; the merge prints "Already up to date").
4. **Report what asked.** Nothing asked → say so. Something asked → name each command and the
   permission mode or allow rule that would have let it through. The owner sets it when they say
   go; if they change anything, rehearse again before §2.

Leave the rehearsal worktree and branches in place and list them, with the commands that remove
them, in the run's last report — §5's, or §3's for a run that doesn't merge. Removing them is
the owner's call.

## 1. Set each task up

Pick the tasks that can run together. From `cogyard tasks plan --json`, a task can run when it is
not in `groups.progress` and its entry under `tasks` has:

- `status` OPEN;
- `unmet` empty — everything in its `depends_on` is finished;
- `youNext` empty, or naming a `(you: decision)` box the owner answers below;
- `claimedByOther` false;
- a `clash` list naming no task in `groups.progress` and no other task in this batch. `clash`
  names each other task it shares a code file (`touches_paths`) or a `resources` name with —
  either may go first, but not both at once. A shared Markdown file isn't in it, and neither is
  a task whose entry has `finished` true: its work is done and only waits to be merged, so
  nobody is writing its files any more (it stays in `groups.progress`, claimed, until then).

The tasks that pass make the **batch**. A task held out only by a clash with another task of the
run is **queued**, in the owner's order (else the plan's): it starts as soon as what it clashes
with is finished (§2).

Then ask the owner, all at once and before any chat starts, only what is truly theirs to answer:

1. **Does this run merge?** Yes: the run waits at the merge point for the owner to say which
   tasks to merge. No: the run ends at the merge point.
2. **For each task, its open `(you: decision)` boxes before the merge point**, and any fork in
   the task file that states no default. A task file that names a default ("default: X",
   "confirm X", "recommended: X") is answered by taking that default — do not ask the owner to
   confirm it. Read `pickup-task` and `merge-to-main` for the stops they would make on this
   task, and settle each the same way: a stated default is taken, and only a fork with none is
   asked. One stop every UI task makes: `pickup-task` step 8 asks where new UI will appear.
   The answer is the placement the task file states (its route, page, parent component or
   sidebar group), passed on in the brief; a UI task whose file states none is asked here.
3. **A task whose `clash` list can't be trusted.** An entry with `filesUnknown` true lists no
   files, so its `clash` list can't show what it shares: ask whether it may run beside the
   others. Ask the same for a task whose `skippedPaths` isn't empty — whole folders or paths
   outside the repo, which the clash check ignores — naming those entries.

Never ask the owner to ratify your own recommendation. Every default you took and every choice
you made yourself is listed in the merge-point report (§3), where the owner can reject it.

A task whose questions aren't all answered doesn't run. A task that reaches a `(you: credential)`
or `(you: purchase)` box before its merge point doesn't run; an answer can't do those.

## 2. Start the chats

Start one chat per task, all of the batch at once. Each is a session of its own, started fresh in
the project's main checkout, not in a worktree of its own: `pickup-task` makes the task's worktree
from there (step 5), and a chat started inside another worktree stops before claiming. It is not
a helper agent inside the manager's chat, which can't make a worktree. Start it:

- **without naming a folder** — the app refuses one; it starts where the manager runs;
- **with `use_worktree: false`** — the manager has been inside a worktree (step 0.3, and every
  merge), and left unset the app then gives the new chat a worktree of its own;
- **in the permission mode step 0 rehearsed, named explicitly** — don't rely on it inheriting
  the manager's.

Its brief: run `pickup-task` for its task from the start, with the owner's answers and any slot
assigned to it, push the task's branch to origin (`pickup-task` never pushes, and an unpushed
branch is lost with its worktree), and stop at the merge point. A question nobody asked stops that chat; it reports
the question and never guesses. Everything the manager tells a chat after that goes to it as a
message. In a serial chain the brief also answers the one stop every queued task would make:
`cogyard tasks conflicts` will report a conflict with the unmerged task before it in the shared
file. That conflict is expected and is resolved at the merge (§4), so the chat notes it and
carries on; a conflict with any other task, or with main, is still a stop. The brief also carries
these bans, word for word — each one is a stream of permission prompts nobody is there to answer,
and none is needed to do the work:

- **No dev servers.** Never run `npm run dev`, `npm start`, `cogyard serve`,
  `python3 -m http.server` or any other server, even where `pickup-task` or the worktree
  briefing says to start one.
- **No interpreter one-liners.** Never run `python3 -c`, `node -e` or any other inline script.
  Read files with the file tools, and use the project's own scripts and tests.
- **No browser actions.** Never open, drive or screenshot a page in any browser.

Where the task needs something seen, the chat reports what a file says instead (an anchor id, a
hex value, a count, the line it changed), and the manager does every render and visual check
itself, in its own chat, where the pane is already permitted.

Every chat starts before any merge (owner's decision): the merges all wait for the merge point.

**Two shapes, one run.** Tell the owner which shape the run has before it starts — a notice, not
a question; the run goes on:

- **Side by side** — the batch's chats all start at once.
- **Serial** — clashes leave a batch of one, or a queue behind it: say so, and run the queue one
  task at a time, in order, as part of this same run. When a chat reaches its merge point, read
  `cogyard tasks plan --json` again: once its task shows `finished`, start the next queued task
  whose `clash` list is now clear. Every task branches off local main as it stands, so the second
  task does not have the first one's unmerged work; their two branches meet at the merges (§4).
  A run ends when the queue is empty, not after its first batch. A chat that stops on a question
  isn't finished, so the tasks queued behind it wait: go on with anything else that can run, and
  put the question in the merge-point report.

**In a serial chain over one file, the manager assigns the contended slot.** Tasks that each add
to one file often each need "the next" of something the file numbers or names — a section
number, an anchor id, a cache-busting value, a migration number. The next one exists only on
the branch before it, which isn't merged, so no chat can find it. Assigning it is the manager's
job: read the previous task's value from its branch (for the first task in the chain, main's
last value), give this task the next one in its brief ("your section is 17, its anchor is
`s17`"), and list every assignment in the merge-point report. The brief says two more things:
the assigned value wins over the task file's own "the next number" wording, and a count the
task checks ("one more section than before") is counted against main, which has none of the
earlier branches' additions.

**Long chains need the owner partway.** The app stops starting sessions from events after about
nine in a row with no word from the owner. A serial chain longer than that stalls there: say so
before the run starts, and say how far it will get on its own.

## 3. The merge point

**A chat's report is a prompt to measure, never the measurement.** A chat can be wrong about its
own work — the command it ran, whether a check measured the thing at fault, whether its branch
is merged. Nothing a chat reports reaches the owner until the manager has checked it from the
branch, the files or git; what can't be checked is passed on as the chat's claim, labelled so.

When every chat has finished or stopped and the queue is empty, report each task, with what the
manager checked: ready to merge (its branch and what changed), stopped (the question), or not
started (the questions left unanswered). Then every default the manager took and every choice it
made itself — the task-file defaults of §1, the slots of §2 — so the owner can reject any of them
before the merges.

## 4. The merges

If the run merges, wait for the owner to say which ready tasks to merge. Then take them one at a
time; the next one starts only when the one before has passed its after-merge check.

1. **Before the merge, check: did the chat do the task properly?** Read the task file and the
   branch's changes, and run the task's own checks. Every ticked box must match what the branch
   actually did.
2. **The manager merges.** First take the task's claim from its chat, from the main checkout:
   `cogyard env claim <task file> <session-id> --force` (the task's chat reported ready and has
   stopped). The hooks refuse EnterWorktree into a task's worktree, and edits to its task file,
   from any chat but the one holding the claim. Then enter the task's worktree (EnterWorktree with its path) and run
   `merge-to-main` from there, the normal way — steps 1–3 on the branch, then ExitWorktree
   (`keep`) and the rest from the main checkout — without step 9 (push main) and step 10 (close),
   which wait for the end of the run. Step 3 runs: every branch is pushed to origin. Its answers:
   - the rebase in step 1: rebase onto local main, so the merge lands linearly on the one before;
   - the push in step 3: its chat already pushed the branch, so after the rebase it goes up with
     `git push --force-with-lease origin <branch>` — the task's own branch, never main;
   - a conflict: resolve it, unless resolving it needs a decision about what the feature should
     do rather than a code fix. Then stop and ask the owner.
   **Fallback:** when a command of the manager's merge asks for permission, message the task's
   own chat to run `merge-to-main` from its worktree with the same answers and skips, without
   waiting for the owner. When that is refused too, stop the merges and go to the owner.
3. **After the merge, check: was it merged properly, and is main in good shape?** Main is one
   straight line with no merge commit: the task's commits, then its version bump, on top of the
   merge before. Main builds and its tests pass.

A failed check stops the merges and goes to the owner.

**A serial chain over one file conflicts once per merge, by design.** When every task appends to
the end of the same file, each one inserts before the file's closing lines, so every merge after
the first conflicts once, at that tail. The plan won't warn you: once both tasks are `finished`,
neither is in the other's `clash` list. Run `cogyard tasks conflicts <id>` before each merge to
see which files will conflict. It is mechanical, not a decision: keep both insertions,
the one already on main first, and the shared tail once. Before the build, check the resolved
file's **structural balance**: count its units — opening and closing tags of each kind, sections,
headings, navigation entries, whatever the format is made of — and the count after the merge
must equal main's before it plus what the branch added, with every opening matched by its
closing. Only then build.

## 5. The end of the run

After the last merge, close the merged tasks, in the order they merged: for each one, run
`merge-to-main` step 10 against local main as it now stands, holding every merge of the run —
10a runs its `(after merge)` checks, 10b ticks its open `(you: …)` boxes as reviewed (the owner
naming the task for merging at the merge point is their "merge it"), and 10c runs
`cogyard tasks close <id>`. Never ask the owner anything here. A close that refuses leaves that
task OPEN with its claim; the report says, one line per reason, what is left and whose it is.

The final report: each task closed or still open (and why), every branch pushed, and that local
main holds the merges and is not pushed — pushing main is the owner's (`git push origin main`).
Then the rehearsal's worktree and branches, with the commands that remove them.
