---
name: merge-to-main
description: |
  Merge the current branch or worktree into main with the versioning process — build on the branch, pull main, merge, bump the root package.json minor version, build ON MAIN, push. Use whenever the user says "merge to main", "merge it", "ship this branch", or approves a merge.

  Works in any project. A project-local skill of the same name overrides this one.
---

# merge-to-main

The two invariants this protects:

1. **Merging onto a stale main** — no pull first, so the merge goes over old commits.
2. **Pushing main without building after the merge** — "it built on the branch" is not evidence main builds.

Versioning is welded to the merge: every merge to main = exactly one **minor** bump of the ROOT `package.json`, so `git log -- package.json` reads as a release ledger and the running app's visible version maps 1:1 to merges.

## Preconditions

- **Resolve the target branch FIRST.** Run `cogyard tasks default-branch` and capture the result as `<base>` (it prints `main` or `master`). If the `cogyard` CLI isn't installed, fall back to `git symbolic-ref --short refs/remotes/origin/HEAD` (strip the `origin/` prefix; if that fails too, check which of `main`/`master` exists). Every step below targets `<base>` — never hardcode `main`. "merge-to-main" is the skill's name, not an assumption about the branch.
- Current branch is NOT `<base>`. If already on it, stop — nothing to merge.
- In a Claude Code worktree (path contains `/.claude/worktrees/`), you cannot `git checkout <base>` — it's checked out in the primary clone. Find it with `git worktree list` (first entry) and run all base-side steps via `git -C <main-checkout>` / building in that directory.
- If the working tree is dirty, stop and resolve with the user first.

## Steps — execute IN ORDER, stop immediately if any step fails

1. **Has `<base>` moved since this branch forked? — check BOTH sides, then ASK.**
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
   4. Now compare the branch against LOCAL `<base>`: `git log --oneline HEAD..<base>`.
   - **Empty** → `<base>` has not moved past this branch; go straight to step 2 (no question needed).
   - **Non-empty** → `<base>` has advanced. STOP and ask the user via the **AskUserQuestion** tool (header "Rebase?", report how many commits ahead `<base>` is), two options:
     - **Rebase onto `<base>` first (Recommended)** — replay this branch on top of the latest `<base>` for a clean linear merge, then build the rebased branch.
     - **Merge from where we are (no rebase)** — leave the branch as-is; step 6's `git merge` will fold in `<base>` as a merge commit.
   Honor the answer. On **Rebase**: `git rebase <base>` (the LOCAL branch — after
   step 1.3 it contains everything origin has PLUS any unpushed local commits),
   one step at a time; on conflict STOP and resolve WITH the user — never
   `git merge <base>` into the branch. On **Merge from here**: proceed unchanged.
   (The user sometimes deliberately wants the no-rebase path — never assume; this
   is why it's a question.)
   **Sanity gate before step 6:** after the rebase, `git -C <main-checkout>
   merge <branch>` must FAST-FORWARD. If git creates a merge commit anyway,
   something was missed — STOP and show the user `git log --graph --oneline -6`
   instead of pushing.
2. **Build on the branch.** Run the project's build (root `npm run build` if the root package.json has one; otherwise the project's documented build command). Zero errors AND zero warnings — if either exist, stop and report.
3. **Push the branch** to origin. Skip silently if the repo has no remote.
4. **Get on `<base>`.** Normal clone: `git checkout <base>`. Worktree: locate the base checkout per Preconditions and use `git -C` for every remaining step.
5. **Pull `<base>`**: `git pull origin <base>` (skip if no remote). NEVER merge without this step — merging over old commits is the exact bug it kills. "Already up to date" here while local `<base>` is AHEAD of origin is NOT confirmation of sync — that state was already surfaced in step 1.2; if step 1.2 was somehow skipped, run it now before merging.
6. **Merge**: `git merge <branch-name>`.
7. **Version bump — minor, ROOT package.json only.** Run `npm version minor --no-git-tag-version` from the REPO ROOT (the version lives in the root `package.json`, NOT a workspace one). Commit: `git commit -am "chore: bump version to $(node -p "require('./package.json').version")"`.
   - Granularity is fixed convention: **minor** = branch/worktree merge (this skill — the only automated bump path for features); **patch** = reserved for direct changes on main outside a branch; **major** = NEVER automated, only on the user's explicit instruction.
   - **Branch already carries a deliberate version change → SKIP the automatic bump.** Before bumping, compare the root version across the merge: `git diff HEAD@{1} HEAD -- package.json` (or compare the branch's version to pre-merge `<base>`). If the merge itself changed the root `version` field, that was a deliberate, user-authorized version set (e.g. a major release cut on the branch) — bumping again would clobber it. Keep the branch's version and note it in the final report.
   - If the project has no root `package.json`, skip this step and say so in the final report.
8. **Build again ON `<base>`.** Mandatory. Even for fast-forward merges, even if step 2 just passed. Zero errors AND zero warnings, or stop and report. **NEVER push `<base>` before this passes.**
9. **Push `<base>`**: `git push origin <base>` (skip if no remote).
10. **Close the merged cogyard task (cogyard-managed repos only).** A task is
    DONE only when MERGED — claims persist through review, so this step, not
    session end, is where the claim comes off. If the repo has a `_tasks/`
    dir/symlink and the merged branch maps to a task (branch/worktree named
    `task-NNN-*`, or `cogyard tasks current` lists it):
    - All Scope boxes ticked → the merge is the sign-off: set frontmatter
      `status: DONE` + `done_date: <today>`, then
      `cogyard env release <task-file>` and
      `cogyard tasks sync push "close NNN — merged to <base> (v<version>)"`.
    - Unticked boxes remain → ask the user: keep OPEN + keep the claim (more
      work coming on this task), or close it and park the leftovers per the
      pickup-task end-of-session options.
    Skip silently when the repo isn't cogyard-managed or no task maps.
11. **Reclaim the merged worktree's `node_modules` (optional cleanup).** Only when this session ran in a Claude Code worktree (cwd contains `/.claude/worktrees/`) AND `<worktree>/node_modules` exists. Worktrees share the parent repo's git objects, so `node_modules` is the only heavy thing left once the work is merged; the worktree dir and branch stay (chat-archiving removes worktrees, not this). **Ask via the `AskUserQuestion` TOOL — mandatory, not prose.** Measure the size first (`du -sh <worktree>/node_modules`), then call AskUserQuestion (header "Reclaim", one question: "Reclaim ~N MB from `<worktree>/node_modules`?"), two options:
    - **Yes, delete it (Recommended)** — "`rm -rf <worktree>/node_modules`. The worktree and branch stay; re-`npm install` if you revisit."
    - **Keep it** — "Leave node_modules in place — instant rebuilds if you reopen this worktree soon."
    Do NOT fold this question into the final report as a prose sentence and end the turn. Run the `rm -rf` only on an explicit **Yes** answer. Skip the question entirely (silently) when not in a worktree or no `node_modules` is present. NEVER touch the base checkout's `node_modules` (the merge built from it; on `<base>` it may feed a long-running server). Regenerable: a later build fails fast with a clear missing-deps error, the accepted signal to reinstall.

## Report

Version before → after, the merge commit, both build results, whether a cogyard task was closed (DONE + released) or kept open, whether the worktree's `node_modules` was reclaimed (and how much), and anything skipped (no remote, no root package.json). If any step failed: which step, the exact error, and that the sequence was halted there.
