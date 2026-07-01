#!/bin/bash
# Dev runner: API + Angular dev server together. Ports come from .env.worktree
# when present (written per-worktree by the SessionStart hook with that
# worktree's allocated PORT / FRONTEND_PORT); otherwise repo defaults
# (API 7440, frontend 4200). The frontend proxy (proxy.conf.mjs) reads the
# same exported $PORT, so /api always targets this run's backend.
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env.worktree ] && . ./.env.worktree; set +a
# COGYARD_DEV_GUARD arms the backend's orphan guard (server/index.mjs): if this
# script dies uncleanly (kill -9, terminal closed, MCP reap) the trap below never
# fires and the backgrounded backend would reparent to launchd and run forever —
# the guard makes it self-exit instead. Prod (LaunchAgent) never sets this.
COGYARD_DEV_GUARD=1 node server/index.mjs &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT INT TERM
npm start -w frontend -- --port "${FRONTEND_PORT:-4200}"
