#!/usr/bin/env bash
# test/upgrade.sh — the upgrade gate: an existing user moves from the last npm
# release to this build.
#
# test/clean-machine.sh starts from an empty machine. Every existing user starts
# from the state the PREVIOUS release left behind — ~/.cogyard, the project's own
# files, task files with claims in them — and the on-disk layout has changed
# between releases. This test reproduces that user in a pristine Docker container:
#   1. `npm i -g cogyard@latest` (whatever npm calls latest — never a pinned
#      number, so this always tests the upgrade real users will make)
#   2. with that version: `cogyard init`, reserve and write a task, commit it,
#      make a worktree, claim the task from it. (A second project with its tasks
#      in a tracked `_tasks/` folder was dropped by task 169: no release after
#      1.53.0 — which has no upgrade path — makes one, and `tasks init`, which
#      made it, is gone.)
#   3. print what it left on disk, so a failing log shows the old layout
#   4. `npm i -g` this build's packed tarball over the top
#   5. check the project, the task and the claim all still work, each its own
#      PASS/FAIL line
# A release listed in NO_UPGRADE_PATH (in the container script) is one whose
# users reinstall instead: the gate notes it and passes without the checks.
#
# NOT part of `npm test` and not in scripts/run-checks.sh — it needs Docker and
# network (it installs from npm). It runs in GitHub's upgrade job after every
# push to main, and in bin/publish-snapshot before every release, which refuses
# to release when Docker is down rather than accept a skip. Run by hand, it skips
# with a notice when Docker is unavailable.
#
#   bash test/upgrade.sh [<pack-dir>]              # default: this checkout
#   NODE_IMAGE=node:24 bash test/upgrade.sh        # pin a different runtime
#
# <pack-dir> is where `npm pack` runs, as in test/clean-machine.sh: a release
# passes the tree it is about to publish.
set -euo pipefail

NODE_IMAGE="${NODE_IMAGE:-node:22}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PACK_FROM="${1:-$REPO}"
cd "$REPO"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: Docker not available — upgrade gate not run." >&2
  exit 0
fi

CONTAINER_SCRIPT="$(mktemp -t cogyard-up.XXXXXX).sh"
PACK_DIR="$(mktemp -d -t cogyard-pack.XXXXXX)"
trap 'rm -rf "$CONTAINER_SCRIPT" "$PACK_DIR"' EXIT

echo "▸ npm pack in $PACK_FROM (this build — runs prepack SPA build)…"
( cd "$PACK_FROM" && npm pack --pack-destination "$PACK_DIR" >"$PACK_DIR/pack.log" 2>&1 ) \
  || { tail -25 "$PACK_DIR/pack.log" >&2; echo "FAIL: npm pack in $PACK_FROM" >&2; exit 1; }
PKG_TGZ="$(ls "$PACK_DIR"/cogyard-*.tgz)"
echo "  packed: $(basename "$PKG_TGZ")"

cat > "$CONTAINER_SCRIPT" <<'UP'
set -u
FAIL=0; ok(){ echo "PASS: $1"; }; bad(){ echo "FAIL: $1"; FAIL=1; }; hr(){ echo "----------------------------------------"; }
installed(){ npm ls -g cogyard --depth=0 2>/dev/null | sed -n 's/.*cogyard@//p' | head -1; }

# A real user of the previous release has a git identity and an agent installed;
# COGYARD_DRIVER=claude is what auto-detect picks on such a machine.
git config --global user.name "Upgrade Test"
git config --global user.email "upgrade-test@example.invalid"
git config --global init.defaultBranch main
export COGYARD_DRIVER=claude
export CLAUDE_CONFIG_DIR="$HOME/.claude"

hr; echo "ENV: node $(node -v) | npm $(npm -v) | $(git --version)"

hr; echo "PREVIOUS RELEASE: npm i -g cogyard@latest"
npm i -g cogyard@latest >/tmp/old.log 2>&1 || { echo "FAIL: npm i -g cogyard@latest"; tail -25 /tmp/old.log; exit 1; }
OLD="$(installed)"
echo "previous version: $OLD"

# Releases with no upgrade path. Users of these reinstall rather than upgrade:
# 1.53.0 predates the move of each project's cogyard files into `.cogyard/`,
# nothing moves an older project over, and when that was decided nobody was on
# it. While npm's latest is on this list there is no upgrade to test, so the gate
# says so and passes; once a newer release is out, the full test runs again with
# nothing to undo here. Add a version only when that is a deliberate decision.
NO_UPGRADE_PATH="1.53.0"
for v in $NO_UPGRADE_PATH; do
  if [ "$OLD" = "$v" ]; then
    echo "NOTE: $OLD has no upgrade path (its users reinstall) — nothing to check until npm's latest is a newer release."
    hr; echo ">>> UPGRADE GATE ($OLD -> this build): ALL PASS — no upgrade path from $OLD, nothing checked"
    exit 0
  fi
done

hr; echo "SET UP WITH $OLD: a project, a task, a worktree, a claim"
cd "$HOME"
cogyard init demo --kind single >/tmp/init.log 2>&1 || { echo "FAIL: cogyard init ($OLD)"; tail -25 /tmp/init.log; exit 1; }
cd "$HOME/demo"
RESERVED="$(cogyard tasks next-id first-task 2>/tmp/nid.err)" || { echo "FAIL: tasks next-id ($OLD)"; cat /tmp/nid.err; exit 1; }
TASK_FILE="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).file)' "$RESERVED")"
TASK_ID="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).id))' "$RESERVED")"
PADDED="$(printf '%03d' "$TASK_ID")"
TITLE="Upgrade survivor task"
cat > "$TASK_FILE" <<TASK
---
id: $TASK_ID
slug: first-task
title: $TITLE
status: OPEN
type: feature
labels: []
created: 2026-01-01
done_date: null
depends_on: []
related: []
touches_paths: []
commit_policy: per-phase
out_of_scope: []
parallel_safe: true
env:
  branch: null
  claimed_at: null
  claimed_by: null
---

# $TASK_ID: $TITLE

## Scope

- [ ] survive an upgrade
TASK
cogyard tasks sync push "add task" >/tmp/push.log 2>&1 || { echo "(sync push with $OLD failed — continuing)"; tail -10 /tmp/push.log; }

# The worktree the Claude driver makes for a task, then the session-start hook in
# it, the way a pickup does it.
WT="$HOME/demo/.claude/worktrees/task-$PADDED-first-task"
git worktree add -q -b "worktree-task-$PADDED-first-task" "$WT" >/tmp/wt.log 2>&1 || { echo "FAIL: git worktree add"; cat /tmp/wt.log; exit 1; }
( cd "$WT" && cogyard hook session-start . >/tmp/hook-old.log 2>&1 ) || true
( cd "$WT" && cogyard env claim "$TASK_FILE" old-session ) >/tmp/claim.log 2>&1 \
  || { echo "FAIL: env claim ($OLD)"; cat /tmp/claim.log; exit 1; }
echo "set up: task $TASK_ID at $TASK_FILE, claimed from $WT"

hr; echo "LAYOUT $OLD LEFT BEHIND"
echo "## ~/.cogyard"; ls -la "$HOME/.cogyard"
for f in "$HOME"/.cogyard/*.json; do [ -f "$f" ] && { echo "## $f"; cat "$f"; echo; }; done
echo "## project files (no .git, no node_modules)"
( cd "$HOME/demo" && find . -path ./.git -prune -o -path '*/node_modules' -prune -o -print | sort | head -80 )
echo "## worktree's cogyard files"
( cd "$WT" && ls -la .cogyard .claude _tasks 2>&1 | head -30 )
echo "## task file"; cat "$TASK_FILE"

hr; echo "UPGRADE: npm i -g this build over $OLD"
npm i -g /cogyard.tgz >/tmp/new.log 2>&1 && ok "npm i -g this build over $OLD" || { bad "npm i -g this build"; tail -25 /tmp/new.log; }
NEW="$(installed)"
echo "upgraded: $OLD -> $NEW"
# Same version is not a failure: a release re-run after npm already has this
# version reinstalls it. The checks below still run.
if [ -z "$NEW" ]; then bad "no cogyard installed after the upgrade"
elif [ "$NEW" = "$OLD" ]; then echo "NOTE: this build is $NEW, the same as npm's latest — a reinstall, not an upgrade"
else ok "installed version changed ($OLD -> $NEW)"; fi

hr; echo "CHECKS WITH $NEW on $OLD's layout"
cd "$HOME/demo"
# Both doctors' output is printed whatever they exit with: on an old layout the
# question is also whether they NOTICE it, which an exit code can't show.
cogyard doctor >/tmp/doctor.log 2>&1 && ok "cogyard doctor" || bad "cogyard doctor"
sed 's/^/  | /' /tmp/doctor.log | tail -40

cogyard tasks projects list >/tmp/plist.log 2>&1 && grep -q demo /tmp/plist.log \
  && ok "tasks projects list still shows the project" || { bad "tasks projects list lost the project"; cat /tmp/plist.log; }

cogyard tasks find "$TASK_ID" >/tmp/find.log 2>&1 && [ -f "$(tail -1 /tmp/find.log)" ] \
  && ok "tasks find $TASK_ID resolves to the task file" || { bad "tasks find $TASK_ID"; cat /tmp/find.log; }

cogyard tasks current >/tmp/current.log 2>&1 && grep -q "first-task" /tmp/current.log \
  && ok "tasks current still lists the claim" || { bad "tasks current lost the claim"; cat /tmp/current.log; }

cogyard env where "$TASK_FILE" >/tmp/where.log 2>&1 \
  && node -e 'const w=JSON.parse(require("fs").readFileSync("/tmp/where.log","utf8"));process.exit(w.claimed_at&&String(w.worktree||"").includes("first-task")?0:1)' 2>/dev/null \
  && ok "env where shows the claim and its worktree" || { bad "env where lost the claim or its worktree"; cat /tmp/where.log; }

cogyard tasks plan >/tmp/plan.log 2>&1 && grep -q "Upgrade survivor" /tmp/plan.log \
  && ok "tasks plan shows the task" || { bad "tasks plan does not show the task"; tail -30 /tmp/plan.log; }

cogyard tasks doctor >/tmp/tdoctor.log 2>&1 && ok "tasks doctor" || bad "tasks doctor"
sed 's/^/  | /' /tmp/tdoctor.log | tail -40

( cd "$WT" && cogyard hook session-start . ) >/tmp/hook-new.log 2>&1
( cd "$WT" && cogyard tasks find "$TASK_ID" ) >/tmp/wtfind.log 2>&1 && [ -f "$(tail -1 /tmp/wtfind.log)" ] \
  && ok "the old worktree still reaches the task after session-start" \
  || { bad "the old worktree cannot reach the task after session-start"; tail -20 /tmp/hook-new.log; cat /tmp/wtfind.log; }

cd "$HOME/demo"
cogyard serve --port 7442 >/tmp/serve.log 2>&1 &
SPID=$!
UP=0
for i in $(seq 1 60); do
  node -e "fetch('http://127.0.0.1:7442/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && { UP=1; break; }
  sleep 1
done
if [ "$UP" = 1 ]; then
  ok "serve answered /api/health"
  node -e "fetch('http://127.0.0.1:7442/api/tasks?p=demo').then(r=>r.json()).then(j=>{const t=(j.tasks||[]).find(t=>String(t.id)===process.argv[1]||Number(t.id)===Number(process.argv[1]));console.log('  /api/tasks?p=demo ->',(j.tasks||[]).length,'task(s)');process.exit(t&&/Upgrade survivor/.test(t.title||'')?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})" "$TASK_ID" \
    && ok "portal lists the task" || bad "portal does not list the task"
else
  bad "serve never came up"; tail -25 /tmp/serve.log
fi
kill "$SPID" 2>/dev/null || true

# Read the claim back from the file itself, not through `tasks current`, so this
# line says whether release works, whatever the lines above said.
cogyard env release "$TASK_FILE" >/tmp/release.log 2>&1 \
  && cogyard env where "$TASK_FILE" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).claimed_at?1:0))' \
  && ok "env release clears the old claim" || { bad "env release did not clear the old claim"; cat /tmp/release.log; }

hr; [ "$FAIL" = 0 ] && echo ">>> UPGRADE GATE ($OLD -> $NEW): ALL PASS" || echo ">>> UPGRADE GATE ($OLD -> $NEW): FAILURES ABOVE"
exit $FAIL
UP

echo "▸ Running upgrade gate in ${NODE_IMAGE}…"
docker run --rm \
  -v "$PKG_TGZ":/cogyard.tgz:ro \
  -v "$CONTAINER_SCRIPT":/up.sh:ro \
  "$NODE_IMAGE" bash /up.sh
