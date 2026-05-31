#!/usr/bin/env bash
# abtars.sh — bridge launcher (spawned by watchdog or `abtars start`)
set -euo pipefail

ABTARS_HOME="${ABTARS_HOME:-$HOME/.abtars}"
CURRENT="$ABTARS_HOME/current/bundle"

# Make globally-installed abmind resolvable by the bundle
GLOBAL_MODULES="$(npm root -g 2>/dev/null || true)"
ABMIND_LIB="${ABMIND_HOME:-$HOME/.abmind}/lib/node_modules"
NODE_PATH="${GLOBAL_MODULES:+$GLOBAL_MODULES:}${ABMIND_LIB:+$ABMIND_LIB:}${NODE_PATH:-}"
export NODE_PATH

exec node "$CURRENT/abtars.js" "$@"
