#!/bin/bash
# SessionStart hook shim — registered in ~/.claude/settings.json. All logic
# lives in worktree-session.mjs (single node entry point; see that file).
# Always exits 0: a failing hook must never block Claude session start.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/worktree-session.mjs" "$@" || true
exit 0
