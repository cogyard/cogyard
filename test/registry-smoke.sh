#!/usr/bin/env bash
# test/registry-smoke.sh — install the copy of cogyard that npm is actually serving
# and check that it works.
#
# test/clean-machine.sh installs a tarball `npm pack` built on this machine. What a
# release publishes is a separate build, and what users install is whatever the
# registry then serves — which can differ (a different prepack run, files dropped at
# publish time, a half-failed or wrong-tree publish). This test installs from the
# registry itself, in a pristine Docker container with an empty $HOME:
#   `npm i -g cogyard@<version>`, then the same checks test/clean-machine.sh runs on
#   its tarball (test/install-checks.sh): --help, `init`, `serve` returning the portal
#   from the bundled build with no build attempted, and a new user's daily routine.
# Each check prints PASS or FAIL; the script exits non-zero when any fails.
#
# bin/publish-snapshot runs it after every release, against the version just
# published. Run by hand, it checks what users get today; it skips with a notice
# when Docker is unavailable.
#
#   bash test/registry-smoke.sh [<version>]        # default: npm's `latest`
#   NODE_IMAGE=node:24 bash test/registry-smoke.sh # pin a different runtime
set -euo pipefail

VERSION="${1:-latest}"
NODE_IMAGE="${NODE_IMAGE:-node:22}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: Docker not available — registry smoke test not run." >&2
  exit 0
fi

CONTAINER_SCRIPT="$(mktemp -t cogyard-rs.XXXXXX).sh"
trap 'rm -f "$CONTAINER_SCRIPT"' EXIT

cat > "$CONTAINER_SCRIPT" <<'RS'
set -u
. /checks.sh

hr; echo "ENV: node $(node -v) | npm $(npm -v) | $(git --version) | registry $(npm config get registry)"
[ -e "$HOME/.cogyard" ] && bad "not a clean machine (~/.cogyard exists)" \
  || ok "clean machine (no ~/.cogyard, no git identity)"

hr; echo "REGISTRY PACKAGE: npm i -g cogyard@$WANT — from npm, no repo, no devDeps, no build"
echo "  npm resolves cogyard@$WANT to: $(npm view "cogyard@$WANT" version 2>/dev/null || echo 'nothing (not on the registry)')"
export HOME=/root/home-reg && mkdir -p "$HOME" && cd "$HOME"
package_checks "cogyard@$WANT" "cogyard@$WANT from the registry" 7441 "npm registry"
if [ "$WANT" != latest ]; then
  [ "$INSTALLED" = "$WANT" ] && ok "installed version is $WANT" || bad "installed version is ${INSTALLED:-none}, not $WANT"
fi

hr; [ "$FAIL" = 0 ] && echo ">>> REGISTRY SMOKE (cogyard@${INSTALLED:-$WANT}): ALL PASS" \
  || echo ">>> REGISTRY SMOKE (cogyard@${INSTALLED:-$WANT}): FAILURES ABOVE"
exit $FAIL
RS

echo "▸ Installing cogyard@${VERSION} from the npm registry in ${NODE_IMAGE}…"
docker run --rm \
  -e WANT="$VERSION" \
  -v "$CONTAINER_SCRIPT":/rs.sh:ro \
  -v "$REPO/test/install-checks.sh":/checks.sh:ro \
  "$NODE_IMAGE" bash /rs.sh
