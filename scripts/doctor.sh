#!/usr/bin/env bash
# doctor.sh — health check and repair for ~/.agentbridge
#
# Usage:
#   doctor.sh              # diagnose only — prints warnings, changes nothing
#   doctor.sh --fix        # safe fixes (chmod, mkdir, stale locks, stale sleep locks)
#   doctor.sh --fix-full   # all safe fixes + FTS rebuild, WAL checkpoint, git push check
set -uo pipefail

AB="$HOME/.agentbridge"
DB="$AB/memory/memory.db"
FIX=false
FIX_FULL=false
WARNS=0
FIXES=0

case "${1:-}" in
  --fix-full) FIX=true; FIX_FULL=true ;;
  --fix)      FIX=true ;;
esac

warn() { echo "[doctor] WARN: $1"; WARNS=$((WARNS + 1)); }
fix()  { echo "[doctor] FIX:  $1"; FIXES=$((FIXES + 1)); }

# 1. Directory permissions (sensitive dirs should be 700) — fix-full only
for d in "$AB/titok" "$AB/titok/cookies" "$AB/memory"; do
  if [ -d "$d" ] && [ "$(stat -c %a "$d" 2>/dev/null)" != "700" ]; then
    if $FIX_FULL; then
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
done < <(find "$AB" -name "*.lock" -not -path "*/sleep/*" -not -path "*/node_modules/*" -mmin +60 2>/dev/null)

# 3. Stale sleep lock (older than 2 hours, no matching audit .md)
for lockfile in "$AB/memory/sleep"/sleep_*.lock; do
  [ -f "$lockfile" ] || continue
  lockage=$(( ($(date +%s) - $(stat -c %Y "$lockfile" 2>/dev/null || echo 0)) / 60 ))
  if [ "$lockage" -gt 120 ]; then
    base=$(basename "$lockfile" .lock)
    if ! ls "$AB/memory/sleep/${base}"_*.md &>/dev/null; then
      if $FIX; then
        rm -f "$lockfile"; fix "removed stale sleep lock $lockfile (${lockage}min old, no audit)"
      else
        warn "stale sleep lock: $lockfile (${lockage}min old, no audit) — sleep may have hung"
      fi
    fi
  fi
done

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

# 7. Recent backup check
BACKUP_DIR="$HOME/.backup-agentbridge"
if [ -d "$BACKUP_DIR" ]; then
  LATEST=$(find "$BACKUP_DIR" -name "agentbridge-*.zip" -mtime -2 2>/dev/null | head -1)
  if [ -z "$LATEST" ]; then
    warn "no backup in last 2 days — check daily-backup.sh cron"
  fi
else
  warn "backup dir $BACKUP_DIR missing — backups never ran"
fi

# 8. Memory DB health
if [ -f "$DB" ]; then
  INTEGRITY=$(sqlite3 "$DB" "PRAGMA integrity_check;" 2>/dev/null | head -1)
  if [ "$INTEGRITY" != "ok" ]; then
    warn "memory.db integrity check failed: $INTEGRITY"
  fi

  DB_SIZE=$(stat -c %s "$DB" 2>/dev/null || echo 0)
  if [ "$DB_SIZE" -gt 419430400 ]; then
    DB_MB=$((DB_SIZE / 1048576))
    warn "memory.db is ${DB_MB}MB — approaching 500MB disk budget"
  fi

  LATEST_SLEEP=$(find "$AB/memory/sleep" -name "sleep_*.md" -mtime -3 2>/dev/null | head -1)
  if [ -z "$LATEST_SLEEP" ]; then
    warn "no sleep audit in last 3 days — GC/consolidation not running"
  fi
else
  warn "memory.db not found"
fi

# 9. Embedding health (only if EMBEDDING_ENABLED=true)
if grep -q "^EMBEDDING_ENABLED=true" "$AB/.env" 2>/dev/null; then
  if ! command -v ollama &>/dev/null; then
    warn "EMBEDDING_ENABLED but ollama not installed"
  elif ! curl -sf http://localhost:11434/api/tags &>/dev/null; then
    if $FIX; then
      sudo systemctl start ollama 2>/dev/null && sleep 2 && fix "started ollama service"
    else
      warn "EMBEDDING_ENABLED but ollama not running"
    fi
  elif ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
    if $FIX; then
      ollama pull nomic-embed-text &>/dev/null && fix "pulled nomic-embed-text model"
    else
      warn "EMBEDDING_ENABLED but nomic-embed-text not pulled"
    fi
  fi

  if [ -f "$DB" ]; then
    NULL_EMBEDS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM extracted_memories WHERE embedding IS NULL;" 2>/dev/null || echo 0)
    if [ "$NULL_EMBEDS" -gt 0 ]; then
      if $FIX; then
        EMBEDDING_ENABLED=true node "$(dirname "$0")/../dist/cli/agentbridge-embed.js" 2>/dev/null && fix "batch-embedded $NULL_EMBEDS memories"
      else
        warn "$NULL_EMBEDS extracted memories missing embeddings — run: agentbridge-embed"
      fi
    fi
  fi
fi

# 10. Heartbeat liveness (startup check — was previous session's heartbeat healthy?)
LOCK_FILE="$AB/bridge.lock"
if [ -f "$LOCK_FILE" ]; then
  HB_TS=$(python3 -c "import json; print(json.load(open('$LOCK_FILE')).get('lastHeartbeat',0))" 2>/dev/null || echo 0)
  if [ "$HB_TS" -gt 0 ]; then
    HB_AGE=$(( ($(date +%s) - HB_TS / 1000) / 60 ))
    if [ "$HB_AGE" -gt 15 ]; then
      warn "heartbeat was stale before restart (last tick ${HB_AGE}min ago) — heartbeat may have stopped"
    fi
  fi
fi

# 11. Core files size check (should be ≤15 non-empty lines each)
for f in "$AB/core/user_profile.md" "$AB/core/agent_notes.md" "$AB/core/core_facts.md"; do
  if [ -f "$f" ]; then
    LINES=$(grep -c '[^[:space:]]' "$f")
    if [ "$LINES" -gt 15 ]; then
      warn "$(basename "$f") has $LINES non-empty lines (limit: 10) — Dreamy may have overgrown it"
    fi
  fi
done

# 12. Schema version check
if [ -f "$DB" ]; then
  SCHEMA_VER=$(sqlite3 "$DB" "SELECT version FROM schema_version LIMIT 1" 2>/dev/null || echo 0)
  if [ "$SCHEMA_VER" -lt 8 ]; then
    warn "memory.db schema version is $SCHEMA_VER (expected ≥8) — ABM v2 migration pending"
  fi
fi

# 13. .env.memory exists
if [ ! -f "$AB/.env.memory" ]; then
  warn ".env.memory missing — ABM config defaults will be used"
fi

# 14. Orphaned kiro-cli processes
KIRO_PROCS=$(pgrep -f 'kiro-cli acp' 2>/dev/null | wc -l)
if [ "$KIRO_PROCS" -gt 1 ]; then
  if $FIX; then
    # Keep the newest, kill the rest
    PIDS=$(pgrep -f 'kiro-cli acp' 2>/dev/null | sort -n)
    NEWEST=$(echo "$PIDS" | tail -1)
    for pid in $PIDS; do
      if [ "$pid" != "$NEWEST" ]; then
        kill "$pid" 2>/dev/null && fix "killed orphaned kiro-cli acp (pid $pid)"
      fi
    done
  else
    warn "$KIRO_PROCS kiro-cli acp processes running — likely orphans from previous bridge"
  fi
fi

# 12b. Orphaned agentbridge-sleep processes
SLEEP_PROCS=$(pgrep -f 'agentbridge-sleep' 2>/dev/null | wc -l)
if [ "$SLEEP_PROCS" -gt 1 ]; then
  if $FIX; then
    PIDS=$(pgrep -f 'agentbridge-sleep' 2>/dev/null | sort -n)
    NEWEST=$(echo "$PIDS" | tail -1)
    for pid in $PIDS; do
      if [ "$pid" != "$NEWEST" ]; then
        kill "$pid" 2>/dev/null && fix "killed orphaned agentbridge-sleep (pid $pid)"
      fi
    done
  else
    warn "$SLEEP_PROCS agentbridge-sleep processes running — likely orphans"
  fi
fi

# 13. Full fixes (--fix-full only)
if $FIX_FULL && [ -f "$DB" ]; then
  sqlite3 "$DB" "INSERT INTO messages_fts(messages_fts) VALUES('rebuild');" 2>/dev/null && fix "rebuilt messages_fts index"
  sqlite3 "$DB" "INSERT INTO extracted_memories_fts(extracted_memories_fts) VALUES('rebuild');" 2>/dev/null && fix "rebuilt extracted_memories_fts index"
  sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null && fix "WAL checkpoint (truncate)"
fi

if $FIX_FULL; then
  cd "$AB"
  if [ -d .git ]; then
    if ! git remote get-url origin &>/dev/null; then
      warn "git remote 'origin' missing — backup push will fail"
    elif ! timeout 5 git push --dry-run &>/dev/null; then
      warn "git push would fail — check upstream/auth"
    fi
  fi
fi

# Summary
if $FIX || $FIX_FULL; then
  echo "[doctor] Done. $FIXES fixes applied, $WARNS warnings."
else
  if [ "$WARNS" -eq 0 ]; then
    echo "[doctor] All clear."
  else
    echo "[doctor] $WARNS warning(s). Run with --fix or --fix-full to repair."
  fi
fi
