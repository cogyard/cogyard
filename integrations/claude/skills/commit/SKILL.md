---
name: commit
description: Create git commits following project conventions. Auto-prepends the active cogyard task id ([#NN]) to the subject when one task is currently claimed in this repo, so `git log` shows which task each commit relates to.
disable-model-invocation: false
argument-hint: "[task-id] [optional message]"
---

# /commit — task-aware git commits

Create one or more git commits for staged + unstaged changes. Integrates with the cogyard task system: if a task is currently claimed in this repo, its id is auto-prepended to every commit subject as `[#NN]`. This makes `git log` immediately scannable for which task a change belongs to.

A project that has its own `.claude/skills/commit/SKILL.md` overrides this global skill — defer to it. This global skill is the fallback for repos without local conventions.

## Step 1 — Detect the active task id

Run:

```bash
cogyard tasks current
```

Output is JSON `{count, tasks: [{id, file, claimed_at, claimed_by_session}]}` (sorted most-recent claim first). Decide the prefix:

- `count === 1` → use that task's `id` as the prefix.
- `count === 0` → no prefix.
- `count > 1` → ambiguous. Ask the user which task this commit belongs to (or `none` to skip the prefix). Don't guess.

If `$ARGUMENTS` starts with a 1–3 digit number (e.g. `/commit 37 fix routing`), that overrides auto-detect: use that id and treat the rest as the message. Use `0` or `none` as the explicit "no prefix" override.

If the repo has no `_tasks/` dir (i.e. cogyard isn't initialized here), `cogyard tasks current` returns `count: 0`. Skip the prefix silently — no error, no warning.

## Step 2 — Build commit messages

If `$ARGUMENTS` (after stripping any leading task-id) is a complete commit message, use it verbatim. Otherwise:

1. Run `git status` and `git diff` (staged + unstaged) to inventory the changes.
2. Group changes into logical commits per the rules below.
3. For each proposed commit, compose a subject and a bullet body.
4. Present all proposals via `AskUserQuestion` with `multiSelect: true`. Each option's label is the proposed subject; the description lists the files. Only commit the ones the user selects.

### Subject format

```
[#<id>] type(scope): short description
```

- `[#<id>]` is omitted when no id was detected/provided.
- **type**: `fix` (bug or correctness), `feat` (new capability), `refactor` (restructure without behavior change), `docs` (docs/task files only), `improve` (enhancement to existing feature), `chore` (tooling/deps/config). Pick the most specific one.
- **scope** (optional): the area affected — keep it short. Examples: `auth`, `viewer`, `routes`, `dal`, `frontend`, `cli`, or a feature name like `wishes`, `family-vault`. If the work crosses several layers, prefer a feature-name scope over chaining layers (`feat(family-vault)`, not `feat(dal+routes+frontend)`). **Skip the scope entirely** if no name reads naturally — `feat: subject` is fine. Don't invent one to satisfy the format.
- Subject under 72 chars, lowercase, no trailing period, no filler ("update X", "various changes" — be specific).

### Body

Bullet points, one line per logical change. State *what* changed and (when non-obvious) *why*. Skip a body if the subject already says everything.

### Co-author

Append the standard Anthropic co-author line to every commit body (per `~/.claude/CLAUDE.md` and the user's git workflow):

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

### Grouping

**Default: one logical change = one commit, even when it crosses layers.** A feature that touches the DAL, a route, and a frontend control to read it is *one* logical change, not three. Splitting it makes review harder and `git log` noisier.

Split into multiple commits only when the changes are *independently meaningful*:

- Two unrelated bug fixes that happen to be in the same diff → two commits.
- A refactor pass plus a new feature → two commits (refactor first, then feature).
- A mass mechanical edit (rename, formatter run, lint sweep) plus real work → two commits.
- The user has already said "split this" or the project's `CLAUDE.md` documents layer-ordered commits.

When you do split, order so each commit builds & runs on its own — typically schema/config first, then API, then frontend, then docs. Fold doc/task-file edits into the layer they describe; only commit `docs` standalone if the docs are independent.

When in doubt, prefer the *larger* commit. Don't bundle in unrelated cleanup, though — if you spot drive-by issues, mention them in your response after committing, don't silently fold them in.

## Step 3 — Stage and commit

- `git add` files **by name**, never `-A` or `.`. This avoids accidentally committing `.env`, credentials, or transient artifacts.
- Run `git add` and `git commit` as **separate** commands. No chaining (some projects' hooks block this).
- Pass the commit message via a `HEREDOC` so multi-line bodies survive shell quoting:

```bash
git commit -m "$(cat <<'EOF'
[#37] fix(viewer): dim DONE rows in flat list mode

- Per-row .task--done class so flat list visually matches grouped view
- Same opacity (0.55) used by .bucket-done

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- After each commit, run `git status` to verify the working tree is in the expected state.

## What this skill does NOT do

- **Doesn't push.** Push only when the user asks.
- **Doesn't amend.** If a commit was wrong, make a new commit (or ask the user to amend explicitly).
- **Doesn't bypass hooks.** No `--no-verify`. If a hook fails, surface the failure and fix the underlying cause.
- **Doesn't claim or release tasks.** That's `pickup-task` / `cogyard env claim` / `cogyard env release`.

## Examples

User: `/commit`  
→ One task claimed (#40). Stage and commit each logical group with `[#40]` prefix.

User: `/commit fix dropdown overflow on mobile`  
→ One task claimed (#40). Single commit: `[#40] fix(frontend): dropdown overflow on mobile`.

User: `/commit 37 add registry dedupe`  
→ Override prefix to `#37`. Single commit: `[#37] feat(cli): add registry dedupe`.

User: `/commit none typo in readme`  
→ No prefix. Single commit: `docs: typo in readme`.

User: `/commit` (no claims, no `_tasks/`)  
→ No prefix. Group changes and propose commits as usual.
