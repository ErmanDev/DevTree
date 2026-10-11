#!/bin/sh
# Smoke test for the desktop window on Linux: start DevTree under a virtual X display and
# check that its window opens and actually draws the page (not an empty window).
# Needs Xvfb, xwininfo (x11-utils) and ImageMagick. Usage: scripts/desktop-smoke.sh [binary]
set -eu
BIN=${1:-target/debug/devtree}
TMP=$(mktemp -d)
trap 'kill "$APP" "$XVFB" 2>/dev/null || true; rm -rf "$TMP"' EXIT

Xvfb :77 -screen 0 1600x1000x24 >/dev/null 2>&1 &
XVFB=$!
export DISPLAY=:77
sleep 1
"$BIN" --port 0 --data-dir "$TMP/data" --clone-dir "$TMP/clones" >"$TMP/out.log" 2>&1 &
APP=$!

for _ in $(seq 30); do
  sleep 1
  kill -0 "$APP" 2>/dev/null || { echo "DevTree exited:"; cat "$TMP/out.log"; exit 1; }
  xwininfo -root -tree | grep -q '"DevTree"' || continue
  # The empty start screen still has DevTree's colors, logo and text: hundreds of colors.
  colors=$(import -window root "$TMP/shot.png" && identify -format '%k' "$TMP/shot.png")
  if [ "$colors" -gt 100 ]; then
    echo "✓ desktop window open and drawn ($colors colors)"
    exit 0
  fi
done
echo "✗ no drawn DevTree window after 30s"; cat "$TMP/out.log"; exit 1
