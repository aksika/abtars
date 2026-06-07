#!/bin/bash
# build-and-deploy.sh — Non-blocking build + deploy (#871)
# Spawned detached by /update deploy. Bridge stays responsive.
<<<<<<< HEAD
set -uo pipefail

ABTARS_SRC="${1:?Usage: build-and-deploy.sh <abtars-src> [abmind-src]}"
ABMIND_SRC="${2:-$(dirname "$ABTARS_SRC")/abmind}"

# Build abmind (if repo exists)
if [ -d "$ABMIND_SRC/.git" ]; then
  cd "$ABMIND_SRC" || exit 1
  if ! npm ci 2>/dev/null; then
    rm -rf node_modules
    exit 1
  fi
  npm run build --silent || exit 1
fi

# Build abtars
cd "$ABTARS_SRC" || exit 1
if ! npm ci 2>/dev/null; then
  rm -rf node_modules
  exit 1
fi
node esbuild.config.js || exit 1

# Deploy (health-verified, auto-rollback)
=======
set -euo pipefail

ABTARS_SRC="${1:?Usage: build-and-deploy.sh <abtars-src> [abmind-src]}"
ABMIND_SRC="${2:-$(dirname "$ABTARS_SRC")/abmind}"
LOG="$HOME/.abtars/logs/deploy-$(date +%F_%H%M%S).log"

# Force development mode — npm ci skips devDeps under NODE_ENV=production
export NODE_ENV=development

exec > "$LOG" 2>&1

# Build abmind (if repo exists)
if [ -d "$ABMIND_SRC/.git" ]; then
  echo "=== abmind: npm ci ==="
  cd "$ABMIND_SRC"
  if ! npm ci; then
    echo "FAILED: abmind npm ci"
    rm -rf node_modules
    exit 1
  fi
  echo "=== abmind: build ==="
  npm run build || { echo "FAILED: abmind build"; exit 1; }
fi

# Build abtars
echo "=== abtars: npm ci ==="
cd "$ABTARS_SRC"
if ! npm ci; then
  echo "FAILED: abtars npm ci"
  rm -rf node_modules
  exit 1
fi
echo "=== abtars: esbuild ==="
node esbuild.config.js || { echo "FAILED: esbuild"; exit 1; }

# Deploy (health-verified, auto-rollback)
echo "=== deploying ==="
>>>>>>> dev
exec node bundle/abtars-cli.js update --from-local
