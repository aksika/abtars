#!/usr/bin/env bash
# doctor.sh — health check and auto-fix for ~/.agentbridge
set -uo pipefail

AB="$HOME/.agentbridge"
FIXES=0

log() { echo "[doctor] $1"; }
fix() { log "FIX: $1"; FIXES=$((FIXES + 1)); }

# 1. Directory permissions (sensitive dirs should be 700)
for d in "$AB/titok" "$AB/titok/cookies" "$AB/memory"; do
  if [ -d "$d" ] && [ "$(stat -c %a "$d")" != "700" ]; then
    chmod 700 "$d"
    fix "$d permissions → 700"
  fi
done

# 2. Stale lock files (older than 1 hour)
while IFS= read -r f; do
  rm -f "$f"
  fix "removed stale lock $f"
done < <(find "$AB" -name "*.lock" -mmin +60 2>/dev/null)

# 3. Stale browse artifacts (logs, prompts, wrappers older than 3 days)
while IFS= read -r f; do
  rm -f "$f"
  FIXES=$((FIXES + 1))
done < <(find "$AB/logs" -name "browse_*" -mtime +3 2>/dev/null)
[ $FIXES -gt 0 ] && log "FIX: cleaned stale browse artifacts"

# 4. Cookie file exists and is valid JSON
COOKIE="$AB/titok/cookies/x-cookies.json"
if [ -f "$COOKIE" ]; then
  if ! python3 -c "import json; json.load(open('$COOKIE'))" 2>/dev/null; then
    log "WARN: $COOKIE is not valid JSON — cookie auth will fail"
  fi
else
  log "WARN: no X cookies found — tweet replies/discovery won't work"
fi

# 5. Git repo health
cd "$AB"
if [ -d .git ]; then
  if ! git remote get-url origin &>/dev/null; then
    log "WARN: git remote 'origin' missing — backup push will fail"
  fi
  if ! timeout 3 git push --dry-run &>/dev/null; then
    log "WARN: git push would fail — check upstream/auth"
  fi
fi

# 6. Required dirs exist
for d in "$AB/twitterX" "$AB/twitterX/output" "$AB/skills" "$AB/logs" "$AB/memory/sleep"; do
  if [ ! -d "$d" ]; then
    mkdir -p "$d"
    fix "created missing dir $d"
  fi
done

# 7. Follows file exists
if [ ! -f "$AB/twitterX/base.follows.json" ]; then
  log "WARN: base.follows.json missing — tweet feed won't run"
fi

log "Done. $FIXES fixes applied."
