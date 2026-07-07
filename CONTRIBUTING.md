# Contributing to cogyard

Thanks for your interest. cogyard is a task system for coordinating AI coding
agents — a plain-Node engine + CLI, a read-only Angular portal, and an
agent-agnostic adapter seam. This doc is the front door for changing it; the
deeper architecture and setup notes live in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Getting set up

```sh
git clone https://github.com/cogyard/cogyard.git cogyard
cd cogyard
npm install                 # npm workspaces — root + frontend
npm run api                 # Node API on :7440
cd frontend && npm start    # ng serve on :4200, proxies /api -> :7440
```

Per-machine state (project registry, port allocations, usage ledger) lives in
`~/.cogyard/` — override with `COGYARD_HOME`. Nothing requires your repos to live
in any particular directory; the `~/gitroot` default for the shared task store is
just a convention, overridable with `COGYARD_PROJECTS_ROOT`.

## Running the tests

```sh
npm test          # node --test over test/
```

Add tests for new `core/` behaviour next to the existing ones in `test/`. The
data layer is the part most worth covering — it's pure functions over task files,
git, and the registry, so it tests cleanly without a server or browser.

**The clean-machine install gate** (needs Docker, so it's separate from `npm test`):

```sh
npm run test:clean-machine    # bash test/clean-machine.sh
```

It archives the repo, runs it in a fresh container with no config, and asserts the
documented install works end to end — lean `npm install`, `cogyard init`, and
`cogyard serve` rendering the portal UI. Run it before a release; it skips with a
notice if Docker isn't available.

## The layering — the one rule that matters

```
core/  -->  imported by  cli/ . server/ . hooks/ . drivers/
                              |
                          server/ exposes read-only /api  -->  frontend/
```

- **`core/` owns all task/git/registry/worktree logic and imports no CLI, HTTP,
  or UI code.** If a view needs data, add a `core/` function and call it from both
  `cli/` and `server/`. `server/` and `cli/` are thin front ends over one source
  of truth — never duplicate logic between them.
- **The `/api` surface is read-mostly.** Non-`GET` returns `405`. The only writes
  go through the single documented seam in `server/http.mjs` (same-origin-gated);
  don't add writes any other way. The portal is a viewer, not an editor.
- **No CORS, anywhere.** Everything is same-origin (prod serves SPA + `/api` from
  one port; dev uses the Angular proxy). Don't add CORS headers.
- **Stay agent-agnostic.** Nothing in `core/`/`cli/`/`hooks/` may hardcode a
  Claude-Code literal (worktree path shape, transcript format, model price table).
  Those live behind the adapter in `drivers/<name>/adapter.mjs` — see
  [`docs/DRIVERS.md`](docs/DRIVERS.md). Adding an agent is a new adapter,
  never a new `if (claude)` branch.

## Versioning

The root `package.json` version is the release counter: **minor** bump on every
merge to the default branch, **patch** for direct hotfixes on it, **major** only
on a maintainer's explicit call. The running app shows `version (commit)` and
`/api/health` is commit-stamped, so any deploy can be verified against `HEAD`.

## Pull requests

- One logical change per PR. In the description, lead with the *human point* of
  the change — what it's for — not a list of the mechanics.
- Match the surrounding code: comment density, naming, idioms.
- Keep the brand lowercase — it's **cogyard**, always.
- Run `npm test` and, for portal changes, build the SPA (`npm run build`) before
  opening the PR.

## License

By contributing you agree your contributions are licensed under the project's
[MIT license](LICENSE).
