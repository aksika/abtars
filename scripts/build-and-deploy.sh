#!/bin/bash
# build-and-deploy.sh — Non-blocking build + deploy (#871)
# Spawned detached by /update deploy. Bridge stays responsive.
set -euo pipefail

ABTARS_SRC="${1:?Usage: build-and-deploy.sh <abtars-src> [abmind-src]}"
ABMIND_SRC="${2:-$(dirname "$ABTARS_SRC")/abmind}"
LOG="$HOME/.abtars/logs/deploy-$(date +%F_%H%M%S).log"
STATE_FILE="$HOME/.abtars/deploy.state"
PHASE="init"

# Force development mode — npm ci skips devDeps under NODE_ENV=production
export NODE_ENV=development

cleanup() {
  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo "{\"status\":\"failed\",\"completedAt\":\"$(date -u +%FT%TZ)\",\"error\":\"$PHASE failed (exit $exit_code)\",\"logFile\":\"$(basename "$LOG")\"}" > "$STATE_FILE"
  fi
}
trap cleanup EXIT

exec > "$LOG" 2>&1

# Build abmind (if repo exists)
if [ -d "$ABMIND_SRC/.git" ]; then
  PHASE="npm-update-abmind"
  echo "=== abmind: npm update ==="
  cd "$ABMIND_SRC"
  if ! npm update; then
    echo "FAILED: abmind npm update"
    rm -rf node_modules
    exit 1
  fi
  PHASE="build-abmind"
  echo "=== abmind: build ==="
  npm run build || { echo "FAILED: abmind build"; exit 1; }
fi

# Build abtars
PHASE="npm-update-abtars"
echo "=== abtars: npm update ==="
cd "$ABTARS_SRC"
if ! npm update; then
  echo "FAILED: abtars npm update"
  rm -rf node_modules
  exit 1
fi
PHASE="esbuild"
echo "=== abtars: esbuild ==="
node esbuild.config.js || { echo "FAILED: esbuild"; exit 1; }

# Deploy (health-verified, auto-rollback)
PHASE="deploy"
echo "=== deploying ==="
exec node bundle/abtars-cli.js update --local
