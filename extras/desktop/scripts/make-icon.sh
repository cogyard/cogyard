#!/usr/bin/env bash
# make-icon.sh — regenerate build/icon.icns from build/icon-source.svg.
# icon-source.svg is the cogyard mark (white six-checkmark wheel + amber spark)
# on an indigo Big-Sur-grid rounded tile, padded so the corners are transparent.
#
# Rasterize with headless Chrome (NOT qlmanage — qlmanage bakes an opaque WHITE
# matte into transparent regions, which shows as a white border around the dock
# icon). Chrome's --default-background-color=00000000 preserves real alpha.
# Then sips scales the master and iconutil packs the .icns. Run from desktop/:
#   bash scripts/make-icon.sh
set -euo pipefail
cd "$(dirname "$0")/../build"

CHROME=""
for c in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
  [ -x "$c" ] && CHROME="$c" && break
done
[ -n "$CHROME" ] || { echo "no Chrome/Chromium/Edge found to rasterize the SVG"; exit 1; }

mkdir -p render
MASTER="render/icon-1024.png"
rm -f "$MASTER"
"$CHROME" --headless=new --disable-gpu --force-device-scale-factor=1 \
  --default-background-color=00000000 --hide-scrollbars \
  --window-size=1024,1024 --screenshot="$PWD/$MASTER" \
  "file://$PWD/icon-source.svg" >/dev/null 2>&1
[ -f "$MASTER" ] || { echo "rasterize failed: $MASTER missing"; exit 1; }

# Guard: the top-left corner must be transparent, or the dock icon gets a border.
A=$(sips -g hasAlpha "$MASTER" | tail -1)
echo "master: $MASTER ($A)"

mkdir -p icon.iconset
for s in 16 32 128 256 512; do
  sips -z "$s" "$s"        "$MASTER" --out "icon.iconset/icon_${s}x${s}.png"    >/dev/null
  sips -z $((s*2)) $((s*2)) "$MASTER" --out "icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns icon.iconset -o icon.icns
echo "wrote $(pwd)/icon.icns"

# Also emit a committed 512px PNG for the DEV dock icon (app.dock.setIcon in
# main.mjs) — a `electron .` run otherwise shows the generic Electron icon.
sips -z 512 512 "$MASTER" --out icon.png >/dev/null
echo "wrote $(pwd)/icon.png"
