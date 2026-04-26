#!/usr/bin/env bash
# doctor.sh -- health check and repair for ~/.agentbridge
#
# Usage:
#   doctor.sh              # diagnose only -- prints warnings, changes nothing
#   doctor.sh --fix        # safe fixes (chmod, mkdir, stale locks, stale sleep locks)
#   doctor.sh --fix-full   # all safe fixes + FTS rebuild, WAL checkpoint, git push check
set -uo pipefail

AB="$HOME/.agentbridge"
ABMIND="${ABMIND_HOME:-$HOME/.abmind}"
DB="$ABMIND/memory/memory.db"
FIX=false
FIX_FULL=false
WARNS=0
FIXES=0

case "${1:-}" in
  --fix-full) FIX=true; FIX_FULL=true ;;
  --fix)      FIX=true ;;
esac

# Read install mode (simple skips supervisor checks)
INSTALL_MODE=$(head -n1 "$AB/install-mode" 2>/dev/null || echo "supervised")
INSTALL_MODE=$(echo "$INSTALL_MODE" | tr -d '[:space:]')
if [[ "$INSTALL_MODE" != "simple" && "$INSTALL_MODE" != "supervised" ]]; then
  INSTALL_MODE="supervised"
fi

warn() { echo "[doctor] WARN: $1"; WARNS=$((WARNS + 1)); }
fix()  { echo "[doctor] FIX:  $1"; FIXES=$((FIXES + 1)); }

# Helper: read JSON field via python3
json_field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],sys.argv[3]))" "$1" "$2" "${3:-0}" 2>/dev/null || echo "${3:-0}"; }

# ── Manifest reconciliation (install-time state) ────────────────────────────
MANIFEST="$AB/current/install-manifest.json"
if [ -f "$MANIFEST" ] && command -v python3 &>/dev/null; then
  MANIFEST_FIX_FLAG=""
  if $FIX; then MANIFEST_FIX_FLAG="--fix"; fi
  python3 -c "
import json, os, sys, shutil, stat

manifest = json.load(open('$MANIFEST'))
home = '$AB'
fix_mode = '--fix' in sys.argv

for d in manifest.get('directories', []):
    p = os.path.join(home, d['path'])
    mode = d.get('mode')
    if os.path.isdir(p):
        if mode:
            actual = oct(os.stat(p).st_mode & 0o777)
            expected = oct(int(mode, 8))
            if actual != expected:
                if fix_mode:
                    os.chmod(p, int(mode, 8))
                    print(f'[manifest] FIX: {d[\"path\"]}/ permissions {actual} -> {expected}')
                else:
                    print(f'[manifest] WARN: {d[\"path\"]}/ permissions {actual}, expected {expected}')
        else:
            print(f'[manifest] OK: {d[\"path\"]}/')
    elif fix_mode:
        os.makedirs(p, mode=int(mode, 8) if mode else 0o755, exist_ok=True)
        print(f'[manifest] FIX: created {d[\"path\"]}/')
    else:
        print(f'[manifest] WARN: {d[\"path\"]}/ MISSING')

for req in manifest.get('requiredConfigs', []):
    p = os.path.join(home, req['path'])
    if os.path.exists(p):
        print(f'[manifest] OK: {req[\"path\"]}')
    else:
        print(f'[manifest] WARN: {req[\"path\"]} MISSING -- {req[\"remediation\"]}')
" $MANIFEST_FIX_FLAG 2>/dev/null || echo "[manifest] check skipped (python3 error)"
else
  echo "[manifest] check skipped (manifest not found or python3 missing)"
fi

# ── Watchdog health (supervised mode only) ───────────────────────────────────

if [[ "$INSTALL_MODE" == "supervised" ]]; then

WD_LOCK="$AB/watchdog.lock"
WD_PID=""
WD_ALIVE=false
if [ -f "$WD_LOCK" ]; then
  WD_PID=$(json_field "$WD_LOCK" pid 0)
  WD_LAST=$(json_field "$WD_LOCK" lastCheck 0)
  if [ "$WD_PID" -gt 0 ] 2>/dev/null && kill -0 "$WD_PID" 2>/dev/null; then
    WD_ALIVE=true
    # Check lastCheck freshness (should be < 2 min old)
    if [ "$WD_LAST" -gt 0 ]; then
      WD_AGE=$(( ($(date +%s) - WD_LAST / 1000) ))
      if [ "$WD_AGE" -gt 120 ]; then
        warn "watchdog stale -- last check ${WD_AGE}s ago"
      fi
    fi
  else
    # Watchdog PID dead — check if bridge also dead (circuit breaker?)
    BRIDGE_PID=$(json_field "$AB/bridge.lock" pid 0 2>/dev/null)
    if [ "$BRIDGE_PID" -gt 0 ] 2>/dev/null && ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
      warn "watchdog and bridge both dead -- circuit breaker may have tripped. Check $AB/logs/watchdog.log"
    else
      warn "watchdog not running (PID $WD_PID dead)"
    fi
    if $FIX; then
      if [[ "$(uname)" == "Darwin" ]] && launchctl list 2>/dev/null | grep -q agentbridge.watchdog; then
        launchctl kickstart -k "gui/$(id -u)/com.agentbridge.watchdog" 2>/dev/null && fix "restarted watchdog via LaunchAgent"
      elif command -v systemctl &>/dev/null && systemctl --user is-enabled agentbridge-watchdog.service &>/dev/null; then
        systemctl --user restart agentbridge-watchdog.service 2>/dev/null && fix "restarted watchdog via systemd"
      else
        warn "watchdog not running -- start manually: ~/.agentbridge/watchdog.sh --all --web --agent &"
      fi
    fi
  fi
else
  warn "watchdog.lock missing -- watchdog not running"
  if $FIX; then
    if [[ "$(uname)" == "Darwin" ]] && launchctl list 2>/dev/null | grep -q agentbridge.watchdog; then
      launchctl kickstart -k "gui/$(id -u)/com.agentbridge.watchdog" 2>/dev/null && fix "started watchdog via LaunchAgent"
    elif command -v systemctl &>/dev/null && systemctl --user is-enabled agentbridge-watchdog.service &>/dev/null; then
      systemctl --user start agentbridge-watchdog.service 2>/dev/null && fix "started watchdog via systemd"
    else
      warn "start manually: ~/.agentbridge/watchdog.sh --all --web --agent &"
    fi
  fi
fi

# LaunchAgent / systemd check (supervised mode only)
if [[ "$INSTALL_MODE" == "supervised" ]]; then
if [[ "$(uname)" == "Darwin" ]]; then
  if ! launchctl list 2>/dev/null | grep -q agentbridge.watchdog; then
    if $FIX_FULL; then
      PLIST_SRC="$(dirname "$0")/com.agentbridge.watchdog.plist"
      PLIST_DST="$HOME/Library/LaunchAgents/com.agentbridge.watchdog.plist"
      if [ -f "$PLIST_SRC" ]; then
        cp "$PLIST_SRC" "$PLIST_DST"
        launchctl load "$PLIST_DST" 2>/dev/null && fix "installed and loaded watchdog LaunchAgent"
      else
        warn "watchdog LaunchAgent not loaded -- plist not found at $PLIST_SRC"
      fi
    else
      warn "watchdog LaunchAgent not loaded -- run with --fix-full to install"
    fi
  fi
elif command -v systemctl &>/dev/null; then
  if ! systemctl --user is-enabled agentbridge-watchdog.service &>/dev/null 2>&1; then
    if $FIX_FULL; then
      SVC_SRC="$(dirname "$0")/agentbridge-watchdog.service"
      SVC_DST="$HOME/.config/systemd/user/agentbridge-watchdog.service"
      if [ -f "$SVC_SRC" ]; then
        mkdir -p "$(dirname "$SVC_DST")"
        cp "$SVC_SRC" "$SVC_DST"
        systemctl --user daemon-reload
        systemctl --user enable --now agentbridge-watchdog.service 2>/dev/null && fix "installed and enabled watchdog systemd unit"
      else
        warn "watchdog systemd unit not enabled -- service file not found at $SVC_SRC"
      fi
    else
      warn "watchdog systemd unit not enabled -- run with --fix-full to install"
    fi
  fi
fi
fi # end supervised-only watchdog block
fi # end supervised-only supervisor check

# 0. Migrate titok/ → secret/ (one-time)
if [ -d "$AB/titok" ] && [ ! -d "$AB/secret" ]; then
  if $FIX || $FIX_FULL; then
    mv "$AB/titok" "$AB/secret"
    chmod 700 "$AB/secret"
    fix "migrated titok/ → secret/"
  else
    warn "titok/ should be renamed to secret/ — run with --fix"
  fi
fi

# 1. Directory permissions (sensitive dirs should be 700) -- fix-full only
for d in "$AB/secret" "$AB/secret/cookies" "$ABMIND/memory"; do
  if [ -d "$d" ] && [ "$(stat -c %a "$d" 2>/dev/null)" != "700" ]; then
    if $FIX_FULL; then
      chmod 700 "$d"; fix "$d permissions → 700"
    else
      warn "$d permissions not 700"
    fi
  fi
done

# 2. Stale lock files (older than 1 hour) — skip bridge.lock if watchdog is alive
while IFS= read -r f; do
  if $WD_ALIVE && [[ "$f" == *"bridge.lock"* ]]; then
    continue  # watchdog owns bridge.lock lifecycle
  fi
  if $FIX; then
    rm -f "$f"; fix "removed stale lock $f"
  else
    warn "stale lock: $f"
  fi
done < <(find "$AB" -name "*.lock" -not -path "*/sleep/*" -not -path "*/node_modules/*" -not -name "watchdog.lock" -mmin +60 2>/dev/null)

# 3. Stale sleep lock (older than 2 hours, no matching audit .md)
for lockfile in "$ABMIND/memory/sleep"/sleep_*.lock; do
  [ -f "$lockfile" ] || continue
  lockage=$(( ($(date +%s) - $(stat -c %Y "$lockfile" 2>/dev/null || echo 0)) / 60 ))
  if [ "$lockage" -gt 120 ]; then
    base=$(basename "$lockfile" .lock)
    if ! ls "$ABMIND/memory/sleep/${base}"_*.md &>/dev/null; then
      if $FIX; then
        rm -f "$lockfile"; fix "removed stale sleep lock $lockfile ${lockage}min old, no audit"
      else
        warn "stale sleep lock: $lockfile ${lockage}min old, no audit -- sleep may have hung"
      fi
    fi
  fi
done

# 4. Cookie file exists and is valid JSON
COOKIE="$AB/secret/cookies/x-cookies.json"
if [ -f "$COOKIE" ]; then
  if ! python3 -c "import json; json.load(open('$COOKIE'))" 2>/dev/null; then
    warn "$COOKIE is not valid JSON -- cookie auth will fail"
  fi
else
  warn "no X cookies found -- tweet replies/discovery won't work"
fi

# 5. Required dirs exist
for d in "$AB/twitterX" "$AB/twitterX/output" "$AB/skills" "$AB/logs" "$ABMIND/memory/sleep" "$ABMIND/memory/retrospectives"; do
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
  warn "base.follows.json missing -- tweet feed won't run"
fi

# 7. Recent backup check
BACKUP_DIR="$HOME/.backup-agentbridge"
if [ -d "$BACKUP_DIR" ]; then
  LATEST=$(find "$BACKUP_DIR" -name "agentbridge-*.zip" -mtime -2 2>/dev/null | head -1)
  if [ -z "$LATEST" ]; then
    warn "no backup in last 2 days -- check daily-backup.sh cron"
  fi
else
  warn "backup dir $BACKUP_DIR missing -- backups never ran"
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
    warn "memory.db is ${DB_MB}MB -- approaching 500MB disk budget"
  fi

  LATEST_SLEEP=$(find "$ABMIND/memory/sleep" -name "sleep_*.md" -mtime -3 2>/dev/null | head -1)
  if [ -z "$LATEST_SLEEP" ]; then
    warn "no sleep audit in last 3 days -- GC/consolidation not running"
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
        EMBEDDING_ENABLED=true node "$(dirname "$0")/../dist/cli/abmind.js" embed 2>/dev/null && fix "batch-embedded $NULL_EMBEDS memories"
      else
        warn "$NULL_EMBEDS extracted memories missing embeddings -- run: abmind embed"
      fi
    fi
  fi
fi

# 10. Heartbeat liveness (startup check -- was previous session's heartbeat healthy?)
LOCK_FILE="$AB/bridge.lock"
if [ -f "$LOCK_FILE" ]; then
  HB_TS=$(json_field "$LOCK_FILE" lastHeartbeat 0)
  if [ "$HB_TS" -gt 0 ]; then
    HB_AGE=$(( ($(date +%s) - HB_TS / 1000) / 60 ))
    if [ "$HB_AGE" -gt 15 ]; then
      warn "heartbeat was stale before restart last tick ${HB_AGE}min ago -- heartbeat may have stopped"
    fi
  fi
  # sleepStatus daytime check (macOS only)
  if [[ "$(uname)" == "Darwin" ]]; then
    SLEEP_STATUS=$(json_field "$LOCK_FILE" sleepStatus awake)
    HOUR=$(date +%H)
    if [ "$SLEEP_STATUS" = "hw_sleep" ] && [ "$HOUR" -ge 8 ] && [ "$HOUR" -le 23 ]; then
      warn "sleepStatus is hw_sleep but it is daytime (${HOUR}:00) -- Mac should be awake"
    fi
  fi
fi

# 11. Core files size check (should be ≤15 non-empty lines each)
for f in "$AB/core/user_profile.md" "$AB/core/agent_notes.md" "$AB/core/core_facts.md"; do
  if [ -f "$f" ]; then
    LINES=$(grep -c '[^[:space:]]' "$f")
    if [ "$LINES" -gt 15 ]; then
      FNAME=$(basename "$f"); warn "$FNAME has $LINES non-empty lines limit: 10 -- Dreamy may have overgrown it"
    fi
  fi
done

# 12. Schema version check
if [ -f "$DB" ]; then
  SCHEMA_VER=$(sqlite3 "$DB" "SELECT version FROM schema_version LIMIT 1" 2>/dev/null || echo 0)
  if [ "$SCHEMA_VER" -lt 8 ]; then
    warn "memory.db schema version is $SCHEMA_VER expected >=8 -- ABM v2 migration pending"
  fi
fi

# 13. .env.memory exists (in abmind home)
ABMIND="${ABMIND_HOME:-$HOME/.abmind}"
if [ ! -f "$ABMIND/config/.env.memory" ]; then
  warn ".env.memory missing at $ABMIND/config/ -- ABM config defaults will be used"
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
        kill "$pid" 2>/dev/null && fix "killed orphaned kiro-cli acp pid $pid"
      fi
    done
  else
    warn "$KIRO_PROCS kiro-cli acp processes running -- likely orphans from previous bridge"
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
        kill "$pid" 2>/dev/null && fix "killed orphaned agentbridge-sleep pid $pid"
      fi
    done
  else
    warn "$SLEEP_PROCS agentbridge-sleep processes running -- likely orphans"
  fi
fi

# 15. Orphaned agentbridge.sh wrappers (not parented by watchdog)
if $WD_ALIVE && [ -n "$WD_PID" ]; then
  WRAPPER_ORPHANS=0
  while IFS= read -r pid; do
    PPID_OF=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ "$PPID_OF" != "$WD_PID" ]; then
      WRAPPER_ORPHANS=$((WRAPPER_ORPHANS + 1))
      if $FIX; then
        kill "$pid" 2>/dev/null && fix "killed orphaned agentbridge.sh wrapper pid $pid (parent $PPID_OF, not watchdog $WD_PID)"
      fi
    fi
  done < <(pgrep -f 'agentbridge.sh.*--all' 2>/dev/null)
  if [ "$WRAPPER_ORPHANS" -gt 0 ] && ! $FIX; then
    warn "$WRAPPER_ORPHANS orphaned agentbridge.sh wrapper(s) not parented by watchdog"
  fi
fi

# 13. Full fixes (--fix-full only)
if $FIX_FULL && [ -f "$DB" ]; then
  sqlite3 "$DB" 'INSERT INTO messages_fts(messages_fts) VALUES('"'"'rebuild'"'"');' 2>/dev/null && fix "rebuilt messages_fts index"
  sqlite3 "$DB" 'INSERT INTO extracted_memories_fts(extracted_memories_fts) VALUES('"'"'rebuild'"'"');' 2>/dev/null && fix "rebuilt extracted_memories_fts index"
  sqlite3 "$DB" 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null && fix "WAL checkpoint truncate"
fi

if $FIX_FULL; then
  cd "$AB"
  if [ -d .git ]; then
    if ! git remote get-url origin &>/dev/null; then
      warn "git remote 'origin' missing -- backup push will fail"
    elif ! timeout 5 git push --dry-run &>/dev/null; then
      warn "git push would fail -- check upstream/auth"
    fi
  fi
fi

# Summary
if $FIX_FULL && [ -f "$AB/logs/watchdog.log" ]; then
  echo ""
  echo "[doctor] Last 10 lines of watchdog.log:"
  tail -10 "$AB/logs/watchdog.log" | sed 's/^/  /'
fi

if $FIX || $FIX_FULL; then
  echo "[doctor] Done. $FIXES fixes applied, $WARNS warnings."
else
  if [ "$WARNS" -eq 0 ]; then
    echo "[doctor] All clear."
  else
    echo "[doctor] $WARNS warnings. Run with --fix or --fix-full to repair."
  fi
fi

exit $(( WARNS > 0 ? 1 : 0 ))
