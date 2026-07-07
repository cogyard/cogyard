#!/bin/bash
# Probe for the SessionStart port hook. Validates that SessionStart hooks fire and
# $CLAUDE_PROJECT_DIR is populated. Safe to leave installed; cheap.
TS="$(date '+%Y-%m-%dT%H:%M:%S%z')"
{
  echo "---"
  echo "$TS"
  echo "CLAUDE_PROJECT_DIR=${CLAUDE_PROJECT_DIR:-(unset)}"
  echo "PWD=$(pwd)"
  echo "argv=$*"
} >> /tmp/claude-probe.log 2>&1

# Surface as a macOS notification so the user sees it without checking the log.
SHORT_DIR="${CLAUDE_PROJECT_DIR:-(unset)}"
SHORT_DIR="${SHORT_DIR/#$HOME/~}"
osascript -e "display notification \"CLAUDE_PROJECT_DIR=$SHORT_DIR\" with title \"cogyard probe fired\" sound name \"Pop\"" >/dev/null 2>&1

exit 0
