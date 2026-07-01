# Tunnels — expose a worktree's dev server at a stable public hostname

`cli/tunnel.mjs` makes any registered cogyard project **tunnel-enabled**: its
*current* worktree's dev server is reachable at a fixed Cloudflare hostname
(e.g. `https://dev.example.com`), and the tunnel **follows whichever worktree
you're working in**.

## Why this is non-trivial

cogyard assigns a **unique dynamic port per worktree** (task 042) so parallel
worktrees never collide on a port. But a Cloudflare tunnel needs **one stable
target**. The reconciliation is `tunnel here`: it rewrites the tunnel's ingress
to the *active* worktree's port on demand. One tunnel + one hostname per project,
repointed as you switch worktrees.

## Flow

```
# one-time, interactive, you do this yourself:
cloudflared tunnel login                       # writes ~/.cloudflared/cert.pem

# one-time per project (run from inside the project / an active worktree):
node ~/gitroot/cogyard/cli/tunnel.mjs enable <project> <hostname>
#   <project>  = a cogyard registry slug, a repo path, or "."
#   <hostname> = the public name, e.g. dev.example.com
# → creates a NAMED tunnel, routes DNS, writes the LaunchAgent + .tunnel marker +
#   registry entry, then points the tunnel at the current worktree's port.

# every time you switch to a different worktree:
node ~/gitroot/cogyard/cli/tunnel.mjs here
# → same hostname, now reaching the new worktree's port. (Auto-run by the
#   SessionStart hook for tunnel-enabled projects — see "Worktree follow".)

node ~/gitroot/cogyard/cli/tunnel.mjs status   # where it points, is it up, does it answer
node ~/gitroot/cogyard/cli/tunnel.mjs list     # all tunnel-enabled projects
node ~/gitroot/cogyard/cli/tunnel.mjs disable  # stop serving (keep config)
node ~/gitroot/cogyard/cli/tunnel.mjs disable --delete   # full teardown
```

### Options

- `enable … --name <n>` — tunnel/LaunchAgent name (default: project label, lowercased, alnum only).
- `enable … --side backend` / `here --side backend` — point at the backend port instead of frontend.
- `enable … --no-follow` — don't auto-repoint on worktree SessionStart.

## What `enable` creates

| Artifact | Path | Purpose |
|---|---|---|
| Named tunnel | (Cloudflare) | `cloudflared tunnel create <name>` |
| Credentials | `~/.cloudflared/<tunnel-id>.json` | written by cloudflared |
| Local config | `~/.cloudflared/<name>.yml` | `tunnel:` + `credentials-file:` + `ingress:` (rewritten by `here`) |
| LaunchAgent | `~/Library/LaunchAgents/com.<owner>.cloudflared.<name>.plist` | runs `cloudflared tunnel --config <name>.yml run` |
| Repo marker | `<repo>/.tunnel` | shell-sourceable `name=`/`tunnel_id=`/`hostname=`/`side=` |
| Registry | `~/.cogyard/tunnels.json` | keyed by project slug; source of truth for `list` + worktree follow |

## Worktree follow (automatic)

The SessionStart hook (`hooks/worktree-session.mjs`) checks `~/.cogyard/tunnels.json`:
if the worktree's project is tunnel-enabled with `follow_worktrees` on, it runs
`tunnel here` in the new worktree automatically — best-effort, never blocks the
session. So the stable hostname tracks whichever worktree you spawn.

Worktrees created **mid-session** via the EnterWorktree tool don't re-fire
SessionStart — run `tunnel here` manually in those (or the next session start
picks it up).

## The `.tunnel` marker

```
name=myproject
tunnel_id=<tunnel-id>
hostname=dev.example.com
side=frontend
```

Sourceable by shell (`source .tunnel`) — the original prototype `tunnel-here.sh`
read exactly these keys. `tunnel here` prefers this marker; if it's absent (e.g.
the marker isn't committed and you're in a fresh worktree) it falls back to the
registry, resolving the project root from the worktree path.

## Gotchas (each cost real time to discover — encoded in the code)

1. **Use LOCAL-CONFIG mode, not `--token` / dashboard mode.** A token-mode
   tunnel pulls its ingress from the Cloudflare dashboard and **ignores the
   local config**, so it can't be scripted to follow worktrees. We always write
   a `config.yml` with `tunnel:` + `credentials-file:` + `ingress:`.
2. **macOS `localhost` resolves to `::1` (IPv6) first.** Dev servers usually
   bind IPv4 only, so a tunnel pointed at `localhost` silently **404s at the
   edge**. The ingress `service:` URL uses `http://127.0.0.1:<port>`.
3. **`cloudflared service install` owns exactly ONE daemon** (a fixed plist
   label) and collides on a second project. We use **per-project LaunchAgents**
   with a unique `Label` (`com.<owner>.cloudflared.<name>`), loaded via
   `launchctl bootstrap gui/$uid <plist>`.
4. **A stray default `~/.cloudflared/config.yml` hijacks any bare
   `cloudflared tunnel run`.** The LaunchAgent always passes an explicit
   `--config <name>.yml`.
5. **Unique dynamic worktree ports vs. one stable target** — the core tension.
   Resolved by `tunnel here` rewriting ingress to the active worktree's port.
   One tunnel/hostname per project, repointed on demand.
6. **`cloudflared tunnel route dns` fails ("record exists")** if a stale CNAME
   points at an old/deleted tunnel. We pass `--overwrite-dns`.

## Teardown

- `tunnel disable` — boots out the LaunchAgent (stops serving). Config, tunnel,
  DNS and registry entry are kept; `tunnel here` resumes.
- `tunnel disable --delete` — boots out the agent, deletes the cloudflared tunnel
  + credentials, removes the plist, the local config, and the registry entry, and
  removes the repo `.tunnel` marker. **The DNS CNAME is NOT removed by
  cloudflared** — delete it in the Cloudflare dashboard if you won't reuse the name.

## Prereqs

- `cloudflared` installed (`/opt/homebrew/bin/cloudflared`) and logged in
  (`cloudflared tunnel login` → `~/.cloudflared/cert.pem`).
- The hostname's zone must be in the same Cloudflare account you logged in with.

## Current deployments

Real owner-machine deployments (specific Cloudflare account, hostnames, tunnel
IDs, LaunchAgent labels) are **personal** and kept out of the public tree — see
`docs/DEPLOYMENTS.local.md` (gitignored). They eventually live in the private
`cogyard-local` layer (task 024 phase 2 / task 32).

A registered deployment looks like:

| Project | Hostname | Config | Mode | LaunchAgent |
|---|---|---|---|---|
| `myproject` | `dev.example.com` | `~/.cloudflared/myproject.yml` | local-config (tunnel + creds-file + ingress) | `com.<owner>.cloudflared.myproject` |

Prefer **local-config mode** over token/dashboard mode (gotcha 1), and
`127.0.0.1` over `localhost` in the ingress `service:` URL (gotcha 2).
