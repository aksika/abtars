#!/usr/bin/env bash
# doctor.sh -- health check and repair for ~/.abtars
#
# Usage:
#   doctor.sh              # diagnose only -- prints warnings, changes nothing
#   doctor.sh --fix        # safe fixes (chmod, mkdir, stale locks, stale sleep locks)
#   doctor.sh --fix-full   # all safe fixes + FTS rebuild, WAL checkpoint, git push check
set -uo pipefail

AB="$HOME/.abtars"
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

warn() { echo "[doctor] WARN: $1"; WARNS=$((WARNS + 1)); }
fix()  { echo "[doctor] FIX:  $1"; FIXES=$((FIXES + 1)); }

# Helper: read JSON field via python3
json_field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],sys.argv[3]))" "$1" "$2" "${3:-0}" 2>/dev/null || echo "${3:-0}"; }

# Read install mode from manifest — MANDATORY
INSTALL_MODE=$(json_field "$AB/manifest.json" installMode "")
if [[ -z "$INSTALL_MODE" ]]; then
  echo "[doctor] FATAL: installMode not set in manifest.json. Run 'abtars install' first." >&2
  exit 1
fi
if [[ "$INSTALL_MODE" != "simple" && "$INSTALL_MODE" != "supervised" && "$INSTALL_MODE" != "supervised-daemon" ]]; then
  echo "[doctor] FATAL: invalid installMode '$INSTALL_MODE' in manifest.json." >&2
  exit 1
fi

# Helper: cross-platform file mode (replaces stat -c %a which fails on macOS)
file_mode() { python3 -c "import os; print(oct(os.stat('$1').st_mode & 0o777)[2:])" 2>/dev/null; }

# Helper: process age in seconds from ps -o etime= (POSIX, both macOS + Linux)
ps_age_seconds() {
  ps -o etime= -p "$1" 2>/dev/null | python3 -c "
import sys
t = sys.stdin.read().strip()
if not t: sys.exit(1)
parts = t.replace('-', ':').split(':')
mul = [1, 60, 3600, 86400]
print(sum(int(p) * m for p, m in zip(reversed(parts), mul)))
" 2>/dev/null
}

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

WD_ALIVE=false
WD_PID=""

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
      if [[ "$(uname)" == "Darwin" ]] && launchctl list 2>/dev/null | grep -q abtars.watchdog; then
        launchctl kickstart -k "gui/$(id -u)/com.abtars.watchdog" 2>/dev/null && fix "restarted watchdog via LaunchAgent"
      elif command -v systemctl &>/dev/null && systemctl --user is-enabled abtars-watchdog.service &>/dev/null; then
        systemctl --user restart abtars-watchdog.service 2>/dev/null && fix "restarted watchdog via systemd"
      else
        warn "watchdog not running -- start manually: ~/.abtars/watchdog.sh --all --web --agent &"
      fi
    fi
  fi
else
  warn "watchdog.lock missing -- watchdog not running"
  if $FIX; then
    if [[ "$(uname)" == "Darwin" ]] && launchctl list 2>/dev/null | grep -q abtars.watchdog; then
      launchctl kickstart -k "gui/$(id -u)/com.abtars.watchdog" 2>/dev/null && fix "started watchdog via LaunchAgent"
    elif command -v systemctl &>/dev/null && systemctl --user is-enabled abtars-watchdog.service &>/dev/null; then
      systemctl --user start abtars-watchdog.service 2>/dev/null && fix "started watchdog via systemd"
    else
      warn "start manually: ~/.abtars/watchdog.sh --all --web --agent &"
    fi
  fi
fi

# LaunchAgent / systemd check (supervised mode only)
if [[ "$INSTALL_MODE" == "supervised" || "$INSTALL_MODE" == "supervised-daemon" ]]; then
if [[ "$(uname)" == "Darwin" ]]; then
  if ! launchctl list 2>/dev/null | grep -q abtars.watchdog; then
    if $FIX || $FIX_FULL; then
      PLIST_SRC="$(dirname "$0")/com.abtars.watchdog.plist"
      PLIST_DST="$HOME/Library/LaunchAgents/com.abtars.watchdog.plist"
      if [ -f "$PLIST_SRC" ]; then
        sed "s|{{HOME}}|$HOME|g" "$PLIST_SRC" > "$PLIST_DST"
        launchctl load "$PLIST_DST" 2>/dev/null && fix "installed and loaded watchdog LaunchAgent"
      else
        warn "watchdog LaunchAgent not loaded -- plist not found at $PLIST_SRC"
      fi
    else
      warn "watchdog LaunchAgent not loaded -- run with --fix-full to install"
    fi
  fi
elif command -v systemctl &>/dev/null; then
  if ! systemctl --user is-enabled abtars-watchdog.service &>/dev/null 2>&1; then
    if $FIX_FULL; then
      SVC_SRC="$(dirname "$0")/abtars-watchdog.service"
      SVC_DST="$HOME/.config/systemd/user/abtars-watchdog.service"
      if [ -f "$SVC_SRC" ]; then
        mkdir -p "$(dirname "$SVC_DST")"
        cp "$SVC_SRC" "$SVC_DST"
        systemctl --user daemon-reload
        systemctl --user enable --now abtars-watchdog.service 2>/dev/null && fix "installed and enabled watchdog systemd unit"
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

# 1. Directory permissions (sensitive dirs should be 700)
for d in "$AB/secret" "$AB/secret/cookies" "$ABMIND/memory"; do
  if [ -d "$d" ] && [ "$(file_mode "$d")" != "700" ]; then
    if $FIX || $FIX_FULL; then
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

# 4. Cookie file exists and is valid JSON (only if cookies dir exists — optional feature)
COOKIE="$AB/secret/cookies/x-cookies.json"
if [ -f "$COOKIE" ]; then
  if head -c4 "$COOKIE" | grep -q "^ENC:"; then
    : # encrypted at rest — skip JSON validation
  elif ! python3 -c "import json; json.load(open('$COOKIE'))" 2>/dev/null; then
    warn "$COOKIE is not valid JSON -- cookie auth will fail"
  fi
fi

# 5. Required dirs exist
for d in "$AB/skills" "$AB/logs"; do
  if [ ! -d "$d" ]; then
    if $FIX; then
      mkdir -p "$d"; fix "created missing dir $d"
    else
      warn "missing dir: $d"
    fi
  fi
done

# 7. Recent backup check (skip on fresh installs)
BACKUP_DIR="$HOME/.backup-abtars"
if [ -d "$BACKUP_DIR" ]; then
  LATEST=$(find "$BACKUP_DIR" -name "abtars-*.zip" -mtime -2 2>/dev/null | head -1)
  if [ -z "$LATEST" ]; then
    warn "no backup in last 2 days -- check daily-backup.sh cron"
  fi
fi

# 8. Memory DB health (skip if DB doesn't exist yet — fresh install)
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
fi

# 9. Embedding health (only if EMBEDDING_ENABLED=true)
if grep -q "^EMBEDDING_ENABLED=true" "$AB/config/.env" "$AB/.env" 2>/dev/null; then
  if ! command -v ollama &>/dev/null; then
    warn "EMBEDDING_ENABLED but ollama not installed"
  elif ! curl -sf http://localhost:11434/api/tags &>/dev/null; then
    warn "EMBEDDING_ENABLED but ollama not running — start with: systemctl start ollama"
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

# 11. Core files size check (should be ≤50 non-empty lines each)
for f in "$AB/core/user_profile.md" "$AB/core/agent_notes.md" "$AB/core/core_facts.md"; do
  if [ -f "$f" ]; then
    LINES=$(grep -c '[^[:space:]]' "$f")
    if [ "$LINES" -gt 50 ]; then
      FNAME=$(basename "$f"); warn "$FNAME has $LINES non-empty lines (limit: 50) -- Dreamy may have overgrown it"
    fi
  fi
done

# 12. Schema version check (removed — schema managed by MemoryManager, no migration table)

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

# 12b. Orphaned abtars-sleep processes
SLEEP_PROCS=$(pgrep -f 'abtars-sleep' 2>/dev/null | wc -l)
if [ "$SLEEP_PROCS" -gt 1 ]; then
  if $FIX; then
    PIDS=$(pgrep -f 'abtars-sleep' 2>/dev/null | sort -n)
    NEWEST=$(echo "$PIDS" | tail -1)
    for pid in $PIDS; do
      if [ "$pid" != "$NEWEST" ]; then
        kill "$pid" 2>/dev/null && fix "killed orphaned abtars-sleep pid $pid"
      fi
    done
  else
    warn "$SLEEP_PROCS abtars-sleep processes running -- likely orphans"
  fi
fi

# 15. Orphaned abtars.sh wrappers (not parented by watchdog)
if $WD_ALIVE && [ -n "$WD_PID" ]; then
  WRAPPER_ORPHANS=0
  while IFS= read -r pid; do
    PPID_OF=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ "$PPID_OF" != "$WD_PID" ]; then
      WRAPPER_ORPHANS=$((WRAPPER_ORPHANS + 1))
      if $FIX; then
        kill "$pid" 2>/dev/null && fix "killed orphaned abtars.sh wrapper pid $pid (parent $PPID_OF, not watchdog $WD_PID)"
      fi
    fi
  done < <(pgrep -f 'abtars.sh.*--all' 2>/dev/null)
  if [ "$WRAPPER_ORPHANS" -gt 0 ] && ! $FIX; then
    warn "$WRAPPER_ORPHANS orphaned abtars.sh wrapper(s) not parented by watchdog"
  fi
fi

# 13. Full fixes (--fix-full only)
if $FIX_FULL && [ -f "$DB" ]; then
  sqlite3 "$DB" 'INSERT INTO messages_fts(messages_fts) VALUES('"'"'rebuild'"'"');' 2>/dev/null && fix "rebuilt messages_fts index"
  sqlite3 "$DB" 'INSERT INTO extracted_memories_fts(extracted_memories_fts) VALUES('"'"'rebuild'"'"');' 2>/dev/null && fix "rebuilt extracted_memories_fts index"
  sqlite3 "$DB" 'INSERT INTO extracted_memories_original_fts(extracted_memories_original_fts) VALUES('"'"'rebuild'"'"');' 2>/dev/null && fix "rebuilt extracted_memories_original_fts index"
  sqlite3 "$DB" 'INSERT INTO content_en_trigram(content_en_trigram) VALUES('"'"'rebuild'"'"');' 2>/dev/null && fix "rebuilt content_en_trigram index"
  sqlite3 "$DB" 'INSERT INTO content_original_trigram(content_original_trigram) VALUES('"'"'rebuild'"'"');' 2>/dev/null && fix "rebuilt content_original_trigram index"
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

# 16. Hooks health
HOOKS_CONFIG="$AB/config/hooks.json"

# 16a. hooks.json validity
if [ -f "$HOOKS_CONFIG" ]; then
  if ! python3 -c "import json; json.load(open('$HOOKS_CONFIG'))" 2>/dev/null; then
    warn "hooks.json is not valid JSON — hooks silently disabled"
  fi
fi

# 16b. Hooks dir permissions
if [ -d "$AB/hooks" ]; then
  HMODE=$(file_mode "$AB/hooks")
  if [ -n "$HMODE" ] && [ "$HMODE" != "700" ]; then
    if $FIX; then chmod 700 "$AB/hooks" && fix "hooks dir → 700"
    else warn "hooks dir mode $HMODE, expected 700 — hooks disabled"; fi
  fi
fi

# 16c. Referenced scripts exist + executable
if [ -f "$HOOKS_CONFIG" ]; then
  while IFS= read -r cmd; do
    [ -z "$cmd" ] && continue
    resolved="${cmd/#\~\/.abtars/$AB}"
    resolved="${resolved/#\~/$HOME}"
    if [ ! -f "$resolved" ]; then
      warn "hooks.json references missing script: $resolved"
    elif [ ! -x "$resolved" ]; then
      if $FIX; then chmod +x "$resolved" && fix "chmod +x $resolved"
      else warn "hook script not executable: $resolved"; fi
    fi
  done < <(python3 -c "
import json
try:
    c = json.load(open('$HOOKS_CONFIG'))
    for hooks in c.get('hooks', {}).values():
        for h in hooks or []:
            print(h.get('command', ''))
except Exception: pass
" 2>/dev/null)
fi

# 16d. Stuck hook processes (>60s)
if [ -d "$AB/hooks" ]; then
  while IFS= read -r pid; do
    AGE=$(ps_age_seconds "$pid")
    [ -z "$AGE" ] && continue
    if [ "$AGE" -gt 60 ]; then
      if $FIX; then
        kill -TERM "$pid" 2>/dev/null
        sleep 2
        kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
        fix "killed stuck hook $pid (${AGE}s)"
      else
        warn "stuck hook $pid (${AGE}s) — run with --fix"
      fi
    fi
  done < <(pgrep -f "$AB/hooks/" 2>/dev/null)
fi

# 16e. Hook log file size
if [ -d "$AB/logs" ]; then
  while IFS= read -r f; do
    warn "hook log large: $f ($(du -h "$f" | cut -f1)) — consider rotation"
  done < <(find "$AB/logs" -name '*.jsonl' -size +100M 2>/dev/null)
fi

# 17. Filesystem permissions (#441)
check_perm() {
  local path="$1" expected="$2" label="$3"
  if [ ! -e "$path" ]; then return; fi
  actual=$(stat -c "%a" "$path" 2>/dev/null || stat -f "%Lp" "$path" 2>/dev/null)
  if [ "$actual" != "$expected" ]; then
    warn "$label is $actual — should be $expected"
    if $FIX || $FIX_FULL; then
      chmod "$expected" "$path" && fix "$label → $expected"
    fi
  fi
}

check_perm "$AB" "700" "~/.abtars/"
check_perm "$AB/config" "700" "config/"
check_perm "$AB/secret" "700" "secret/"

# Check all files in config/ and secret/ are 600
for dir in "$AB/config" "$AB/secret"; do
  [ -d "$dir" ] || continue
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    actual=$(stat -c "%a" "$f" 2>/dev/null || stat -f "%Lp" "$f" 2>/dev/null)
    if [ "$actual" != "600" ]; then
      warn "$(basename "$f") in $(basename "$dir")/ is $actual — should be 600"
      if $FIX || $FIX_FULL; then
        chmod 600 "$f" && fix "$(basename "$f") → 600"
      fi
    fi
  done
done

# ── Retention policy (#297) ──────────────────────────────────────────────────
LOGS_KEEP_DAYS=7
DATA_KEEP_DAYS=30
AUDIT_MAX_BYTES=5242880  # 5MB

stale_logs=$(find "$AB/logs" -type f -name "*.log" -mtime +"$LOGS_KEEP_DAYS" 2>/dev/null | wc -l)
stale_overflow=$(find "$AB/overflow" -type f -mtime +"$DATA_KEEP_DAYS" 2>/dev/null | wc -l)
stale_reports=$(find "$AB/reports" -type f -mtime +"$DATA_KEEP_DAYS" 2>/dev/null | wc -l)
stale_media=$(find "$AB/received/media" -type f -mtime +"$LOGS_KEEP_DAYS" 2>/dev/null | wc -l)

audit_size=0
if [ -f "$AB/logs/audit.jsonl" ]; then
  audit_size=$(stat -c%s "$AB/logs/audit.jsonl" 2>/dev/null || stat -f%z "$AB/logs/audit.jsonl" 2>/dev/null || echo 0)
fi

total_stale=$((stale_logs + stale_overflow + stale_reports + stale_media))
if [ "$total_stale" -gt 0 ] || [ "$audit_size" -gt "$AUDIT_MAX_BYTES" ]; then
  if $FIX || $FIX_FULL; then
    [ "$stale_logs" -gt 0 ] && find "$AB/logs" -type f -name "*.log" -mtime +"$LOGS_KEEP_DAYS" -delete && fix "deleted $stale_logs log file(s) older than ${LOGS_KEEP_DAYS}d"
    [ "$stale_overflow" -gt 0 ] && find "$AB/overflow" -type f -mtime +"$DATA_KEEP_DAYS" -delete && fix "deleted $stale_overflow overflow file(s) older than ${DATA_KEEP_DAYS}d"
    [ "$stale_reports" -gt 0 ] && find "$AB/reports" -type f -mtime +"$DATA_KEEP_DAYS" -delete && fix "deleted $stale_reports report file(s) older than ${DATA_KEEP_DAYS}d"
    [ "$stale_media" -gt 0 ] && find "$AB/received/media" -type f -mtime +"$LOGS_KEEP_DAYS" -delete && fix "deleted $stale_media media file(s) older than ${LOGS_KEEP_DAYS}d"
    if [ "$audit_size" -gt "$AUDIT_MAX_BYTES" ]; then
      tail -5000 "$AB/logs/audit.jsonl" > "$AB/logs/audit.jsonl.tmp" && mv "$AB/logs/audit.jsonl.tmp" "$AB/logs/audit.jsonl"
      fix "audit.jsonl truncated (was $audit_size bytes)"
    fi
  else
    [ "$total_stale" -gt 0 ] && warn "$total_stale stale file(s) reclaimable (logs>${LOGS_KEEP_DAYS}d, overflow/reports>${DATA_KEEP_DAYS}d, media>${LOGS_KEEP_DAYS}d)"
    [ "$audit_size" -gt "$AUDIT_MAX_BYTES" ] && warn "audit.jsonl is $audit_size bytes (>${AUDIT_MAX_BYTES})"
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

if $FIX; then exit 0; fi
exit $(( WARNS > 0 ? 1 : 0 ))
