#!/usr/bin/env bash
# test/clean-machine.sh — the clean-machine install gate (tasks 28 / 53).
#
# Reproduces a stranger on a fresh machine: `git archive` the repo at a ref (the
# public-snapshot equivalent — no node_modules, no gitignored dist, no _tasks),
# run it in a pristine Docker container with an empty $HOME and no git identity,
# and assert the documented install works end to end:
#   - lean `npm install` (no Electron toolchain, no EBADENGINE)
#   - `cogyard init` commits even with no git user.name/email configured
#   - `cogyard serve` auto-builds the SPA and serves it (GET / = 200, not 503)
#   - the Claude driver installs/uninstalls cleanly
#   - the PUBLISHED-PACKAGE path: `npm pack` the real tarball on the
#     host, `npm i -g` it in the container (no repo, no devDeps), and assert
#     `cogyard serve` serves the BUNDLED SPA without attempting a build
#   - in BOTH installs, a new user's first hour works: next-id, write and validate
#     a task, `sync push` it, claim and release it (`tasks current` follows), see
#     it in `tasks plan`, `tasks doctor` and the portal's /api/tasks, and --help on
#     each of those commands answers without running anything
#
# The installed-package checks and the daily routine live in test/install-checks.sh,
# which test/registry-smoke.sh also runs against the copy npm actually serves.
#
# NOT part of `npm test` (that suite is pure node:test) — this needs Docker. It
# runs in two places: GitHub's clean-machine job after every push to main, and
# bin/publish-snapshot before every release (which refuses to release when Docker
# is down rather than accept a skip). Run by hand, it skips with a notice when
# Docker is unavailable so it never breaks a plain local checkout.
#
#   bash test/clean-machine.sh [<git-ref>] [<pack-dir>]  # default ref: HEAD
#   NODE_IMAGE=node:24 bash test/clean-machine.sh         # pin a different runtime
#
# <pack-dir> is where `npm pack` runs (default: this checkout's working tree). A
# release passes the tree it is about to publish — an extracted archive of the ref
# with its dependencies installed — so the tarball tested is built from the same
# files as the one that ships, not from whatever is uncommitted here.
set -euo pipefail

REF="${1:-HEAD}"
NODE_IMAGE="${NODE_IMAGE:-node:22}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PACK_FROM="${2:-$REPO}"
cd "$REPO"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: Docker not available — clean-machine gate not run." >&2
  exit 0
fi

TAR="$(mktemp -t cogyard-snapshot.XXXXXX).tar"
CONTAINER_SCRIPT="$(mktemp -t cogyard-cm.XXXXXX).sh"
PACK_DIR="$(mktemp -d -t cogyard-pack.XXXXXX)"
trap 'rm -rf "$TAR" "$CONTAINER_SCRIPT" "$PACK_DIR"' EXIT

echo "▸ Archiving $REF (public-snapshot equivalent)…"
git archive --format=tar -o "$TAR" "$REF"

echo "▸ npm pack in $PACK_FROM (the real publishable tarball — runs prepack SPA build)…"
( cd "$PACK_FROM" && npm pack --pack-destination "$PACK_DIR" >/dev/null )
PKG_TGZ="$(ls "$PACK_DIR"/cogyard-*.tgz)"
echo "  packed: $(basename "$PKG_TGZ")"

cat > "$CONTAINER_SCRIPT" <<'CM'
set -u
# ok/bad/hr/jfield, daily_routine and package_checks — shared with
# test/registry-smoke.sh, so the two cannot drift apart (test/install-checks.sh).
. /checks.sh

hr; echo "ENV: node $(node -v) | npm $(npm -v) | $(git --version)"
[ -e "$HOME/.cogyard" ] && bad "not a clean machine (~/.cogyard exists)" \
  || ok "clean machine (no ~/.cogyard, no git identity)"

hr; echo "EXTRACT + INSTALL + LINK"
mkdir -p /app && tar -xf /snapshot.tar -C /app && cd /app
npm install --no-audit --no-fund >/tmp/i.log 2>&1 && ok "npm install" || { bad "npm install"; tail -25 /tmp/i.log; }
grep -qi EBADENGINE /tmp/i.log && bad "EBADENGINE on $(node -v)" || ok "no EBADENGINE"
[ -e node_modules/electron ] && bad "electron pulled into default install (not decoupled)" || ok "lean install (no electron)"
npm link >/tmp/l.log 2>&1 && ok "npm link" || { bad "npm link"; tail -20 /tmp/l.log; }
command -v cogyard >/dev/null && ok "cogyard on PATH" || bad "cogyard not on PATH"
cogyard --help >/dev/null 2>&1 && ok "cogyard --help" || bad "cogyard --help"

hr; echo "QUICKSTART (no git identity on this box)"
cd "$HOME"
cogyard init demo --kind single >/tmp/init.log 2>&1 && ok "cogyard init" || { bad "cogyard init"; tail -25 /tmp/init.log; }
( cd "$HOME"/demo && git log --oneline >/dev/null 2>&1 ) && ok "init produced a commit (git-identity fallback)" || bad "init made no commit"
cogyard tasks projects list >/dev/null 2>&1 && ok "tasks projects list" || bad "tasks projects list"

hr; echo "CLAUDE DRIVER install/uninstall"
export CLAUDE_CONFIG_DIR="$HOME/.claude-test"
cogyard claude install >/tmp/ci.log 2>&1 && ok "claude install" || { bad "claude install"; cat /tmp/ci.log; }
# Installed names are cogyard-<name> (task 218), so they never take a name the
# user's own skills, a project's or Claude Code's use; nothing goes under a bare
# name. -f through the link proves it resolves.
[ -f "$CLAUDE_CONFIG_DIR/skills/cogyard-pickup-task/SKILL.md" ] && [ -f "$CLAUDE_CONFIG_DIR/commands/cogyard-lookup-chat.md" ] && [ -f "$CLAUDE_CONFIG_DIR/commands/cogyard.md" ] \
  && ok "skills installed + resolve (as cogyard-<name>)" || bad "skills missing"
[ ! -e "$CLAUDE_CONFIG_DIR/skills/pickup-task" ] && [ ! -e "$CLAUDE_CONFIG_DIR/commands/lookup-chat.md" ] \
  && ok "nothing installed under a bare name" || bad "a skill or command was installed under its bare name"
# The install PRINTS a settings.json block for the user to paste; it never wires
# hooks itself. So the block is the whole contract, and the way it breaks is
# silent: the engine gains a hook, the installer keeps printing the old list, and
# a new user ends up with a hook that exists but is never called. Nobody notices,
# because everything still "installs fine".
#
# `cogyard hook <unknown>` lists what the engine actually dispatches, so it is the
# oracle: every dispatchable hook must appear in the printed block. Drift in
# either direction reds this.
KNOWN_HOOKS=$(cogyard hook __no_such_hook__ 2>&1 | sed -n 's/.*Known: //p' | tr -d ' ' | tr ',' ' ')
if [ -z "$KNOWN_HOOKS" ]; then
  bad "could not read the engine's hook list (cogyard hook <unknown> printed nothing)"
else
  MISSING=""
  for h in $KNOWN_HOOKS; do
    grep -q "$h" /tmp/ci.log || MISSING="$MISSING $h"
  done
  if [ -n "$MISSING" ]; then
    bad "install block omits dispatchable hook(s):$MISSING"
  else
    ok "install block names every dispatchable hook ($(echo "$KNOWN_HOOKS" | wc -w | tr -d ' '))"
  fi
fi

# doctor is what a new user runs to check the paste landed, so it must survive a
# machine with no agent settings at all rather than erroring on the missing file.
cogyard doctor >/tmp/doctor.log 2>&1 && ok "doctor runs clean on a fresh machine" \
  || { bad "doctor failed on a fresh machine"; tail -20 /tmp/doctor.log; }

cogyard claude uninstall >/dev/null 2>&1 && [ ! -e "$CLAUDE_CONFIG_DIR/skills/cogyard-pickup-task" ] && [ ! -e "$CLAUDE_CONFIG_DIR/commands/cogyard.md" ] \
  && ok "claude uninstall clean" || bad "claude uninstall left files"

hr; echo "DUMMY-PROOF SERVE: portal UI must load with NO manual build"
cd /app
cogyard serve --port 7440 >/tmp/serve.log 2>&1 &
SPID=$!
UP=0
for i in $(seq 1 240); do
  node -e "fetch('http://127.0.0.1:7440/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && { UP=1; break; }
  sleep 1
done
if [ "$UP" = 1 ]; then
  ok "serve answered /api/health (after auto-build)"
  node -e "fetch('http://127.0.0.1:7440/').then(async r=>{const b=await r.text();const html=r.status===200&&/<app-root|<!doctype html/i.test(b);const e503=/SPA not built/i.test(b);console.log('  GET / ->',r.status,'| html?',html,'| 503?',e503);process.exit(html&&!e503?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})" \
    && ok "portal UI served (SPA auto-built — dummy-proof)" || bad "portal UI did not load (503 / not built)"
else
  bad "serve never came up"; tail -25 /tmp/serve.log
fi
daily_routine "$HOME/demo" demo 7440 "repo install"
kill "$SPID" 2>/dev/null || true

hr; echo "PUBLISHED PACKAGE: npm i -g tarball — no repo, no devDeps, no build"
npm rm -g cogyard >/dev/null 2>&1 || true   # drop the npm-link'd /app bin first
export HOME=/root/home-pkg && mkdir -p "$HOME" && cd "$HOME"
package_checks /cogyard.tgz "cogyard tarball" 7441 "npm tarball"

hr; [ "$FAIL" = 0 ] && echo ">>> CLEAN-MACHINE GATE: ALL PASS" || echo ">>> CLEAN-MACHINE GATE: FAILURES ABOVE"
exit $FAIL
CM

echo "▸ Running clean-machine gate in ${NODE_IMAGE}…"
docker run --rm \
  -v "$TAR":/snapshot.tar:ro \
  -v "$PKG_TGZ":/cogyard.tgz:ro \
  -v "$CONTAINER_SCRIPT":/cm.sh:ro \
  -v "$REPO/test/install-checks.sh":/checks.sh:ro \
  "$NODE_IMAGE" bash /cm.sh
