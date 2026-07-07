# Deploying cogyard

cogyard is a single Node process that serves the built Angular SPA **and** the
`/api` on one origin. There is no separate web server to run and no database.
This doc covers running it for real (beyond `npm run api` + `ng serve` in dev).

## The one moving part

`server/index.mjs` reads `PORT` (default `7440`), serves `/api/*` from `core/`,
and serves everything else from `frontend/dist/frontend/browser` with SPA
fallback. So the entire production story is:

```bash
npm run build            # build the SPA — dist/ is gitignored, so this is required
PORT=7437 node server/index.mjs
```

Open `http://localhost:7437/` and you have the whole portal. `/api/health`
returns the running build's commit SHA so you can confirm what's deployed.

> **Rebuild after every frontend change.** `frontend/dist/` is gitignored and
> served from disk — an old build keeps serving until you rebuild.

## Keeping it running (process manager)

Use whatever your OS provides; the job is just "run `bin/serve` at login and
keep it alive."

- **macOS (reference setup):** a LaunchAgent runs [`bin/serve`](../bin/serve),
  which resolves Node via nvm, runs `npm run build`, then execs
  `PORT=7437 node server/index.mjs`. Reload it after a deploy with:
  ```bash
  launchctl bootout  gui/$(id -u)/<agent-label>
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<agent-label>.plist
  ```
  The reference plist in `bin/` carries a personal label and is treated as
  private/example config — see "Reverse proxy & the personal layer" below.
- **Linux:** a `systemd` user service (or `pm2`) running `bin/serve` is the
  equivalent.

## Optional: a nice hostname (reverse proxy)

The self-serve URL is `http://localhost:7437`. If you want a clean hostname like
`http://cogyard` (or to terminate TLS — see the next section), put a reverse
proxy in front. An example Caddy config ships as
[`Caddyfile.example`](../Caddyfile.example):

```
cogyard {
	reverse_proxy localhost:7437
}
```

Caddy is **not required** — it is purely a hostname/TLS convenience. The app is
fully functional on `localhost:7437` without it. A typical setup runs a
local Caddy mapping `http://cogyard → :7437`; that live config is machine-specific
and not committed (the committed `Caddyfile.example` is the documentation).

## TLS matters if you want dock badges / notifications

The portal can run as a standalone desktop app (Safari → File → Add to Dock, or
any browser's "install"), and it sets a **dock badge** with the count of
in-flight tasks via the Badging API (`navigator.setAppBadge`).

That API — and the Notification API — are **only available in a secure
context**: an `https://` origin, or `localhost` / `127.0.0.1`. A plain-HTTP
custom hostname is *not* a secure context, so on `http://cogyard` (or
`http://cogyard`) the Badging API isn't even exposed and the badge silently
no-ops. Verified: on `http://cogyard`, `window.isSecureContext === false` and
`'setAppBadge' in navigator === false`.

To get a working badge you therefore need one of:

1. **HTTPS at the proxy.** Caddy issues a locally-trusted cert with one line —
   add `tls internal` to the site block (see `Caddyfile.example`) and use
   `https://cogyard`. This is the recommended path.
2. **Point the dock app at `http://localhost:7437`** directly. `localhost` is a
   secure context, so the badge works — you just lose the pretty hostname.

The icon itself (apple-touch-icon) works over plain HTTP; only the
badge/notification layer needs the secure context.

## Reverse proxy & the personal layer (future: an add-on)

The reverse proxy, its TLS, and the per-machine process manager are all
**platform- and service-specific** — exactly the kind of thing cogyard core
must stay free of (core is cross-platform and ships no drivers). Today they
live as personal/example config (this doc + `Caddyfile.example` + the reference
plist). The planned home for them is the **add-on framework** (the planned community add-on ecosystem): a "serving/proxy" add-on
would sit alongside the tunnel add-on, declaring its own platform and prereqs,
instead of baking Caddy or LaunchAgent assumptions into the published tree.
Until that framework lands, treat this doc as the contract.
