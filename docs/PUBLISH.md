# Publishing a project — pushing is not publishing

A push to `main` means one thing: this code is on main. It deploys nothing.
Where a push also deploys to production, every push is a release, so the project
ends up with a pre-push hook that refuses agents — and then no agent, and no
unattended autopilot run, can finish a merge there. So the deploy comes off the
push, and **publishing is its own act: `cogyard publish <project>`**, run by the
owner.

A publish is one fixed sequence. Every step either proves what it claims or
stops the publish with the reason. Nothing is tagged unless every step before
the tag held.

## The sequence

| # | Step | What it proves — or why it stops |
|---|---|---|
| 1 | **Owner** | Started from a terminal, not by an agent. An agent gets exit 3 before anything is read. |
| 2 | **Lock** | No other publish of this project is running. A lock left by a process that died is taken over. |
| 3 | **Code** | `main` is checked out, has no uncommitted changes, and is **identical to `origin/main`** (the platform builds what is pushed). The release tag `v<version>` (root `package.json`) is new and newer than the last release — or already on this exact commit (a re-run). |
| 4 | **Live now** | Reads the health URL. If it already serves this commit, checks and deploy are skipped — so re-running a publish that was interrupted is always safe. |
| 5 | **Checks** | Runs each `checks` command in the main checkout, in order; any failure stops it before anything is deployed. Afterwards the checkout must still be exactly this commit with no tracked file changed — otherwise what was checked is not what would ship. |
| 6 | **Confirm** | Says what you are about to publish, then what happens if you answer yes, in order, in plain sentences. A step you do by hand is marked "Don't do it yet": step 7 tells you when. You answer `y` (or pass `--yes`). |
| 7 | **Deploy** | Runs the project's `command`, then shows each `manual` step, says "Do this by hand now", and waits for you to answer "Have you done it?". Manual steps can't be skipped with `--yes`. |
| 8 | **Verify** | Polls the health URL (every 15 s, up to 10 min) until it serves **exactly this commit**. With no health URL declared, you must confirm you have seen it live. |
| 9 | **Tag** | Sets `v<version>` on the commit (annotated), pushes it, and reads it back from `origin` to prove it landed. This is the flag in the code tree: the newest `v*` tag is what is live; work after it is unreleased. |
| 10 | **Record** | Appends one line to `~/.cogyard/publishes.jsonl` — every publish, including the ones that stopped, with the step and the reason. |

Before step 1 runs anything: the declaration must be valid, every `requires`
credential must be set, and anything the sequence will need to ask you must
have a terminal to ask in (manual steps, or a missing health URL). Each is a
refusal up front, never a surprise halfway through a deploy. Ctrl-C or Ctrl-D at
any point stops it cleanly — lock released, the stop recorded, no tag.

## The declaration — `.cogyard/publish.json`

Committed in the project's repo:

```json
{
  "deploysOnPush": false,
  "manual": ["Press Deploy on the app's page in the DigitalOcean control panel (it builds main)."],
  "health": "https://example.com/health"
}
```

| Field | Required | Meaning |
|---|---|---|
| `deploysOnPush` | yes | `true` while a push to main still deploys. A publish refuses such a project. |
| `command` | one of these two | A shell command that deploys. Runs in the project's main checkout with the owner's `~/.cogyard/secrets.env` credentials in its environment, plus `COGYARD_PUBLISH_SHA` and `COGYARD_PUBLISH_TAG`. Non-zero exit stops the publish. |
| `manual` | one of these two | Steps you do by hand, in order, each confirmed when step 7 asks "Have you done it?". Write each as an instruction to you ("Press Deploy on …"). |
| `health` | no (strongly advised) | An http(s) URL returning JSON with the deployed commit in `commit`, `commitShort` or `sha`. |
| `tag` | no | Default `true`. `false` for a project with no `package.json` version. |
| `checks` | no (strongly advised) | Commands that must pass on the commit before it is deployed — tests, a build. They run in the main checkout, so include the install (`npm ci && npm test`) if its dependencies may be stale, and must not change tracked files. |
| `requires` | no | Credential names the deploy needs (e.g. `DIGITALOCEAN_TOKEN`). Each must be set in `~/.cogyard/secrets.env` or the environment, or the publish refuses before step 1 does anything. Names only; values are never printed. |
Every field is one the publish acts on; there is no free-text field. An
unknown field is an error, not ignored — a typo would otherwise silently
change what a publish does. A project with no file is reported as
**undeclared**; cogyard never infers a deploy from hooks, docs or platform
settings.

### A project that ships more than one thing — `releases`

Some projects ship two things from one repo, each on its own schedule: a
device's firmware and its website, an iOS app and its website. Both take their
version from the same `package.json`, but they go out from different commits,
so one `v<version>` tag cannot mark both. Such a project names each release:

```json
{
  "releases": {
    "website": {
      "label": "Website",
      "tag": "web/v<version>",
      "paths": ["site/", "wrangler.jsonc"],
      "deploysOnPush": false,
      "command": "npx wrangler deploy",
      "health": "https://example.com/version.json"
    },
    "device": {
      "label": "Device",
      "tag": "v<version>",
      "paths": ["firmware/", "platformio.ini"],
      "deploysOnPush": false,
      "manual": ["Plug the meter in by USB, then run npm run upload"]
    }
  }
}
```

The key is the release's name (lowercase letters, digits and `-`). Each release
takes every field in the table above, and three more:

| Field | Required | Meaning |
|---|---|---|
| `label` | yes | What the Graph and the settings card call it: a tag of this release shows on the Graph as `<label> <version>` (`Website 2.6.0`), the tag itself on hover. |
| `tag` | yes | A pattern ending in `<version>` — `"v<version>"`, `"web/v<version>"`, `"ios/v<version>"` — or `false` for no tag. The part before `<version>` must start with a letter and not end in a digit. Two releases whose prefixes overlap (`v` and `v-ios/`) are refused: one's tags would read as the other's. Which release keeps a bare `v` is the project's choice. |
| `paths` | no | The files and folders whose commits count as this release's changes. The settings card's "changes since" counts only those; without `paths` it counts every commit. |

Nothing may sit beside `releases` at the top: every field goes inside a
release. The flat form above stays valid and means one release, tagged
`v<version>`. Each release's last release is its newest tag of its own
pattern, so another release's tags never count — and a publish's "already
released" and "newer than the last release" checks look only at those.

#### Moving a project that already has tags

cogyard never renames, moves or adds an old tag; moving a project to
`releases` changes only how its tags are read.

- **Tags that already match a release's pattern become that release's, as they
  are.** Give the release whose history is already tagged the bare
  `v<version>` pattern, and its history carries over with nothing to change.
- **A release whose past releases were never tagged starts with none.** The
  settings card reads *never released* for it until its first publish. To keep
  its history, tag each past release by hand, once, on the commit that went
  out: `git tag -a web/v2.6.0 <commit> -m "…"`, then
  `git push origin web/v2.6.0`. Only the project knows which commit shipped
  when, so cogyard doesn't guess.
- **From then on it is automatic:** every `cogyard publish <project> <release>`
  tags that release with its own pattern.

## The commands

```bash
cogyard publish
```

Every registered project: whether a push deploys it, its last release tag,
whether git will run a pre-push hook there, and how it publishes. `--json` for
the rows. A project naming its releases gets a line per release.

```bash
cogyard publish <project>
```

Runs the sequence above. `--yes` answers step 5 only.

```bash
cogyard publish <project> <release>
```

The same sequence for one release of a project that names its releases — by
its name or its label, any case. A project with two or more releases refuses a
publish that names none. A `releases` file with a single entry needs no name
(`cogyard publish <project>` publishes it, as the flat form does), and the flat
form refuses one. The deploy command also gets
`COGYARD_PUBLISH_RELEASE` (the release's name), and the publish is recorded
with it.

## Converting a project — the order is the safety argument

1. **Move the deploy trigger.** Turn off deploy-on-push on the platform (on
   DigitalOcean App Platform: Autodeploy off).
2. **Verify a push no longer deploys.** Push to main, wait, and confirm the
   live health commit did not change.
3. **Declare it.** Commit `.cogyard/publish.json` with `"deploysOnPush": false`,
   the deploy step, and the health URL.
4. **Publish once.** `cogyard publish <project>` — it ends with the tag only if
   the new commit is live.
5. **Only then remove any pre-push block.** Removing it before step 2 opens a
   window in which any push silently ships to production.
