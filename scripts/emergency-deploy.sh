#!/bin/bash
# Emergency deploy — independent of abtars CLI.
# Use when `abtars update` itself is broken.
set -euo pipefail

HOME_DIR="${ABTARS_HOME:-$HOME/.abtars}"
SRC_DIR="${ABTARS_SRC:-$HOME_DIR/src/abtars}"
ABMIND_SRC="$(dirname "$SRC_DIR")/abmind"

echo "=== Emergency deploy ==="

# 1. Pull both repos
echo "Pulling abtars..."
git -C "$SRC_DIR" pull --ff-only origin dev
echo "Pulling abmind..."
git -C "$ABMIND_SRC" pull --ff-only origin dev

# 2. Build abmind
echo "Building abmind..."
[ -d "$ABMIND_SRC/node_modules" ] || (cd "$ABMIND_SRC" && npm install --omit=dev --silent)
(cd "$ABMIND_SRC" && npm run build --silent)

# 3. Build abtars bundle
echo "Building abtars..."
[ -d "$SRC_DIR/node_modules" ] || (cd "$SRC_DIR" && npm install --omit=dev --silent)
(cd "$SRC_DIR" && node esbuild.config.js)
rm -rf "$SRC_DIR/bundle/public" && cp -r "$SRC_DIR/src/components/dashboard/public" "$SRC_DIR/bundle/public"

# 4. Atomic swap
echo "Deploying..."
rm -rf "$HOME_DIR/app.prev"
[ -d "$HOME_DIR/app" ] && mv "$HOME_DIR/app" "$HOME_DIR/app.prev"
cp -r "$SRC_DIR/bundle" "$HOME_DIR/app"
# Copy abmind into bundle
mkdir -p "$HOME_DIR/app/node_modules/abmind"
cp -r "$ABMIND_SRC/dist" "$HOME_DIR/app/node_modules/abmind/"
cp "$ABMIND_SRC/package.json" "$HOME_DIR/app/node_modules/abmind/"

# 5. Restart bridge (mode-dependent)
echo "Restarting..."
PID_FILE="$HOME_DIR/bridge.pid"
[ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null || true
sleep 2

if pgrep -f "watchdog.sh" >/dev/null 2>&1; then
  echo "Watchdog detected — it will restart the bridge."
elif launchctl list 2>/dev/null | grep -q abtars; then
  echo "LaunchAgent detected — it will restart the bridge."
else
  echo "No supervisor — starting with nohup."
  nohup node "$HOME_DIR/app/bundle/abtars.js" >> "$HOME_DIR/logs/bridge.log" 2>&1 &
  echo $! > "$PID_FILE"
fi

sleep 5
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Bridge running (PID $(cat "$PID_FILE"))"
else
  echo "WARNING: bridge not running — check logs"
fi
