---
description: Show /cogyard usage (bare) or run a subcommand. Use `/cogyard open` to launch the dashboard.
allowed-tools: Bash
---

Behavior depends on `$ARGUMENTS`:

## Case 1 — No arguments (bare `/cogyard`)

**Do NOT run any Bash.** Print the following cheat sheet directly to the chat as your reply. Format as markdown. Do not paraphrase — these are the exact subcommands the user needs to recognize.

```
/cogyard — the task system: pick up · write · ask.  (Status lives in the portal.)

WHAT YOU ACTUALLY DO
  Pick up a task   say "do task 37" / "pick up task 37" / "work on task 37"
                   → fires the pickup-task skill (sync, claim, drift-check, work, release).
  Write a task     say "file this as a task" / "park this" / "spec this out"
                   → fires the write-task skill (reserves the id, writes the file).
  Ask about tasks  /cogyard how many OPEN tasks I have
                   /cogyard what's claimed right now
                   /cogyard show me blocked tasks in my-project
                   → Claude reads _tasks/INDEX.md + frontmatter directly. No server needed.
  See status       Go to the portal: http://localhost:7437 by default (live Angular UI —
                   the only dashboard), or your own mapped hostname if you set one up.
                   `/cogyard open` opens it. Cross-project view = the portal's "All" tab.

PLUMBING — the skills above call these for you; you rarely type them
  projects list | register | remove <slug>   Registered projects (what the portal sees).
  init                                        One-time setup in a fresh repo.
  next-id <slug>                              Reserve next task id (write-task runs this).
  current                                     JSON of tasks claimed in this repo.
  sync pull | push "<msg>"                    Cross-machine _tasks/ sync (clones share via symlink).
  analyze [--apply] [--all]                   Infer frontmatter for unknown tasks.
  --backfill                                  Walk unknown-frontmatter files in $EDITOR.

FILES
  Script:   cogyard tasks   (data + CLI; no UI)
  Registry: ~/.cogyard/projects.json
  Portal:   <repo>            (server/ + frontend/; the only presentation layer)
  Server:   <repo>/bin/serve  (port 7437, LaunchAgent com.cogyard.serve)
```

After printing this, do nothing else. Wait for the user's next command.

## Case 2 — `$ARGUMENTS` is `open`

Open the live dashboard. The default is the serve process on port 7437; use the user's mapped hostname instead if they've set one up (check for a reverse-proxy convention like `http://cogyard` before assuming):

```bash
open http://localhost:7437
```

If the page fails to load, the serve process isn't running. On macOS with the LaunchAgent installed (`bin/serve` + `com.cogyard.serve`), re-bootstrap it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cogyard.serve.plist
```

(To stop it, rare: `launchctl bootout gui/$(id -u)/com.cogyard.serve`.) Without the LaunchAgent, start the portal manually per the cogyard repo's README (`bin/serve`, or `npm run api` + the dev frontend).

## Case 3 — `$ARGUMENTS` is `--all` (retired)

`--all` is retired — there is no cross-project markdown summary anymore. The cross-project
view is the portal's **"All"** tab. Tell the user to run `/cogyard open` and click **All**.
Do NOT run `cogyard tasks --all` (the flag no longer does anything).

## Case 4 — Any other `$ARGUMENTS`

Forward to `cogyard`. If the args look like a recognized subcommand (`init`, `sync`, `projects`, `next-id`, `current`, `analyze`, `--backfill`, `--help`), run:

```bash
cogyard tasks $ARGUMENTS
```

If the args look like a natural-language question (e.g. "how many tasks", "what's claimed", "show me blocked"), do NOT shell out — instead answer programmatically by reading `_tasks/INDEX.md` and frontmatter files directly, then reply with the answer in chat.

## Notes for Claude

- The dashboard server only sees projects registered via `cogyard tasks init` in each clone. Use `cogyard tasks projects list` to see them.
- For programmatic queries, prefer reading `_tasks/INDEX.md` directly over scraping the HTML.

Arguments passed: $ARGUMENTS
