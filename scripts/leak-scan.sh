#!/bin/sh
# leak-scan.sh — fail-closed PRESENTATION-leak detector.
#
# Public files carry no internal task-number provenance refs and nothing that is
# only meaningful to the maintainer. New `(task NNN)` comments get written
# constantly, so a one-time strip isn't enough — this gate makes the leak class
# impossible to silently re-introduce into files outsiders READ.
#
# SCOPE — presentation only. It scans the manifested markdown + JSON-metadata
# files (what a public reader sees). Source-code comments are DELIBERATELY out of
# scope: a `// … (task NNN)` header tag is contributor-visible, not presentation,
# and lives on its own scrub track — so *.mjs/.ts/.sh/.scss/.html are never scanned
# here (that would fail red on every un-scrubbed source comment).
#
# What it flags:
#   - internal task-number provenance: `(task NNN)`, `Task NNN converted …`, `task-NNN`
#   - private-toolbox markers that must never appear in public docs: bd-scaffold*,
#     bd-verify*, bd-chats
# What it allows (whitelist):
#   - `"do task NNN"` / `"pick up task X"` / `"work on task Y"` trigger USAGE EXAMPLES
#   - the `task-NNN-<slug>` worktree-NAMING format (e.g. `task-NNN-worktree-port-…`)
#
# Owner-NAME / project-name / real-secret leaks are a separate, already-private gate
# (scripts/secret-scan.sh --mode=public, run as its own Layer in bin/publish-snapshot).
#
# Usage:  scripts/leak-scan.sh [TREE_ROOT] [MANIFEST]
#   TREE_ROOT  defaults to the repo root (git rev-parse). Pass a staging tree to
#              scan an extracted snapshot (bin/publish-snapshot does this).
#   MANIFEST   defaults to $TREE_ROOT/publish/public-manifest.txt. When it exists,
#              only files ON the manifest are scanned (so private *.local.md and
#              _tasks/ — allowed to keep task numbers — are skipped). When it is
#              absent (e.g. a staging tree, where the manifest is export-ignore'd),
#              every *.md / *.json in the tree is scanned — the tree is already the
#              public set, filtered by export-ignore + the manifest Layer.
# Exit:   0 = clean, 1 = at least one leak (prints file:line), 2 = usage error.
#
# No dependencies beyond POSIX sh + grep.

set -eu

root=${1:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}
manifest=${2:-$root/publish/public-manifest.txt}
[ -d "$root" ] || { echo "leak-scan: not a directory: $root" >&2; exit 2; }

# A line is a leak if it matches FLAG and does NOT match ALLOW.
FLAG='(^|[^[:alnum:]])[Tt]ask[ -][0-9]|bd-scaffold|bd-verify|bd-chats'
ALLOW='do task [0-9]|pick up task|work on task|task-[0-9][0-9]*-[a-z]'

# --- build the presentation file list ---------------------------------------------
tmplist=$(mktemp)
trap 'rm -f "$tmplist"' EXIT
if [ -f "$manifest" ]; then
  # manifest paths are repo-relative; keep only markdown + JSON metadata that exist.
  grep -vE '^\s*#|^\s*$' "$manifest" \
    | grep -iE '\.(md|json)$' \
    | while IFS= read -r rel; do
        [ -f "$root/$rel" ] && printf '%s\n' "$root/$rel"
      done > "$tmplist"
else
  find "$root" \( -name node_modules -o -name .git -o -name dist -o -name .angular \) -prune -o \
    -type f \( -name '*.md' -o -name '*.json' \) -print > "$tmplist"
fi

# --- scan ------------------------------------------------------------------------
hits=$(mktemp)
trap 'rm -f "$tmplist" "$hits"' EXIT
while IFS= read -r f; do
  [ -n "$f" ] || continue
  grep -nE "$FLAG" "$f" 2>/dev/null | grep -vE "$ALLOW" | sed "s|^|$f:|" >> "$hits" || true
done < "$tmplist"

n=$(wc -l < "$hits" | tr -d ' ')
if [ "$n" -gt 0 ]; then
  echo "✗ leak-scan: $n internal reference(s) in public presentation file(s) —" >&2
  cat "$hits" >&2
  echo "" >&2
  echo "  Strip the internal task-number / private-toolbox reference (or, if it is a" >&2
  echo "  legitimate \"do task NNN\" usage example, leave it — the whitelist covers those)." >&2
  exit 1
fi
echo "✓ leak-scan: $(wc -l < "$tmplist" | tr -d ' ') presentation file(s) clean"
exit 0
