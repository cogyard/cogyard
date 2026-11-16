#!/bin/bash
# Dev runner: API + Angular dev server together.
#
# Ports come from `cogyard env ports`, which reads the allocation registry —
# never from a file in the worktree (task 121, moved into the CLI by task 131 so
# every project can ask the same question without copying a script). See
# core/ports.mjs for why the old .env.worktree copy was removed, not repaired.
#
# The hook still writes .env.worktree, but with no ports in it (task 143): it is
# sourced for any shared non-port values a project keeps there, and the ports
# resolved below are the only ones this script binds.
#
# The frontend proxy (proxy.conf.mjs) reads the same exported $PORT, so /api
# always targets this run's backend.
cd "$(dirname "$0")/.." || exit 1

# Whatever else a worktree keeps here (never the ports — see above).
set -a; [ -f .env.worktree ] && . ./.env.worktree; set +a

# A worktree that cannot resolve its allocation stops here rather than guessing
# a port and colliding with another worktree. Captured into a variable first: an
# inline `eval "$(...)"` reports the status of the EVAL, so a failed lookup would
# eval an empty string and sail on with whatever ports happened to be lying around.
# Outside a worktree the command prints nothing, so the defaults below stand.
# This repo calls its OWN cli/, not `cogyard` on PATH: the installed binary is a
# symlink to the main checkout, so a worktree asking it would be answered by
# main's code about main's rules. Other projects use `cogyard env ports` — the
# same command, the same answer, reached the only way they can.
ports=$(node cli/env.mjs ports --shell) || exit 1
eval "$ports"
PORT="${PORT:-7440}"
FRONTEND_PORT="${FRONTEND_PORT:-4200}"
export PORT FRONTEND_PORT

echo "dev.sh: API :$PORT · frontend :$FRONTEND_PORT"

# COGYARD_DEV_GUARD arms the backend's orphan guard (server/index.mjs): if this
# script dies uncleanly (kill -9, terminal closed, MCP reap) the trap below never
# fires and the backgrounded backend would reparent to launchd and run forever —
# the guard makes it self-exit instead. Prod (LaunchAgent) never sets this.
COGYARD_DEV_GUARD=1 node server/index.mjs &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT INT TERM
npm start -w frontend -- --port "${FRONTEND_PORT:-4200}"
