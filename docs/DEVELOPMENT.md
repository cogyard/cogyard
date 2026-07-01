# Developing cogyard

How the repo is laid out, how to run it locally, and the invariants to keep when
contributing. For what cogyard *is*, see the [README](../README.md).

## Architecture

cogyard is one repo with four layers; data flows up, never down.

```
core/        data layer — frontmatter parse, project registry, git, worktree,
             lane graph, port allocations. Plain Node, importable. No CLI/HTTP/UI.
cli/         the command surface (what skills and humans call):
               tasks.mjs   init / sync / projects / convert / mount / doctor
               env.mjs     detect / port-owner / claim / release
               tunnel.mjs  expose a worktree's dev server at a stable hostname
server/      read-only HTTP /api over core/ (transport + guards + portal views)
frontend/    Angular + PrimeNG SPA, consumes /api/*
hooks/       worktree session setup — _tasks auto-mount + port allocation
```

The rule that keeps it honest: **`server/` owns no task or git logic — it imports
`core/`.** One source of truth. The CLI and the HTTP API are two thin front ends
over the same `core/` functions.

## Getting started

```
git clone https://github.com/cogyard/cogyard.git
cd cogyard
npm install            # workspaces: installs root + frontend, hoisted

# run the API and the SPA in two terminals:
npm run api            # Node server on :7440
cd frontend && npm start   # ng serve on :4200, proxies /api → :7440

# or the CLI directly:
node cli/tasks.mjs --help
```

Open http://localhost:4200 for the portal.

## Task files

Each project keeps a `_tasks/` directory of markdown files, `NNN-<slug>.md`: a
YAML frontmatter block (id, status, deps, scope, claims) over a markdown body.
That file is the source of truth for a unit of work. `core/` parses them; the
portal renders them; the CLI claims and syncs them. Parallel agents in different
worktrees **claim** a task atomically before touching it, so two never race on
the same work.

Per-machine state (the project registry and worktree port allocations) lives in
a config directory under your home folder, overridable with an environment
variable — so a checkout never has to hardcode machine paths.

## Invariants — keep these when contributing

- **The `/api` surface is read-mostly.** Non-`GET` returns `405`. Writes go
  through the single documented seam in `server/http.mjs` — don't add them any
  other way. The portal is a viewer, not an editor.
- **No CORS anywhere.** Everything is same-origin: prod serves the SPA and `/api`
  from one port; dev uses the Angular proxy. Don't add CORS headers.
- **`core/` stays UI-agnostic** — no CLI/HTTP/UI imports leak into it. If a view
  needs data, add a `core/` function and call it from both `cli/` and `server/`.
- **Version is the release counter.** The root `package.json` version bumps on
  every merge to the default branch (minor); the running app shows
  `version (commit)` and `/api/health` is commit-stamped.

## Building / serving

`frontend/dist/` is gitignored — rebuild after frontend changes with
`npm run build`. In production the SPA and `/api` are served same-origin from a
single Node process; `/api/health` reports the build's commit so a deploy can be
verified.

## Contributing

- Match the surrounding code — comment density, naming, idioms.
- Keep the brand lowercase: it's **cogyard**, always.
- One logical change per PR; describe the human point of the change, not the
  mechanics.
