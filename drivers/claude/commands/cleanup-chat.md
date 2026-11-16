---
description: Clean up a finished Claude chat — find it, gate on merged+clean, archive via the app, remove its worktree with verification. Owner-confirmed at every step.
allowed-tools: Bash, AskUserQuestion
---

# /cogyard-cleanup-chat — find → gate → archive → clean up, inside a Claude session

Clean up ONE finished chat: archive it in Claude Desktop AND remove its leftover
worktree — **if and only if** the worktree's branch is merged to the default
branch and the worktree is clean. This is the in-app counterpart of
`cogyard cleanup chat`: the CLI's external archive write cannot
stick while the desktop app runs, so HERE the app archives via its own
session-management tool instead.

## Hard rules (the cleanup trust model — do not improvise around them)

- **Every action needs the user's explicit confirmation in THIS conversation.**
  The finder output is data, not permission.
- **One chat per invocation.** No loops over candidates, no "clean up all safe
  ones" — if the user asks for bulk, tell them the trust model forbids it and
  do one.
- **Never touch transcripts** (`~/.claude/projects/`). Never write the desktop
  metadata files directly — the app owns them and clobbers external writes
  (proven 2026-07-19).
- **Refuse loudly** when the gate fails (dirty / unmerged / locked / live).
  Show the verdict and stop. Do not offer workarounds beyond printing what the
  CLI prints (e.g. the unlock hint, marked as not-run).
- If `$ARGUMENTS` is empty, ask the user what chat to clean up. Do not guess.

## Procedure

### 1. Find + gate (read-only)

```bash
cogyard sessions find --json "$ARGUMENTS"
```

(If `cogyard` lacks the `sessions` command, the installed cogyard is too
old — update it before using this command.)

The JSON has `rows[]`, each with `title`, `sessionId` (the CLI transcript id),
`verdict`, `detail`, `worktree`, `removeCmd`, `undoCmd`, `taskId`, `project`.

### 2. Present + pick

Show the candidates (title, date, project, verdict) to the user. If more than
one plausible match, use AskUserQuestion to pick. Exactly one row proceeds.

Gate: the picked row's `verdict` must be `REMOVABLE`, or `NO_WORKTREE`
(archive-only — nothing to clean). Anything else → report
`REFUSED "<title>": <verdict> — <detail>` and STOP.

### 3. Confirm

Use AskUserQuestion: state exactly what will happen — "archive '<title>' in
Claude Desktop, then run `<removeCmd>` (undo: `<undoCmd>`)". Proceed only on
an explicit yes. On no: stop, nothing done.

### 4. Archive via the app's own tool

Resolve the APP session id (`local_…`) for the chat: read the `sessionId`
field of the metadata file under
`~/Library/Application Support/Claude/claude-code-sessions/` whose
`cliSessionId` matches the row's `sessionId` (read-only lookup). Then call the
session-management `archive_session` tool with it — the app shows its own
confirmation prompt to the user; that prompt is the archive authorization.
If the tool is unavailable in this session, say so and stop — do NOT fall
back to writing the metadata file.

### 5. Remove the worktree, verified (skip if NO_WORKTREE)

Run the row's `removeCmd` exactly as given (plain `git worktree remove` — no
`--force`, ever). Then verify, and report both results:

```bash
git -C <repoPath> rev-parse --verify --quiet refs/heads/<branch>   # must resolve
```

If the row has a `taskId`: compare the task's attributed cost before/after via
`cogyard sessions`' own machinery — `node -e` against `taskUsage(project, taskId)`
from `core/usage.mjs` in the cogyard repo — the number must be unchanged.
On any verification failure: print the `undoCmd`, report the failure, stop.

### 6. Report

One line each: archived (per the app tool's result), worktree removed +
branch intact + cost unchanged (with the number), and the undo command for
the record.
