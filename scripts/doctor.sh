#!/usr/bin/env bash
# doctor.sh — health check and auto-fix for ~/.agentbridge
#
# Usage:
#   doctor.sh          # diagnose only — prints warnings, changes nothing
#   doctor.sh --fix    # diagnose + apply fixes
set -uo pipefail

AB="$HOME/.agentbridge"
FIX=false
WARNS=0
FIXES=0

[[ "${1:-}" == "--fix" ]] && FIX=true

warn() { echo "[doctor] WARN: $1"; WARNS=$((WARNS + 1)); }
fix()  { echo "[doctor] FIX:  $1"; FIXES=$((FIXES + 1)); }

# 1. Directory permissions (sensitive dirs should be 700)
for d in "$AB/titok" "$AB/titok/cookies" "$AB/memory"; do
  if [ -d "$d" ] && [ "$(stat -c %a "$d" 2>/dev/null)" != "700" ]; then
    if $FIX; then
      chmod 700 "$d"; fix "$d permissions → 700"
    else
      warn "$d permissions not 700"
    fi
  fi
done

# 2. Stale lock files (older than 1 hour)
while IFS= read -r f; do
  if $FIX; then
    rm -f "$f"; fix "removed stale lock $f"
  else
    warn "stale lock: $f"
  fi
done < <(find "$AB" -name "*.lock" -mmin +60 2>/dev/null)

# 3. Stale browse artifacts (older than 3 days)
STALE_BROWSE=$(find "$AB/logs" -name "browse_*" -mtime +3 2>/dev/null | wc -l)
if [ "$STALE_BROWSE" -gt 0 ]; then
  if $FIX; then
    find "$AB/logs" -name "browse_*" -mtime +3 -delete 2>/dev/null
    fix "cleaned $STALE_BROWSE stale browse artifacts"
  else
    warn "$STALE_BROWSE stale browse artifacts in logs/"
  fi
fi

# 4. Cookie file exists and is valid JSON
COOKIE="$AB/titok/cookies/x-cookies.json"
if [ -f "$COOKIE" ]; then
  if ! python3 -c "import json; json.load(open('$COOKIE'))" 2>/dev/null; then
    warn "$COOKIE is not valid JSON — cookie auth will fail"
  fi
else
  warn "no X cookies found — tweet replies/discovery won't work"
fi

# 5. Required dirs exist
for d in "$AB/twitterX" "$AB/twitterX/output" "$AB/skills" "$AB/logs" "$AB/memory/sleep" "$AB/memory/retrospectives"; do
  if [ ! -d "$d" ]; then
    if $FIX; then
      mkdir -p "$d"; fix "created missing dir $d"
    else
      warn "missing dir: $d"
    fi
  fi
done

# 6. Follows file exists
if [ ! -f "$AB/twitterX/base.follows.json" ]; then
  warn "base.follows.json missing — tweet feed won't run"
fi

# Summary
if $FIX; then
  echo "[doctor] Done. $FIXES fixes applied, $WARNS warnings."
else
  if [ "$WARNS" -eq 0 ]; then
    echo "[doctor] All clear."
  else
    echo "[doctor] $WARNS warning(s). Run with --fix to repair."
  fi
fi
