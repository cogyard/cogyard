# Add-ons — extending what cogyard does

cogyard core is **agnostic and add-on-free**: nothing platform-, service-, or
owner-specific ships in the published tree. Capabilities beyond the core —
exposing a dev server at a public hostname, fronting the portal with a local
reverse proxy, anything the community dreams up — are **add-ons**: trusted code
you install outside the repo, discovered at runtime, and rendered as cards on
the global **/settings** page.

**An add-on extends COGYARD ITSELF — it is machine-level, never per-project.**
If an add-on operates on a project (tunnel points at one project's dev server),
that targeting is the add-on's own config (`type: 'project'` field, below) —
the framework has no per-project structure at all.

**The surface is a compact list, not a wall of forms.** /settings shows one ROW
per installed add-on (icon, name, activation switch, status pill, one-line
summary); the add-on's whole interaction surface — prereqs, config form, action
buttons, results — opens in a DIALOG from the row's Configure button. Both the
row and the dialog are generated from the manifest: an add-on ships zero UI code,
and the page doesn't grow as add-ons accumulate.

**Install ≠ activate.** The row's switch is a framework-level toggle (persisted
as `disabledAddons: [id, …]` in `~/.cogyard/config.json`, saved through
`POST /api/config`): a switched-off add-on stays listed but is INERT — the
loader never calls its functions and its actions refuse to run.

Core ships exactly three things for this: the **contract** (below), the
**loader/registry** (`core/addons/index.mjs`), and the **Settings surface**
(`frontend/src/app/settings/addons/`). Everything else lives in your add-on.

## Three extension concepts — don't confuse them

| Concept | Axis | Lives at | Discovered by |
|---|---|---|---|
| **Add-on** (this doc) | what cogyard *does* — runtime capabilities with status/config/actions | `~/.cogyard/addons/<id>/` (outside the repo) | `core/addons/index.mjs` |
| **Driver** | which *agent* drives cogyard (Claude Code, …) | `drivers/<name>/` (in-repo) | `core/drivers.mjs` — see `docs/DRIVERS.md` |
| **Scaffold** | what a project *kind* templates at `init` (skeleton + package.json + wiring defaults + description) | built-ins in `core/scaffolds/`; additions at `~/.cogyard/scaffolds/<kind>/scaffold.mjs` | `core/scaffolds/index.mjs` |
| **`.claude-plugin/`** | Claude Code packaging of this repo (marketplace/plugin metadata) | repo root | Claude Code itself |

A scaffold has no status/actions/prereqs and renders no Settings card — it's
resolved once at project creation. Its descriptor contract is documented in
`core/scaffolds/index.mjs`; a drop-in kind appears in the New/Add drawer and
`/settings` kind picker (with its description) after a server restart, and it
cannot shadow a built-in kind.

Both add-ons and drivers extend `~/.cogyard/`, in distinct namespaces:
drivers use the `driver` key in `config.json`; add-ons own the
`addons/` directory. Keep them separate.

There is also a fourth, non-mechanism resident of "outside core": **extras** —
self-contained workspaces/build targets the portal does NOT manage at runtime
(no manifest, no Settings card), e.g. the desktop shell. An extra is just a
directory/repo you build yourself; do not force one through the add-on loader.

## Install / distribution (the Phase-0 decision)

**Drop-in directory.** An add-on is installed by placing a folder — copy, clone,
or symlink — at:

```
~/.cogyard/addons/<id>/addon.mjs        # (or $COGYARD_HOME/addons/<id>/)
```

then restarting the server (manifests are resolved once per process; for the
production portal that's the LaunchAgent reload). No npm, no registry, no
auto-update — you chose the code, you own it. npm- or git-based distribution
can layer on later as sugar over the same directory.

Add-ons are **trusted code**: the loader `import()`s your module into the server
process. There is no sandbox. Install only what you'd run by hand.

## The contract — `addon.mjs`

Your module exports a `manifest` object (named export; default export also
accepted). `id` MUST equal the folder name.

```js
// ~/.cogyard/addons/tunnel/addon.mjs
export const manifest = {
  id: 'tunnel',
  label: 'Cloudflare Tunnel',
  description: "Expose this project's current worktree dev server at a stable public hostname.",
  icon: '🌐',                       // emoji / short glyph shown on the card
  thirdParty: true,                 // external service involved → bias actions to 'manual'
  platforms: ['darwin'],            // omit (or []) = everywhere; else hidden/disabled elsewhere

  // MACHINE checks, displayed with fixHints, NEVER auto-installed.
  prereqs() {
    return [{ id: 'cloudflared', label: 'cloudflared installed', ok: false, fixHint: 'brew install cloudflared' }];
  },

  // Renders the card's config form. Types: 'string' | 'enum' | 'boolean' | 'project'.
  // A 'project' field renders a dropdown of registered projects; the chosen SLUG
  // arrives in cfg like any other value — the only project awareness anywhere.
  configSchema: [
    { key: 'project', label: 'Project', type: 'project', required: true },
    { key: 'hostname', label: 'Public hostname', type: 'string', required: true, placeholder: 'dev.example.com' },
    { key: 'side', label: 'Port', type: 'enum', options: ['frontend', 'backend'], default: 'frontend' },
  ],

  // Live, derived MACHINE-LEVEL roll-up — inspect whatever your add-on itself
  // owns (files, processes, APIs; e.g. tunnel reads its own tunnels.json and
  // reports every tunnel-enabled project in details). The registry stores NOTHING.
  status() {
    return { enabled: false, summary: 'no tunnels enabled', healthy: null, details: {} };
  },

  // tier 'safe'  → the portal EXECUTES it server-side via run().
  // tier 'manual' → the portal NEVER executes it; it shows command()'s output.
  actions: [
    { id: 'enable',  label: 'Enable',  tier: 'manual', needsConfig: true },
    { id: 'here',    label: 'Repoint to current worktree', tier: 'safe' },
    { id: 'disable', label: 'Stop',    tier: 'safe' },
    { id: 'delete',  label: 'Delete (tunnel + DNS)', tier: 'manual', destructive: true },
  ],

  // SAFE actions only. May be async. Return { ok, message? }.
  run(actionId, cfg) {
    return { ok: true, message: `repointed ${cfg.project}` };
  },

  // MANUAL actions only. MUST be side-effect-free: render the exact copy-paste
  // command for the user to run themselves. Return { command, note? }.
  command(actionId, cfg) {
    return { command: `cogyard tunnel enable ${cfg.project} ${cfg.hostname}`, note: 'runs cloudflared login first if needed' };
  },
};
```

### Tiered execution — enforced by core, not by convention

The registry routes by the action's `tier`:

- **safe** → `run(actionId, cfg)` executes in the server process.
  Reserve this for local, reversible operations.
- **manual** → `run()` is **never called**. The registry calls your
  side-effect-free `command()` and the card shows the command with a Copy
  button and a Recheck. Anything third-party, destructive, or auth-requiring
  (logins, DNS, deletes) belongs here — the portal will not do it for you.

Prereqs follow the same philosophy: **detect + instruct, never auto-install**
(`ok: false` + a `fixHint` string the card displays).

### Platforms

Core is cross-platform, so an add-on declares where it runs. On a host not in
`platforms`, the card renders dimmed/disabled and none of your functions are
called. A macOS/Cloudflare tunnel and a Windows/ngrok equivalent are two
different add-ons — that's the point.

### Degradation rules (what the loader guarantees)

- No `addons/` dir → empty catalog; the portal shows "No add-ons installed".
- A module that fails to import, exports no manifest, mismatches its folder
  name, or lacks a label → listed under **Broken installs** with the error;
  never crashes the engine.
- A throwing `prereqs()`/`status()` → reported on the card (unhealthy /
  prereqError); never crashes the engine.

## API surface (portal ⇄ server)

| Endpoint | Method | Returns |
|---|---|---|
| `/api/addons` | GET | catalog: wire-safe manifests (functions stripped; `supported` + `active` flags added) + machine prereqs + broken installs |
| `/api/addons/status` | GET | every installed add-on's machine-level `status()` + prereqs |
| `/api/addons/:id/:action` | POST | body = the card's config values; safe → `run()`'s `{ ok, manual: false, message }`; manual → `{ ok, manual: true, command, note }` — never executed |

The POST goes through the same `requireSameOrigin` write seam as every other
portal write (`server/http.mjs`); everything else non-GET still 405s; no CORS.

## Writing your first add-on (5 minutes)

1. `mkdir -p ~/.cogyard/addons/hello`
2. Write `~/.cogyard/addons/hello/addon.mjs` with a manifest like the one above
   (id `hello`; a `status()` returning `{ enabled: true, summary: 'hi' }` is
   enough).
3. Restart the server (`npm run api` in dev, or reload the LaunchAgent).
4. `curl localhost:7440/api/addons` — your manifest is in the catalog.
5. Open **/settings** (the sidebar cog) — your add-on appears as a row under
   Add-ons; Configure opens its dialog. No change to core, server, or frontend.
   That's the whole ecosystem mechanism.

## Candidate add-ons (worked examples of the boundary)

- **tunnel** — ONE card: "cogyard can expose dev servers at stable
  Cloudflare hostnames." Machine prereqs (cloudflared installed, logged in);
  `status()` rolls up every tunnel-enabled project from its own tunnels.json;
  `project`/`hostname` config fields; `enable`/`delete` manual, `repoint`/
  `disable` safe. macOS + Cloudflare specific, which is exactly why it's an
  add-on and not core. Its CLI (`cli/tunnel.mjs`) predates this framework and is
  the prototype to re-author against the contract (`docs/TUNNELS.md`).
- **serving/reverse-proxy** — the local Caddy/nginx layer that puts a clean
  hostname + TLS in front of `:7437` (`docs/DEPLOY.md`). Same platform-specific
  shape; mostly `manual` actions (the portal shows your Caddyfile stanza, it
  doesn't rewrite it).
