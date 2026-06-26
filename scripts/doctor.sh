#!/usr/bin/env bash
# doctor.sh -- health check and repair for ~/.abtars
#
# Usage:
#   doctor.sh              # diagnose only -- prints warnings, changes nothing
#   doctor.sh --fix        # safe fixes (chmod, mkdir, stale locks, watchdog install, delegate to abmind)
set -uo pipefail

AB="$HOME/.abtars"
ABMIND="${ABMIND_HOME:-$HOME/.abmind}"
DB="$ABMIND/memory/memory.db"
FIX=false
WARNS=0
FIXES=0
ERRS=0

case "${1:-}" in
  --fix|--fix) FIX=true ;;
esac

warn() { echo "[doctor] WARN: $1"; WARNS=$((WARNS + 1)); }
err()  { echo "[doctor] ERR:  $1"; ERRS=$((ERRS + 1)); }
fix()  { echo "[doctor] FIX:  $1"; FIXES=$((FIXES + 1)); }

# Helper: read JSON field via python3
json_field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],sys.argv[3]))" "$1" "$2" "${3:-0}" 2>/dev/null || echo "${3:-0}"; }

# Read install mode from manifest — MANDATORY
INSTALL_MODE=$(json_field "$AB/manifest.json" installMode "")
if [[ -z "$INSTALL_MODE" ]]; then
  echo "[doctor] FATAL: installMode not set in manifest.json. Run 'abtars install' first." >&2
  exit 1
fi
if [[ "$INSTALL_MODE" != "simple" && "$INSTALL_MODE" != "daemon" ]]; then
  echo "[doctor] FATAL: invalid installMode '$INSTALL_MODE' in manifest.json." >&2
  exit 1
fi

# Helper: cross-platform file mode (replaces stat -c %a which fails on macOS)
file_mode() { python3 -c "import os; print(oct(os.stat('$1').st_mode & 0o777)[2:])" 2>/dev/null; }

# Version header
DOCTOR_VERSION=$(json_field "$AB/manifest.json" version "unknown")
echo "abtars doctor v${DOCTOR_VERSION}"

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
MANIFEST="$AB/app/install-manifest.json"
if [ -f "$MANIFEST" ] && command -v python3 &>/dev/null; then
  MANIFEST_FIX_FLAG=""
  if $FIX; then MANIFEST_FIX_FLAG="--fix"; fi
  python3 -c "
import json, os, sys, shutil, stat

manifest = json.load(open('$MANIFEST'))
home = '$AB'
fix_mode = '--fix' in sys.argv

for d in manifest.get('directories', []):
    if isinstance(d, str): d = {'path': d}
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

if [[ "$INSTALL_MODE" == "daemon" ]]; then

WD_PID=""
WD_ALIVE=false
if [ -f "$AB/bridge.lock" ]; then
  WD_PID=$(json_field "$AB/bridge.lock" watchdogPid 0)
  if [ "$WD_PID" -gt 0 ] 2>/dev/null && kill -0 "$WD_PID" 2>/dev/null; then
    WD_ALIVE=true
  else
    if [ "$WD_PID" -gt 0 ] 2>/dev/null; then
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
          warn "watchdog not running -- start manually: ~/.abtars/scripts/abtars-watchdog.sh &"
        fi
      fi
    fi
  fi
else
  warn "bridge.lock missing -- watchdog status unknown"
  if $FIX; then
    if [[ "$(uname)" == "Darwin" ]] && launchctl list 2>/dev/null | grep -q abtars.watchdog; then
      launchctl kickstart -k "gui/$(id -u)/com.abtars.watchdog" 2>/dev/null && fix "started watchdog via LaunchAgent"
    elif command -v systemctl &>/dev/null && systemctl --user is-enabled abtars-watchdog.service &>/dev/null; then
      systemctl --user start abtars-watchdog.service 2>/dev/null && fix "started watchdog via systemd"
    else
      warn "start manually: ~/.abtars/scripts/abtars-watchdog.sh &"
    fi
  fi
fi

# Deploy lock staleness check
DEPLOY_LOCK="$AB/deploy.lock"
if [ -f "$DEPLOY_LOCK" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$DEPLOY_LOCK" 2>/dev/null || stat -f %m "$DEPLOY_LOCK" 2>/dev/null) ))
  if [ "$LOCK_AGE" -gt 300 ]; then
    LOCK_PID=$(json_field "$DEPLOY_LOCK" pid 0)
    if ! kill -0 "$LOCK_PID" 2>/dev/null; then
      if $FIX; then
        rm -f "$DEPLOY_LOCK"
        fix "removed stale deploy.lock (pid $LOCK_PID dead, ${LOCK_AGE}s old)"
      else
        warn "stale deploy.lock (pid $LOCK_PID dead, ${LOCK_AGE}s old) — run with --fix"
      fi
    else
      warn "deploy.lock held by pid $LOCK_PID for ${LOCK_AGE}s — may be hung"
    fi
  fi
fi

# LaunchAgent / systemd check (supervised mode only)
if [[ "$INSTALL_MODE" == "daemon" ]]; then
if [[ "$(uname)" == "Darwin" ]]; then
  if ! launchctl list 2>/dev/null | grep -q abtars.watchdog; then
    if $FIX; then
      PLIST_SRC="$(dirname "$0")/com.abtars.watchdog.plist"
      PLIST_DST="$HOME/Library/LaunchAgents/com.abtars.watchdog.plist"
      if [ -f "$PLIST_SRC" ]; then
        sed "s|{{HOME}}|$HOME|g" "$PLIST_SRC" > "$PLIST_DST"
        launchctl load "$PLIST_DST" 2>/dev/null && fix "installed and loaded watchdog LaunchAgent"
      else
        warn "watchdog LaunchAgent not loaded -- plist not found at $PLIST_SRC"
      fi
    else
      warn "watchdog LaunchAgent not loaded -- run with --fix to install"
    fi
  fi
elif command -v systemctl &>/dev/null; then
  if ! systemctl --user is-enabled abtars-watchdog.service &>/dev/null 2>&1; then
    if $FIX; then
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
      warn "watchdog systemd unit not enabled -- run with --fix to install"
    fi
  fi
fi
fi # end supervised-only watchdog block
fi # end supervised-only supervisor check

# 0a. Orphan process detection (cross-platform, compares against bridge.lock)
if [ -f "$AB/bridge.lock" ]; then
  EXPECTED_WD=$(json_field "$AB/bridge.lock" watchdogPid 0)
  EXPECTED_BR=$(json_field "$AB/bridge.lock" pid 0)

  # All abtars-related processes (bracket trick excludes grep itself)
  ALL_PROCS=$(ps ax -o pid,args 2>/dev/null | grep "[a]btars" | grep -v "doctor\|patchright" || true)

  # Orphan watchdogs: any abtars-watchdog.sh PID not matching bridge.lock or its children
  WD_PIDS=$(echo "$ALL_PROCS" | grep "abtars-watchdog.sh" | awk '{print $1}' || true)
  for P in $WD_PIDS; do
    [[ "$P" == "$EXPECTED_WD" ]] && continue
    # Skip subshells of the expected watchdog (PPID = expected WD)
    P_PPID=$(ps -o ppid= -p "$P" 2>/dev/null | tr -d ' ')
    [[ "$P_PPID" == "$EXPECTED_WD" ]] && continue
    err "orphan watchdog process PID $P (expected: $EXPECTED_WD)"
    if [[ "$FIX" == "1" ]]; then kill "$P" 2>/dev/null && fix "killed orphan watchdog $P"; fi
  done

  # Orphan bridges: any abtars.js PID not matching bridge.lock (exclude cli/tweet/embed)
  BR_PIDS=$(echo "$ALL_PROCS" | grep "abtars.js" | grep -v "cli\|tweet\|embed" | awk '{print $1}' || true)
  for P in $BR_PIDS; do
    [[ "$P" == "$EXPECTED_BR" ]] && continue
    err "orphan bridge process PID $P (expected: $EXPECTED_BR)"
    if [[ "$FIX" == "1" ]]; then kill "$P" 2>/dev/null && fix "killed orphan bridge $P"; fi
  done
fi

# 0b. Bridge PID consistency (bridge.lock vs actual process)
if [ -f "$AB/bridge.lock" ]; then
  LOCK_BRIDGE_PID=$(json_field "$AB/bridge.lock" pid 0)
  if [[ "$LOCK_BRIDGE_PID" != "0" ]]; then
    if kill -0 "$LOCK_BRIDGE_PID" 2>/dev/null; then
      PROC_CMD=$(ps -p "$LOCK_BRIDGE_PID" -o args= 2>/dev/null || true)
      if [[ "$PROC_CMD" != *"abtars.js"* ]]; then
        warn "bridge.lock PID $LOCK_BRIDGE_PID is not abtars (recycled PID: ${PROC_CMD:0:40})"
      fi
    fi
  fi

  # 0c. Bridge uptime
  STARTED_AT=$(json_field "$AB/bridge.lock" startedAt 0)
  if [[ "$STARTED_AT" != "0" ]]; then
    UPTIME_SEC=$(python3 -c "
import time
try:
    ts = int('$STARTED_AT')
    if ts > 1e12: ts = ts / 1000  # millis to seconds
    diff = int(time.time() - ts)
    h, m = divmod(diff // 60, 60)
    print(f'{h}h {m}m')
except: print('unknown')
" 2>/dev/null)
    echo "[doctor] bridge uptime: $UPTIME_SEC"
  fi
fi

# 0d. Circuit breaker state — recent restarts
STATE_FILE="$AB/watchdog.state"
if [ -f "$STATE_FILE" ]; then
  NOW=$(date +%s)
  RECENT=0
  while IFS= read -r ts; do
    [[ -z "$ts" ]] && continue
    (( NOW - ts < 1800 )) && RECENT=$((RECENT + 1))
  done < "$STATE_FILE"
  if (( RECENT >= 2 )); then
    warn "circuit breaker: $RECENT restarts in last 30min — recent instability"
  fi
fi

# 1. Directory permissions (sensitive dirs should be 700)
for d in "$AB/secret" "$AB/config"; do
  if [ -d "$d" ] && [ "$(file_mode "$d")" != "700" ]; then
    if $FIX; then
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

# 2b. Stale Unix sockets (left by dead bridge process)
BRIDGE_PID=$(json_field "$AB/bridge.lock" pid "0")
BRIDGE_ALIVE=false
if [[ "$BRIDGE_PID" != "0" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then BRIDGE_ALIVE=true; fi

for sock in "$AB/browser-socket/"*.sock "$AB/"*.sock "${ABMIND_HOME:-$HOME/.abmind}/"*.sock; do
  [ -S "$sock" ] || continue
  if $BRIDGE_ALIVE; then continue; fi
  if $FIX; then
    rm -f "$sock"; fix "removed stale socket $sock"
  else
    warn "stale socket: $sock"
  fi
done

# 3. Stale sleep lock (older than 2 hours, no matching audit .md)
for lockfile in "$ABMIND/memory/sleep"/sleep_*.lock; do
  [ -f "$lockfile" ] || continue
  lockage=$(( ($(date +%s) - $(stat -c %Y "$lockfile" 2>/dev/null || stat -f %m "$lockfile" 2>/dev/null || echo 0)) / 60 ))
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

  DB_SIZE=$(stat -c %s "$DB" 2>/dev/null || stat -f %z "$DB" 2>/dev/null || echo 0)
  if [ "$DB_SIZE" -gt 419430400 ]; then
    DB_MB=$((DB_SIZE / 1048576))
    warn "memory.db is ${DB_MB}MB -- approaching 500MB disk budget"
  fi

  LATEST_SLEEP=$(find "$ABMIND/memory/sleep" -name "sleep_*.md" -mtime -3 2>/dev/null | head -1)
  if [ -z "$LATEST_SLEEP" ]; then
    warn "no sleep audit in last 3 days -- GC/consolidation not running"
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
KIRO_PROCS=$(ps ax -o pid,args 2>/dev/null | grep '[k]iro-cli acp' | awk '{print $1}' | wc -l)
if [ "$KIRO_PROCS" -gt 1 ]; then
  if $FIX; then
    # Keep the newest, kill the rest
    PIDS=$(ps ax -o pid,args 2>/dev/null | grep '[k]iro-cli acp' | awk '{print $1}' | sort -n)
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

# 14b. Orphaned gemini-cli processes
GEMINI_PROCS=$(ps ax -o pid,args 2>/dev/null | grep '[g]emini.*--acp' | awk '{print $1}' | wc -l)
if [ "$GEMINI_PROCS" -gt 1 ]; then
  if $FIX; then
    PIDS=$(ps ax -o pid,args 2>/dev/null | grep '[g]emini.*--acp' | awk '{print $1}' | sort -n)
    NEWEST=$(echo "$PIDS" | tail -1)
    for pid in $PIDS; do
      if [ "$pid" != "$NEWEST" ]; then
        kill "$pid" 2>/dev/null && fix "killed orphaned gemini-cli pid $pid"
      fi
    done
  else
    warn "$GEMINI_PROCS gemini-cli acp processes running -- likely orphans from previous bridge"
  fi
fi

# 12b. Orphaned abtars-sleep processes
SLEEP_PROCS=$(ps ax -o pid,args 2>/dev/null | grep '[a]btars-sleep' | awk '{print $1}' | wc -l)
if [ "$SLEEP_PROCS" -gt 1 ]; then
  if $FIX; then
    PIDS=$(ps ax -o pid,args 2>/dev/null | grep '[a]btars-sleep' | awk '{print $1}' | sort -n)
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
  done < <(ps ax -o pid,args 2>/dev/null | grep '[a]btars.sh.*--all' | awk '{print $1}')
  if [ "$WRAPPER_ORPHANS" -gt 0 ] && ! $FIX; then
    warn "$WRAPPER_ORPHANS orphaned abtars.sh wrapper(s) not parented by watchdog"
  fi
fi

# 16a. Stale .start-reason check
START_REASON_FILE="$AB/.start-reason"
if [ -f "$START_REASON_FILE" ]; then
  SR_CONTENT=$(cat "$START_REASON_FILE" 2>/dev/null)
  if [[ "$SR_CONTENT" == update:* ]]; then
    SR_AGE=$(( $(date +%s) - $(stat -c %Y "$START_REASON_FILE" 2>/dev/null || stat -f %m "$START_REASON_FILE" 2>/dev/null || echo 0) ))
    if [ "$SR_AGE" -gt 300 ]; then
      warn "stale .start-reason ('$SR_CONTENT', ${SR_AGE}s old) — watchdog may refuse to start"
      if $FIX; then rm -f "$START_REASON_FILE" && fix "removed stale .start-reason"; fi
    fi
  fi
fi

# 16b. CLI reachable at ~/.local/bin/abtars
LOCAL_BIN="$HOME/.local/bin/abtars"
if [ ! -x "$LOCAL_BIN" ]; then
  warn "CLI not reachable at $LOCAL_BIN (run 'abtars update' to refresh wrappers)"
fi

# 16c. Rollback history available
HISTORY_FILE="$HOME/.abtars-releases/history.json"
if [ -f "$HISTORY_FILE" ]; then
  HISTORY_LEN=$(python3 -c "import json; print(len(json.load(open('$HISTORY_FILE'))))" 2>/dev/null || echo 0)
  if [ "$HISTORY_LEN" -le 1 ]; then
    warn "no rollback available (history.json has $HISTORY_LEN entries)"
  fi
elif [ -d "$HOME/.abtars-releases" ]; then
  warn "history.json missing — no rollback tracking"
fi

# 13. Delegate DB health to abmind doctor
if [ -d "$ABMIND" ] && command -v abmind &>/dev/null; then
  echo "[doctor] Delegating DB health to abmind doctor..."
  if $FIX; then
    abmind doctor --fix 2>&1 | sed 's/^/  [abmind] /'
  else
    abmind doctor 2>&1 | sed 's/^/  [abmind] /'
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
  done < <(ps ax -o pid,args 2>/dev/null | grep "[h]ooks/" | grep "$AB" | awk '{print $1}')
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
    if $FIX; then
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
      if $FIX; then
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
stale_media=$(find "$AB/received/media" -type f -mtime +"$LOGS_KEEP_DAYS" 2>/dev/null | wc -l)

audit_size=0
if [ -f "$AB/logs/audit.jsonl" ]; then
  audit_size=$(stat -c%s "$AB/logs/audit.jsonl" 2>/dev/null || stat -f%z "$AB/logs/audit.jsonl" 2>/dev/null || echo 0)
fi

total_stale=$((stale_logs + stale_overflow + stale_media))
if [ "$total_stale" -gt 0 ] || [ "$audit_size" -gt "$AUDIT_MAX_BYTES" ]; then
  if $FIX; then
    [ "$stale_logs" -gt 0 ] && find "$AB/logs" -type f -name "*.log" -mtime +"$LOGS_KEEP_DAYS" -delete && fix "deleted $stale_logs log file(s) older than ${LOGS_KEEP_DAYS}d"
    [ "$stale_overflow" -gt 0 ] && find "$AB/overflow" -type f -mtime +"$DATA_KEEP_DAYS" -delete && fix "deleted $stale_overflow overflow file(s) older than ${DATA_KEEP_DAYS}d"
    [ "$stale_media" -gt 0 ] && find "$AB/received/media" -type f -mtime +"$LOGS_KEEP_DAYS" -delete && fix "deleted $stale_media media file(s) older than ${LOGS_KEEP_DAYS}d"
    if [ "$audit_size" -gt "$AUDIT_MAX_BYTES" ]; then
      tail -5000 "$AB/logs/audit.jsonl" > "$AB/logs/audit.jsonl.tmp" && mv "$AB/logs/audit.jsonl.tmp" "$AB/logs/audit.jsonl"
      fix "audit.jsonl truncated (was $audit_size bytes)"
    fi
  else
    [ "$total_stale" -gt 0 ] && warn "$total_stale stale file(s) reclaimable (logs>${LOGS_KEEP_DAYS}d, overflow>${DATA_KEEP_DAYS}d, media>${LOGS_KEEP_DAYS}d)"
    [ "$audit_size" -gt "$AUDIT_MAX_BYTES" ] && warn "audit.jsonl is $audit_size bytes (>${AUDIT_MAX_BYTES})"
  fi
fi

# ── Duplicate bridge detection (#923) ──────────────────────────────────────────
BRIDGE_PIDS=$(ps ax -o pid,args 2>/dev/null | grep '[n]ode.*bundle/abtars.js' | awk '{print $1}' | sort -n)
if [ -z "$BRIDGE_PIDS" ]; then BRIDGE_COUNT=0; else BRIDGE_COUNT=$(echo "$BRIDGE_PIDS" | wc -l | tr -d ' '); fi
if [ "$BRIDGE_COUNT" -gt 1 ]; then
  warn "DUPLICATE BRIDGES: $BRIDGE_COUNT processes (PIDs: $(echo $BRIDGE_PIDS | tr '\n' ' '))"
  if $FIX; then
    LOCK_PID=$(json_field "$AB/bridge.lock" pid 0 2>/dev/null)
    for P in $BRIDGE_PIDS; do
      if [ "$P" != "$LOCK_PID" ]; then
        kill "$P" 2>/dev/null && fix "killed duplicate bridge PID $P (keeping $LOCK_PID)"
      fi
    done
  fi
elif [ "$BRIDGE_COUNT" -eq 1 ]; then
  : # single bridge — healthy
fi

# ── Port availability ──────────────────────────────────────────────────────
AGENT_API_PORT=$(grep -E '^AGENT_API_PORT=' "$AB/config/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "3100")
WEB_PORT=$(grep -E '^WEB_PORT=' "$AB/config/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "3000")

for PORT in $AGENT_API_PORT $WEB_PORT; do
  if command -v ss &>/dev/null; then
    PID=$(ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
  else
    PID=$(lsof -ti ":$PORT" 2>/dev/null || true)
  fi
  if [ -n "$PID" ]; then
    BRIDGE_PID=$(python3 -c "import json; print(json.load(open('$AB/bridge.lock'))['pid'])" 2>/dev/null || echo "")
    if [ "$PID" = "$BRIDGE_PID" ]; then
      continue
    fi
    CMDLINE=$(ps -p "$PID" -o args= 2>/dev/null || true)
    if echo "$CMDLINE" | grep -q "abtars\|\.abtars/app"; then
      if $FIX; then
        kill "$PID" 2>/dev/null && fix "killed stale abtars process $PID on port $PORT"
      else
        warn "port $PORT held by stale abtars process (PID $PID)"
      fi
    else
      warn "port $PORT held by another process (PID $PID: ${CMDLINE:0:60}). Change port in .env or stop the service."
    fi
  fi
done

# Docker availability check (#478 — sandbox mode)
if grep -qE "^SECURITY_MODE=docker" "$AB/config/.env" 2>/dev/null; then
  if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    ok "docker" "Docker available for sandbox mode"
  else
    warn "docker" "SECURITY_MODE=docker but Docker not available — sessions will run in-process"
  fi
fi

# Seatbelt availability check (#906)
if grep -qE "^SECURITY_MODE=seatbelt" "$AB/config/.env" 2>/dev/null; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    command -v sandbox-exec &>/dev/null && ok "seatbelt" "sandbox-exec available" || warn "seatbelt" "sandbox-exec not found"
  else
    command -v bwrap &>/dev/null && ok "seatbelt" "bwrap available" || warn "seatbelt" "bwrap not found (apt install bubblewrap)"
  fi
fi

# ── Heap memory check (#1060) ──────────────────────────────────────────────────
if [ -f "$AB/bridge.lock" ]; then
  HEAP_MB=$(python3 -c "import json; print(json.load(open('$AB/bridge.lock')).get('heapUsedMB', 0))" 2>/dev/null || echo 0)
  if [ "$HEAP_MB" -gt 900 ] 2>/dev/null; then
    err "heap-memory" "Heap critically high: ${HEAP_MB}MB / 1024MB"
  elif [ "$HEAP_MB" -gt 700 ] 2>/dev/null; then
    warn "heap-memory" "Heap elevated: ${HEAP_MB}MB / 1024MB"
  elif [ "$HEAP_MB" -gt 0 ] 2>/dev/null; then
    ok "heap-memory" "${HEAP_MB}MB / 1024MB"
  fi
  BOOT_TYPE=$(python3 -c "import json; print(json.load(open('$AB/bridge.lock')).get('bootType', 'unknown'))" 2>/dev/null || echo "unknown")
  ok "boot-type" "$BOOT_TYPE"
fi

# Plaintext secrets in .env
ENV_FILE="$AB/config/.env"
SECRETS_ENC="$AB/config/secrets.enc"
if [ -f "$SECRETS_ENC" ] && [ -f "$ENV_FILE" ]; then
  EXPOSED=$(grep -iE '_(TOKEN|KEY|SECRET|PASSWORD)=' "$ENV_FILE" | grep -v '^#' | cut -d= -f1 | tr '\n' ' ')
  if [ -n "$EXPOSED" ]; then
    warn "plaintext-secrets" "secrets.enc exists but .env still has: $EXPOSED— remove them from .env"
  fi
fi

# Summary
if $FIX && [ -f "$AB/logs/watchdog.log" ]; then
  echo ""
  echo "[doctor] Last 10 lines of watchdog.log:"
  tail -10 "$AB/logs/watchdog.log" | sed 's/^/  /'
fi

if $FIX; then
  echo "[doctor] Done. $FIXES fixes applied, $WARNS warnings, $ERRS errors."
else
  if [ "$WARNS" -eq 0 ] && [ "$ERRS" -eq 0 ]; then
    echo "[doctor] All clear."
  else
    echo "[doctor] $WARNS warnings, $ERRS errors. Run with --fix to repair."
  fi
fi

if $FIX; then exit 0; fi
exit $(( WARNS > 0 ? 1 : 0 ))
