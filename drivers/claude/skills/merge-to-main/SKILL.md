---
description: |
  Merge the current branch or worktree into main — rebase onto main and bump the version as the project's switches say (`cogyard tasks switches`), build on the branch, pull main, merge, build ON MAIN, push. Use whenever the user says "merge to main", "merge it", "ship this branch", or approves a merge.

  Works in any project. A project with its own merge process turns this skill off for the project and names its own skill differently (see the skill's first paragraph).
---

# merge-to-main

**A project with its own version of this skill** turns this one off in its `.claude/settings.json` (`"skillOverrides": { "cogyard-merge-to-main": "off" }` — its personal name, so a project skill named `merge-to-main` stays on) and gives its own a different name, with `Replaces cogyard's merge-to-main. Last reconciled against it: <date>.` at the top. A project skill that is merely also named `merge-to-main` does not replace this one: this one is `cogyard-merge-to-main` installed with `cogyard claude install` and `cogyard:merge-to-main` under the plugin, so both load and nothing says which applies. `cogyard onboard` sets this up when it finds a project's own process, and `cogyard tasks doctor` flags one that runs beside this one or is out of date. See `drivers/claude/README.md`, "Skipping or replacing a skill in one project".

The three invariants this protects:

1. **Merging onto a stale main** — no pull first, so the merge goes over old commits.
2. **Pushing main without building after the merge** — "it built on the branch" is not evidence main builds.
3. **Merging onto the wrong branch** — a branch value read earlier in the session is not evidence of the branch now. One checkout can be shared by several sessions, and its branch is a single file that any of them can rewrite between your reading it and your merging.

**A step that names a command IS that command.** Concluding that its effect already holds does not discharge it. Every command below is run, in order, even when it looks redundant — the case where it is redundant costs nothing, and the case where the world moved underneath you is exactly the one it catches.

**Two steps follow the project's switches**, read once with `cogyard tasks switches --json` (run from the repo or worktree; it prints `{ rebase: { value, set }, version: { value, set, file } }`, `set: false` meaning the value is the default). Step 1 reads `rebase`, step 7 reads `version`. Never decide either yourself. If the `cogyard` CLI isn't installed, use `rebase` = `ask`, and `version` = `minor` with `file` = `package.json` when the repo root has a `package.json`, else `off`.

## Preconditions

- **Resolve the target branch FIRST.** Run `cogyard tasks default-branch` and capture the result as `<base>` (it prints `main` or `master`). If the `cogyard` CLI isn't installed, fall back to `git symbolic-ref --short refs/remotes/origin/HEAD` (strip the `origin/` prefix; if that fails too, check which of `main`/`master` exists). Every step below targets `<base>` — never hardcode `main`. "merge-to-main" is the skill's name, not an assumption about the branch.
- Current branch is NOT `<base>`. If already on it, stop — nothing to merge.
- **In a worktree you cannot `git checkout <base>`** — it is checked out in the main checkout (the first entry of `git worktree list`). How the base-side steps (4 onwards) reach it depends on the kind of worktree:
  - **A Claude Code worktree** (path contains `/.claude/worktrees/`): steps 1–3 run in the worktree, on the branch. Then leave it with the **ExitWorktree** tool (`action: "keep"` — the worktree and branch stay on disk) and run steps 4 onwards in the main checkout exactly as a normal clone does. This is the normal route, not a fallback: Claude Code's worktree sandbox refuses `git -C <main-checkout>` from inside a worktree, every time. Do not improvise another way around it, and do not abandon the merge half-done.
  - **Any other worktree:** stay in it and run every base-side step via `git -C <main-checkout>`, building in that directory.
- If the working tree is dirty, stop and resolve with the user first.
- **The task's file is written properly (cogyard-managed repos).** When the
  branch maps to a cogyard task (as in step 10), run `cogyard tasks validate
  <id>` from the repo before anything else. It checks that one task file —
  frontmatter, and every checkbox marker: a retired word like `(deferred)`, a
  misspelt `(dropepd: …)`, `(moved: <id>)` to a task that doesn't exist,
  `(dropped)` with no reason, a note inside `(you: …)`. Exit 1 → do not merge.
  Each error says what to write instead. Fix what is mechanical yourself (a
  typo, a note moved out of the marker), commit the task file with
  `cogyard tasks sync push "<msg>" -- <task file>`, and run it again. When
  the fix decides what a box becomes — `(optional)`, `(moved: <id>)` or
  `(dropped: why)` — that is the user's decision: stop, list each one with
  its box text, and ask. `cogyard tasks close` (step 10c) refuses on the same
  errors, so a file left like this would merge and then not close.
- **The task's file list matches what the branch changed (cogyard-managed
  repos).** Autopilot decides which tasks may run at the same time from each
  task's `touches_paths`, so the list must end up true. Run `cogyard tasks
  touches <id> --check` from the branch. Exit 1 lists the files the branch
  changed that the list doesn't name (Markdown left out): add them all with
  the `cogyard tasks touches <id> --add …` line it prints. That commits the
  task file, and the merge goes on: another task in progress listing the same
  file is not a reason to stop. A real conflict with `<base>` is step 1's
  rebase to resolve.

## Steps — execute IN ORDER, stop immediately if any step fails

1. **Has `<base>` moved since this branch forked? — check BOTH sides, then rebase as the `rebase` switch says.**
   The rebase target is the LOCAL `<base>` branch — never `origin/<base>` directly.
   Local `<base>` can be AHEAD of origin (a direct-on-main commit never pushed);
   rebasing onto `origin/<base>` in that state still produces a merge bubble at
   step 6, which is exactly what the rebase was chosen to avoid (a real failure
   mode: an unpushed docs commit sitting on main → surprise merge bubble).
   1. `git fetch origin <base>` (skip if no remote).
   2. **Unpushed-commits check:** `git log --oneline origin/<base>..<base>` (skip
      if no remote). Non-empty → local `<base>` carries commits origin lacks.
      Do NOT silently push someone else's direct-on-main work as a side effect
      of this merge — REPORT the commits to the user ("local <base> is N
      commits ahead of origin: <subjects> — they will ride along with this
      merge's push") before continuing.
   3. **Behind check:** if `git log --oneline <base>..origin/<base>` is non-empty,
      fast-forward local `<base>` first (`git -C <main-checkout> pull origin <base>`
      — pull step 5 early; it must be a clean ff, else stop and resolve with the user).
      In a Claude Code worktree that command is refused, so instead: when step 1.2
      found local `<base>` NOT ahead of origin, rebase in 1.4 onto `origin/<base>`
      (it then holds everything local `<base>` has, so this is the same target), and
      step 5's pull fast-forwards local `<base>` to it after you leave the worktree.
      Local `<base>` both ahead and behind is not a clean ff: stop and resolve with
      the user.
   4. Now compare the branch against LOCAL `<base>`: `git log --oneline HEAD..<base>`.
   - **Empty** → `<base>` has not moved past this branch; go straight to step 2 (no question needed).
   - **Non-empty** → `<base>` has advanced. Read `rebase.value` from the switches:
     - **`always`** → rebase without asking, and say so in the report ("`<base>` was N commits ahead; rebased onto it").
     - **`ask`** → STOP and ask the user via the **AskUserQuestion** tool (header "Rebase?", report how many commits ahead `<base>` is), two options:
       - **Rebase onto `<base>` first (Recommended)** — replay this branch on top of the latest `<base>` for a clean linear merge, then build the rebased branch.
       - **Merge from where we are (no rebase)** — leave the branch as-is; step 6's `git merge` will fold in `<base>` as a merge commit.
     - The user's own words win over the switch either way ("merge it without rebasing" → no rebase).
   To rebase: `git rebase <base>` (the LOCAL branch — after
   step 1.3 it contains everything origin has PLUS any unpushed local commits),
   one step at a time; on conflict STOP and resolve WITH the user, whatever the
   switch says — never `git merge <base>` into the branch. No rebase: proceed
   unchanged.
   **Sanity gate before step 6:** after the rebase, step 6's merge must
   FAST-FORWARD. If git creates a merge commit anyway,
   something was missed — STOP and show the user `git log --graph --oneline -6`
   instead of pushing.
2. **Build on the branch.** Run the project's build (root `npm run build` if the root package.json has one; otherwise the project's documented build command). Zero errors AND zero warnings — if either exist, stop and report.
3. **Push the branch** to origin. Skip silently if the repo has no remote. When the branch was already on origin and step 1 rebased it, a plain push is refused (the rebase rewrote commits origin has): push it with `git push --force-with-lease origin <branch>`, which refuses if anyone else pushed to it since. Only ever the task's own branch — never `<base>`.
4. **Get on `<base>` — run the checkout, do not conclude it.** From a Claude Code worktree, first leave it with **ExitWorktree** (`action: "keep"`, per Preconditions); you are then in the main checkout and everything from here is the normal-clone route. Normal clone (or main checkout): run `git checkout <base>`. Run it even when the branch was just read as `<base>`; it is idempotent, so running it is never wrong, and a stale read is precisely when it matters. Any other worktree: locate the base checkout per Preconditions and use `git -C` for every remaining step.
5. **Pull `<base>`**: `git pull origin <base>` (skip if no remote). NEVER merge without this step — merging over old commits is the exact bug it kills. "Already up to date" here while local `<base>` is AHEAD of origin is NOT confirmation of sync — that state was already surfaced in step 1.2; if step 1.2 was somehow skipped, run it now before merging.
6. **Merge, with the branch check in the same command.** The check and the merge must be one shell command, so that nothing can move the checkout between them:

   ```
   [ "$(git branch --show-current)" = "<base>" ] && git merge <branch-name>
   ```

   From a worktree that isn't a Claude Code one, the same shape with `git -C <main-checkout>` on both halves (a literal, unquoted path — no shell variable). Run it exactly as written: no `2>&1 | tail`, no extra flags such as `--no-ff` or `-m`, nothing chained before or after it. A permission guard can then recognise this one form as the skill's own merge and let it through without asking; any variation looks like a hand-typed merge and gets the question. Reading the branch in an earlier step does not substitute for this — that reading is what step 4 already re-asserted, and this is what proves it still holds at the instant of the merge. If the check fails, the command merges nothing: stop and find out what moved the checkout.
7. **Version bump — as the `version` switch says.** Everything here runs on `<base>`, from the REPO ROOT — the main checkout, where a Claude Code worktree session now is after step 4 (from any other worktree: `git -C <main-checkout>` / that directory).
   - **The merge already changed the version → skip the bump.** (Not when `version.value` is `off`: there is no file to check.) `version.file` is the file that holds the version. Check it across the merge: `git diff HEAD@{1} HEAD -- <version.file>`. If the merge itself changed the version in it, that was a deliberate version set on the branch, and bumping again would clobber it. Keep it and say so in the report.
   - Otherwise, by `version.value`:
     - **`off`** → no bump. The report says "versioning is off for this project".
     - **`minor`** or **`patch`** → `npm version <value> --no-git-tag-version` (the root `package.json`, not a workspace one), then `git commit -am "chore: bump version to $(node -p "require('./package.json').version")"`.
     - **`{ command, file }`** (the project's own command) → run `command` exactly as written, then `git commit -am "chore: bump version (<command>)"`. Read the new version from `git show HEAD -- <file>` for the report.
   - The report gives the switch's value and, when `version.set` is false, that it is the default.
8. **Build again ON `<base>`.** Mandatory. Even for fast-forward merges, even if step 2 just passed. Zero errors AND zero warnings, or stop and report. **NEVER push `<base>` before this passes.**
9. **Push `<base>`**: `git push origin <base>` (skip if no remote).
10. **Close the merged cogyard task (cogyard-managed repos only).** A task is
    DONE only when MERGED — claims persist through review, so this step, not
    session end, is where the claim comes off. If the repo has a task directory
    dir/symlink and the merged branch maps to a task (branch/worktree named
    `task-NNN-*`, or `cogyard tasks current` lists it), close it in two parts.

    **The claim must be this chat's before any edit here.** When this merge
    runs from a chat that isn't the one holding the task's claim (`cogyard
    env where <task file>` shows another `session`), take it over first:
    `cogyard env claim <task file> <session-id> --force` from the main
    checkout. The edit hook refuses changes to a task file another chat has
    claimed, so 10a and 10b would be refused.

    **10a. First run the checks that waited on the merge — they are your work,
    not a question.** Read the task file (`cogyard tasks find <id>`). Every open
    box marked `(after merge)` is a check you can only run now that the code is
    on main; so is any other open box that is plainly your own work and was
    waiting on the merge (older tasks don't carry the marker). Before running
    them, make main's code live where the check needs it (a project whose
    `CLAUDE.md` says to reload or redeploy after a merge: do that first). Run
    each check against the merged code, then tick its box with what you saw
    (times, states, output), and commit the task file with `cogyard tasks sync
    push "<msg>" -- <task file>`. Do not ask the user for a "go", do not stop
    to report between checks, and never ask the user to close, restart or
    archive their own chat to make a check pass: find a way you can observe it
    yourself, such as feeding the event through the hook. Never tick a box you
    didn't run, and leave a check of yours open only if you ran it and it
    failed.

    **10b. The user's "merge it" is their review: tick their boxes.** The user
    looks at the work before saying "merge it" — on their phone, in the
    browser, in the worktree's portal. Saying it IS their review and their
    sign-off. So every open owner box `(you: …)` in the task (look at it,
    try it on the phone, live with it, confirm it, choose) is now done: tick
    each one and add, on the line below it, `- Owner reviewed it and said
    "merge it", YYYY-MM-DD.` Commit the task file with `cogyard tasks sync
    push "<msg>" -- <task file>`, and list those boxes in the report. Do this
    only on the user's own "merge it" for this branch, never on a merge
    nobody asked for (the autopilot keeps its own rule).

    **10c. Then close:**

    ```
    cogyard tasks close <id>
    ```

    The command does all three steps — `status: DONE` + today's `done_date`,
    `env release`, and the store commit — so never hand-edit the frontmatter
    or run `env release` / `sync push` yourself here. It closes only when every
    box is ticked or settled (`(dropped: why)`, `(moved: <id>)`, `~~struck~~`),
    the branch is merged, and the claim is the user's. An `(optional)` box is a
    leftover: it blocks DONE, and only the user's ENOUGH closes the task. A
    badly written checkbox marker blocks DONE and ENOUGH alike — the
    preconditions' `cogyard tasks validate <id>` exists to catch it before
    the merge. Otherwise it changes nothing, exits 1, and lists why.
    - **A refusal listing "check(s) waiting on the merge" means 10a isn't
      finished.** Go back and run them.
    - **Any other refusal** (a check of yours that failed, an open box that is
      your own unfinished work, someone else's claim): **ask nothing.** The
      task stays OPEN with its claim. Say in the report, one line per reason,
      what is left and whose it is, with what each failed check showed. Never
      offer ENOUGH or DONE-anyway, as a question or in prose: ENOUGH is for a
      task the user deliberately leaves half done, and only the user decides
      that, in their own words.
    - **Never settle a box for the user.** Marking an open box `(dropped: …)`,
      `(moved: …)` or `(optional)` so that a `close` goes
      through is the user's decision, made in their words, never a reason you
      write in their name. (Ticking owner boxes in 10b is not settling: the
      user's "merge it" did them.)
    - **ENOUGH and DONE-anyway run on the user's own words.** When the user's
      message in this chat says so — "close it as enough" for ENOUGH, "close
      it as done" for DONE-anyway (the word "enough" or "done" is required; a
      bare "close it" or "merge it" is neither) — telling you counts as running
      it themself. Run it with their exact words:
      `cogyard tasks close <id> --enough --asked "<their words>"` (or
      `--force`). The CLI checks the words against what the user typed in this
      chat, records them in the commit, and refuses a paraphrase or anything
      you wrote; on that refusal, hand them the command it prints.
    - **A wrong close is undone with `cogyard tasks reopen <id> --why "…"`**,
      which you may run. Never hand-edit `status:` or `done_date:`, and never
      run git inside the task store (`revert`, `commit`, `reset`): hooks refuse
      both, and the store's history is the record of what happened.
    Skip silently when the repo isn't cogyard-managed or no task maps.
11. **Stop the merged worktree's dev server.** Only when the merged branch was worked in a Claude Code worktree (a path containing `/.claude/worktrees/` — the one this session left at step 4, or the branch's entry in `git worktree list`). A worktree's server is left running until the merge so the owner can look at the work; once merged it has nothing left to show. If one is running for this worktree — a `preview_list` entry, or a listener on the worktree's frontend port (`cogyard env detect`, then `cogyard env port-owner <port>` with `matches: true`) — stop it with `preview_stop`, or kill that one PID. Never `pkill` / `killall`: the main checkout's portal runs the same command line. Nothing running → skip silently. Never stop a server belonging to another worktree or the main checkout.
12. **Delete the merged worktree's `node_modules` — no question.** Only when the merged branch was worked in a Claude Code worktree (as in step 11) AND `<worktree>/node_modules` exists. Worktrees share the parent repo's git objects, so `node_modules` is the only heavy thing left once the work is merged; the worktree dir and branch stay (chat-archiving removes worktrees, not this). Measure it (`du -sh <worktree>/node_modules`), delete it (`rm -rf <worktree>/node_modules`, run on its own), and put the size freed in the report. NEVER touch the base checkout's `node_modules` (the merge built from it; on `<base>` it may feed a long-running server). Regenerable: `npm install` restores it if the worktree is reopened.

## Report

Whether the branch was rebased (and whether the switch or the user decided), version before → after with the `version` switch's value (or that versioning is off, or that the merge set the version itself), the merge commit, both build results, each check step 10a ran with what it showed, the owner boxes step 10b ticked, and whether the cogyard task closed as DONE — or, if `close` refused, that it stays OPEN and what is left, one line per reason, with whose it is. Then whether the worktree's dev server was stopped, the size of `node_modules` deleted, and anything skipped (no remote). If any step failed: which step, the exact error, and that the sequence was halted there. The report asks the user nothing.
