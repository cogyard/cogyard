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
#
# NOT part of `npm test` (that suite is pure node:test) — this needs Docker, so
# run it explicitly before a publish / on release. Skips with a notice when
# Docker is unavailable so it never breaks a plain local checkout.
#
#   bash test/clean-machine.sh [<git-ref>]        # default ref: HEAD
#   NODE_IMAGE=node:24 bash test/clean-machine.sh  # pin a different runtime
set -euo pipefail

REF="${1:-HEAD}"
NODE_IMAGE="${NODE_IMAGE:-node:22}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: Docker not available — clean-machine gate not run." >&2
  exit 0
fi

TAR="$(mktemp -t cogyard-snapshot.XXXXXX).tar"
CONTAINER_SCRIPT="$(mktemp -t cogyard-cm.XXXXXX).sh"
trap 'rm -f "$TAR" "$CONTAINER_SCRIPT"' EXIT

echo "▸ Archiving $REF (public-snapshot equivalent)…"
git archive --format=tar -o "$TAR" "$REF"

cat > "$CONTAINER_SCRIPT" <<'CM'
set -u
FAIL=0; ok(){ echo "PASS: $1"; }; bad(){ echo "FAIL: $1"; FAIL=1; }; hr(){ echo "----------------------------------------"; }

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
[ -e "$CLAUDE_CONFIG_DIR/skills/pickup-task" ] && ok "skills installed + resolve" || bad "skills missing"
cogyard claude uninstall >/dev/null 2>&1 && [ ! -e "$CLAUDE_CONFIG_DIR/skills/pickup-task" ] \
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
kill "$SPID" 2>/dev/null || true

hr; [ "$FAIL" = 0 ] && echo ">>> CLEAN-MACHINE GATE: ALL PASS" || echo ">>> CLEAN-MACHINE GATE: FAILURES ABOVE"
exit $FAIL
CM

echo "▸ Running clean-machine gate in $NODE_IMAGE…"
docker run --rm \
  -v "$TAR":/snapshot.tar:ro \
  -v "$CONTAINER_SCRIPT":/cm.sh:ro \
  "$NODE_IMAGE" bash /cm.sh
