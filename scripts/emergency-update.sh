#!/usr/bin/env bash
# Emergency update — bypasses deployed abtars binary.
# Fetches latest dev, builds fresh, deploys from source bundle.
# Usage: bash ~/.abtars-releases/src/abtars/scripts/emergency-update.sh

set -euo pipefail

SRC_DIR="${HOME}/.abtars-releases/src/abtars"
ABMIND_DIR="${HOME}/.abtars-releases/src/abmind"

if [ ! -d "$SRC_DIR/.git" ]; then
  echo "x Source not found at $SRC_DIR" >&2
  exit 1
fi

echo "+ Fetching latest..."
git -C "$SRC_DIR" fetch origin dev
git -C "$SRC_DIR" checkout origin/dev
[ -d "$ABMIND_DIR/.git" ] && git -C "$ABMIND_DIR" fetch origin dev && git -C "$ABMIND_DIR" checkout origin/dev

echo "+ Building..."
node "$SRC_DIR/esbuild.config.js"

echo "+ Deploying from fresh bundle..."
node "$SRC_DIR/bundle/abtars-cli.js" update --dev "$SRC_DIR"
