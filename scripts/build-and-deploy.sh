#!/bin/bash
# build-and-deploy.sh — Non-blocking build + deploy (#871)
# Spawned detached by /update deploy. Bridge stays responsive.
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
exec node bundle/abtars-cli.js update --from-local
