---
description: A simple manager for several tasks at once — it sets each task up so its pickup can run all the way to the merge point without questions, starts one chat per task doing the normal pickup-task process, waits at the merge point, then has each task the owner picks merged by its own chat through merge-to-main, one at a time into local main, checking the work before each merge and main after it. Nothing is pushed and nothing is closed. Trigger when the user says "autopilot", "run the backlog", "run these tasks without me", or asks for a multi-task run with no questions mid-run.
---

# autopilot — a manager for chats doing the normal pickup

Autopilot is a manager. It directs the chats and checks their work; it does not do any task's
work and adds no rules about how work is done. Each task is worked by its own chat running
`pickup-task` and then `merge-to-main`, exactly as any chat would. The manager runs in the
project's main checkout.

## 1. Set each task up

Pick the tasks that can run together. From `cogyard tasks plan --json`, a task can run when it is
not in `groups.progress` and its entry under `tasks` has:

- `status` OPEN;
- `unmet` empty — everything in its `depends_on` is finished;
- `youNext` empty, or naming a `(you: decision)` box the owner answers below;
- `claimedByOther` false;
- a `clash` list naming no task in `groups.progress` and no other task in this batch. `clash`
  names each other task it shares a code file (`touches_paths`) or a `resources` name with —
  either may go first, but not both at once. A shared Markdown file isn't in it.

Then ask the owner everything at once, before any chat starts:

1. **Does this run merge?** Yes: the run waits at the merge point for the owner to say which
   tasks to merge. No: the run ends at the merge point.
2. **For each task:** read the task file, `pickup-task` and `merge-to-main`, and ask every
   question they would stop on for that task, plus its open `(you: decision)` boxes before the
   merge point. A task whose entry has `filesUnknown` true lists no files, so its `clash` list
   can't show what it shares: ask whether it may run beside the others. Ask the same for a
   task whose `skippedPaths` isn't empty — whole folders or paths outside the repo, which the
   clash check ignores — naming those entries.

A task whose questions aren't all answered doesn't run. A task that reaches a `(you: credential)`
or `(you: purchase)` box before its merge point doesn't run; an answer can't do those.

## 2. Start the chats

Start one chat per task, all of the batch at once. Each is a session of its own, started fresh in
the project's main checkout, not in a worktree of its own: `pickup-task` makes the task's worktree
from there (step 5), and a chat started inside another worktree stops before claiming. It is not
a helper agent inside the manager's chat, which can't make a worktree.

Its brief: run `pickup-task` for its task from the start, with the owner's answers, and stop at
the merge point. A question nobody asked stops that chat; it reports the question and never
guesses. Everything the manager tells a chat after that goes to it as a message.

A run is one batch: every chat starts before any merge (owner's decision). The next batch is a new
run.

## 3. The merge point

When every chat has finished or stopped, report each task: ready to merge (its branch and what
changed), stopped (the question), or not started (the questions left unanswered).

## 4. The merges

If the run merges, wait for the owner to say which ready tasks to merge. Then take them one at a
time; the next one starts only when the one before has passed its after-merge check.

1. **Before the merge, check: did the chat do the task properly?** Read the task file and the
   branch's changes, and run the task's own checks. Every ticked box must match what the branch
   actually did.
2. **The chat merges.** Message that task's chat to run `merge-to-main` from its worktree, the
   normal way, without step 3 (push the branch), step 9 (push main) or step 10 (close). Its
   answers:
   - the rebase in step 1: rebase onto local main, so the merge lands linearly on the one before;
   - a conflict: resolve it, unless resolving it needs a decision about what the feature should
     do rather than a code fix. Then stop and ask the owner.
3. **After the merge, check: did the chat merge properly, and is main in good shape?** Main is
   one straight line with no merge commit: the task's commits, then its version bump, on top of
   the merge before. Main builds and its tests pass.

A failed check stops the merges and goes to the owner.

Local main then holds the merged tasks. Nothing is pushed, nothing is closed, and every task keeps
its claim.
