---
description: Find the chats that created, implemented, and mentioned a task — durable across archiving + worktree removal — then read a chosen transcript inline.
allowed-tools: Bash, Read, AskUserQuestion
---

# /task-chats — which chats made this task, and read them

Given a task id, list the chats that **created**, **implemented**, and merely
**mentioned** it, then — on request — READ a chosen chat's transcript so you can
answer questions about it or continue the work. The answer is ledger-sourced, so
it survives chat archiving AND worktree removal (the transcript `.jsonl` stays on
disk even after the chat is archived and its worktree culled).

This is the by-task-id lookup — "which chats are about this task" — distinct from
any full-text transcript search.

## Hard rules

- **Read-only. No resume.** The deliverable is FIND + READ a transcript, never
  `claude --resume`. Do not offer to re-enter a session — the owner explicitly
  does not want that.
- **Never touch transcripts** (`~/.claude/projects/`) — only Read them.
- If `$ARGUMENTS` has no task id, ask the user which task. Do not guess.

## Procedure

### 1. Look up the chats (read-only)

Parse the task id from `$ARGUMENTS`. If the user included `--everywhere`, pass it
through (default is the current project).

```bash
cogyard sessions chats <taskId> --json          # add --everywhere to cross projects
```

(If `cogyard` lacks the `sessions chats` command, the installed cogyard is too
old — `cogyard claude install` after updating, then a fresh session.)

The JSON is `{ taskId, project, created, implemented[], mentioned[] }`. Each chat
entry: `sessionId`, `role` (`created` | `claimed` | `committed` | `mentioned`),
`label` (first typed prompt), `startedAt`, `lastActiveAt`, `transcriptPath`
(the durable handle), `archived` (UI flag in the desktop app), `inferred` (true
only for a best-effort git-time `created` guess — present it as uncertain).

### 2. Present the buckets

Show the three buckets plainly, most-useful first:

- **Created** — the chat that authored the task file (`inferred` → say "likely,
  inferred from git timing", not a certainty).
- **Implemented** — claimed or committed the task, strongest first.
- **Mentioned** — touched it without claiming/committing.

Per chat: short id (first 8 of `sessionId`), date (`lastActiveAt`), the label,
and an `[archived]` badge when `archived`. Note that archived chats are still
fully readable — archiving only hides them in the desktop sidebar.

If every bucket is empty, say so — the task has no recorded chats (e.g. authored
by hand, or its transcripts were culled before the ledgers banked it).

### 3. Offer to read one

Ask the user (AskUserQuestion, or honor an explicit pick in `$ARGUMENTS`) which
chat to read, if any. To read the chosen chat, use the **Read** tool on its
`transcriptPath` (it's a `.jsonl` — read the head to orient, then search within
for the parts that matter), or run `bencc show <shortId>` for a rendered view.
Then answer the user's question from the transcript, or continue the work they
point you at. Still no resume — you are reading the record, not re-entering it.
