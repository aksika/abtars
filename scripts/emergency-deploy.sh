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
git -C "$SRC_DIR" checkout -- package-lock.json 2>/dev/null || true
git -C "$SRC_DIR" pull --ff-only origin dev
echo "Pulling abmind..."
git -C "$ABMIND_SRC" checkout -- package-lock.json 2>/dev/null || true
git -C "$ABMIND_SRC" pull --ff-only origin dev

# 2. Build abmind
echo "Building abmind..."
[ -d "$ABMIND_SRC/node_modules" ] || (cd "$ABMIND_SRC" && npm install --silent)
(cd "$ABMIND_SRC" && npm run build --silent)

# 3. Build abtars bundle
echo "Building abtars..."
[ -d "$SRC_DIR/node_modules" ] || (cd "$SRC_DIR" && npm install --silent)
(cd "$SRC_DIR" && node esbuild.config.js)
rm -rf "$SRC_DIR/bundle/public" && cp -r "$SRC_DIR/src/components/dashboard/public" "$SRC_DIR/bundle/public"

# 4. Stop bridge (kill watchdog only if NOT managed by launchd)
echo "Stopping..."
if launchctl list 2>/dev/null | grep -q abtars; then
  # launchd manages watchdog — just kill the bridge, watchdog will respawn after swap
  if [ -f "$HOME_DIR/bridge.lock" ]; then
    BRIDGE_PID=$(python3 -c "import json; print(json.load(open('$HOME_DIR/bridge.lock'))['pid'])" 2>/dev/null || true)
    [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null || true
    sleep 3
    [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null && kill -9 "$BRIDGE_PID" 2>/dev/null || true
  fi
else
  # No launchd — kill watchdog + bridge, we restart watchdog at the end
  pkill -f "watchdog.sh" 2>/dev/null || true
  sleep 1
  if [ -f "$HOME_DIR/bridge.lock" ]; then
    BRIDGE_PID=$(python3 -c "import json; print(json.load(open('$HOME_DIR/bridge.lock'))['pid'])" 2>/dev/null || true)
    [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null || true
    sleep 3
    [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null && kill -9 "$BRIDGE_PID" 2>/dev/null || true
  fi
fi
sleep 2

# 5. Atomic swap (no gap where app/ is missing)
echo "Deploying..."
rm -rf "$HOME_DIR/app.staging"
mkdir -p "$HOME_DIR/app.staging/bundle"
cp -r "$SRC_DIR/bundle/"* "$HOME_DIR/app.staging/bundle/"
mkdir -p "$HOME_DIR/app.staging/bundle/node_modules/abmind"
cp -r "$ABMIND_SRC/dist" "$HOME_DIR/app.staging/bundle/node_modules/abmind/"
cp "$ABMIND_SRC/package.json" "$HOME_DIR/app.staging/bundle/node_modules/abmind/"
rm -rf "$HOME_DIR/app.prev"
[ -d "$HOME_DIR/app" ] && mv "$HOME_DIR/app" "$HOME_DIR/app.prev"
mv "$HOME_DIR/app.staging" "$HOME_DIR/app"
[ -d "$HOME_DIR/app.prev/bundle/node_modules" ] && mv "$HOME_DIR/app.prev/bundle/node_modules" "$HOME_DIR/app/bundle/node_modules"

# 6. Write minimal manifest
COMMIT=$(git -C "$SRC_DIR" rev-parse --short HEAD)
VERSION=$(node -p "require('$SRC_DIR/package.json').version" 2>/dev/null || echo "0.0.0")
echo "{\"version\":\"$VERSION\",\"commit\":\"$COMMIT\",\"activatedAt\":\"$(date -Iseconds)\",\"source\":\"local\"}" > "$HOME_DIR/manifest.json"

# 7. Restart (mode-dependent)
echo "Restarting..."
if launchctl list 2>/dev/null | grep -q abtars; then
  echo "LaunchAgent manages watchdog — it will restart the bridge."
elif [ -f "$HOME_DIR/scripts/watchdog.sh" ]; then
  nohup bash "$HOME_DIR/scripts/watchdog.sh" >> "$HOME_DIR/logs/watchdog.log" 2>&1 &
  echo "Watchdog restarted (PID $!) — it will start the bridge."
else
  nohup node "$HOME_DIR/app/bundle/abtars.js" >> "$HOME_DIR/logs/bridge.log" 2>&1 &
  echo $! > "$HOME_DIR/bridge.pid"
  echo "Bridge started (PID $!)."
fi

sleep 5
if [ -f "$HOME_DIR/bridge.lock" ]; then
  RUNNING=$(python3 -c "import json; print(json.load(open('$HOME_DIR/bridge.lock'))['pid'])" 2>/dev/null || true)
  if [ -n "$RUNNING" ] && kill -0 "$RUNNING" 2>/dev/null; then
    echo "Bridge running (PID $RUNNING)"
  else
    echo "WARNING: bridge not running — check logs"
  fi
else
  echo "WARNING: no bridge.lock yet — check logs"
fi
