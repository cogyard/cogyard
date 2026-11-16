# Chat archive — an add-on

Once a day, copies every agent conversation and chat record into
`~/.cogyard/chat-archive/` (or `$COGYARD_HOME/chat-archive/`). It **adds and
updates, never deletes**: when the agent removes a chat, the copy stays.

Why: an agent's chats live only in its own folders on this machine. Claude Code
deletes conversations older than its `cleanupPeriodDays` setting (30 days by
default), and a reset setting or a new machine brings that back. Time Machine
helps, but it thins old backups, so a file deleted long ago ages out of it too.

No agent call, no network, no cost. It reads the agent's folders and never
writes inside them.

Not core. cogyard works without it.

## What it copies

The active driver says where its stores are, so nothing here names an agent's
folder. With the Claude Code driver:

| Store | Source | Copied to |
|---|---|---|
| Conversations | `~/.claude/projects/` (`transcripts.root()`) | `chat-archive/conversations/` |
| Chat records (titles, folders, archived flag) | `~/Library/Application Support/Claude/claude-code-sessions/` (`sessions.root()`) | `chat-archive/chat-records/` |

Every file in both folders is copied, at the same relative path and with the
same modification time: conversations, helper-agent logs
(`<session>/subagents/`), tool outputs, and whatever else the agent keeps there.
Symlinks are skipped.

Each run copies only files whose size or modification time changed. A file the
source has **shrunk** (rewritten rather than added to) does not overwrite the
copy: the old copy is first renamed `<file>.kept-<YYYYMMDDTHHMMSSZ>`.

Two more files sit beside the copies:

- **`manifest.json`** — one entry per copied file: size, mtime, sha256,
  `firstSeen`, `lastSeen`, `copiedAt`, and `goneFromSource` — the moment the
  job first noticed the agent had deleted the original. A previous version kept
  on shrink has `keptFrom` naming the file it came from.
- **`heartbeat.md`** — what the last run did, in the heartbeat format from
  `docs/ADDONS.md`, written every run including the quiet ones. Outcome
  `written` (copied something), `unchanged` (nothing new), or `failed`.

Off-machine backup is not part of this add-on. Back up `~/.cogyard/chat-archive/`
like any other folder.

## Install

Symlink is the recommended install — the add-on then tracks the checkout, and
its `import` of the engine resolves to that same checkout:

```bash
ln -s ~/gitroot/cogyard/extras/addons/chat-archive ~/.cogyard/addons/chat-archive
```

Then restart the portal (manifests load once per process):

```bash
launchctl bootout gui/$(id -u)/com.cogyard.serve
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cogyard.serve.plist
```

It appears under **Scheduled jobs** on `/settings`, runs daily at 04:40 (or on
the next wake), and **Run now** fires it straight away. The first run copies
everything — a few GB — and takes a minute or two; later runs copy only what
changed.

## Verify

Compare file counts between each source and its copy:

```bash
find ~/.claude/projects -type f | wc -l
```

```bash
find ~/.cogyard/chat-archive/conversations -type f ! -name '*.kept-*' | wc -l
```

The second number is the first plus any files the agent has since deleted.
`heartbeat.md` says when it last looked and what it found.

## Restore

The copies are plain files at their original relative paths, with their
original modification times. To restore one conversation:

```bash
cp -p ~/.cogyard/chat-archive/conversations/<folder>/<session-id>.jsonl ~/.claude/projects/<folder>/
```

Find a session by id with `grep '<session-id>' ~/.cogyard/chat-archive/manifest.json`.
Restoring a chat into Claude Desktop's sidebar is not supported.
