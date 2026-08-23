#!/usr/bin/env bash
# abtars.sh — bridge launcher (spawned by watchdog or `abtars start`)
set -euo pipefail

ABTARS_HOME="${ABTARS_HOME:-$HOME/.abtars}"
# #1711 R2: strip trailing separators so the spawn target is one canonical
# literal shared with the watchdog, reconciliation, and doctor.
while [[ "$ABTARS_HOME" == */ && "$ABTARS_HOME" != "/" ]]; do ABTARS_HOME="${ABTARS_HOME%/}"; done

# Make native addons (better-sqlite3) resolvable
ABMIND_LIB="${ABMIND_HOME:-$HOME/.abmind}/lib/node_modules"
NODE_PATH="${ABMIND_LIB:+$ABMIND_LIB:}${NODE_PATH:-}"
export NODE_PATH

exec node "$ABTARS_HOME/app/bundle/abtars.js" "$@"
