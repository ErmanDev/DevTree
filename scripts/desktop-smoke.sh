#!/bin/sh
# Smoke test for the desktop window on Linux: start DevTree under a virtual X display and
# check that its window opens and actually draws the page (not an empty window).
# Needs Xvfb, xwininfo (x11-utils) and ImageMagick.
# Usage: scripts/desktop-smoke.sh [binary]. Set SMOKE_SHOTS=<dir> to keep the screenshots.
set -eu
BIN=${1:-target/debug/devtree}
TMP=$(mktemp -d)
SHOTS=${SMOKE_SHOTS:-$TMP}
mkdir -p "$SHOTS"
APP=
trap 'kill $APP "$XVFB" 2>/dev/null || true; rm -rf "$TMP"' EXIT

Xvfb :77 -screen 0 1600x1000x24 >/dev/null 2>&1 &
XVFB=$!
export DISPLAY=:77 NO_AT_BRIDGE=1
sleep 1

# try <name> [VAR=value...]: start DevTree with the given environment and wait for a drawn window.
try() {
  name=$1
  shift
  env "$@" "$BIN" --port 0 --data-dir "$TMP/data-$name" --clone-dir "$TMP/clones" >"$TMP/$name.log" 2>&1 &
  APP=$!
  found=no
  colors=0
  for _ in $(seq 30); do
    sleep 1
    if ! kill -0 "$APP" 2>/dev/null; then
      echo "[$name] DevTree exited:"
      cat "$TMP/$name.log"
      APP=
      return 1
    fi
    xwininfo -root -tree | grep -q '"DevTree"' || continue
    found=yes
    import -window root "$SHOTS/smoke-$name.png"
    colors=$(identify -format '%k' "$SHOTS/smoke-$name.png")
    # The empty start screen still has DevTree's colors, logo and text: hundreds of colors.
    if [ "$colors" -gt 100 ]; then
      echo "✓ [$name] desktop window open and drawn ($colors colors)"
      kill "$APP"
      APP=
      return 0
    fi
  done
  echo "✗ [$name] window found: $found, colors on screen: $colors"
  cat "$TMP/$name.log"
  # Diagnostics: is the window mapped, are WebKit's helper processes alive, did the page connect?
  win=$(xwininfo -root -tree | grep '"DevTree"' | awk '{print $1}' | head -1)
  [ -n "$win" ] && xwininfo -id "$win" | grep -E 'Width|Height|Map State' || true
  ps -eo pid,ppid,stat,etime,args | grep -iE '[W]ebKit|[d]evtree' || true
  port=$(grep -o 'localhost:[0-9]*' "$TMP/$name.log" | head -1 | cut -d: -f2)
  [ -n "$port" ] && { echo "connections to :$port"; ss -tn state established "( dport = :$port )" || true; }
  kill "$APP"
  APP=
  return 1
}

if try default; then
  exit 0
fi
# Diagnose a blank window. WebKit's sandbox (bubblewrap) needs user namespaces, which
# Ubuntu's AppArmor can restrict for unprivileged programs; report that setting.
echo "kernel.apparmor_restrict_unprivileged_userns = $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a)"
try no-compositing WEBKIT_DISABLE_COMPOSITING_MODE=1 || true
exit 1
