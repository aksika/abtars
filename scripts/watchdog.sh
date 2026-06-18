#!/usr/bin/env bash
# Abtars External Watchdog
# Spawns node directly, monitors bridge.lock heartbeat, kills+restarts on stale.
# Usage: watchdog.sh [bridge flags, e.g. --all --web --agent]
set -uo pipefail

AB="${ABTARS_HOME:-$HOME/.abtars}"
LOCK="$AB/bridge.lock"
LOG="$AB/logs/watchdog.log"
ENV_FILE="$AB/.env"

# ── Stop sentinel — if present, exit immediately (abtars stop was called) ──
if [[ -f "$AB/.stopped" ]]; then
  echo "$(date +%FT%T) Stopped sentinel found — refusing to start. Use 'abtars start' to resume." >> "$LOG"
  exit 0
fi

# ── Singleton enforcement via flock/lockf on sentinel file ──
if [[ "${ABTARS_WD_EXEC:-}" != "1" ]]; then
  exec 200>>"$AB/.bridge.flock"
  if command -v flock &>/dev/null; then
    flock -n 200 || { echo "Watchdog already running"; exit 0; }
  else
    lockf -s -t 0 200 || { echo "Watchdog already running"; exit 0; }
  fi
fi

POLL_SEC=60
STALE_SEC="${WATCHDOG_STALE_SEC:-360}"
HB_SEC=300
KILL_ON_STALE="false"
if [[ -f "$ENV_FILE" ]]; then
  _hb_sec=$(grep -m1 '^HEARTBEAT_INTERVAL_SEC=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
  if [[ -n "$_hb_sec" && "$_hb_sec" != "0" ]]; then
    HB_SEC="$_hb_sec"
  fi
  _kill=$(grep -m1 '^WATCHDOG_KILL_ON_STALE=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
  if [[ -n "$_kill" ]]; then KILL_ON_STALE="$_kill"; fi
  _grace=$(grep -m1 '^WATCHDOG_SUSPEND_GRACE=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
  if [[ -n "$_grace" ]]; then SUSPEND_GRACE="$_grace"; fi
fi
SUSPEND_GRACE="${SUSPEND_GRACE:-true}"
STARTUP_TIMEOUT=$(( HB_SEC + POLL_SEC * 2 ))
CIRCUIT_MAX=3
CIRCUIT_WINDOW=180
MAX_LOG_BYTES=10485760

BRIDGE_PID=""
SPAWNED_AT=0
RESTART_TIMES=()
RESTARTING=false
RESTART_STARTED_AT=0
PLANNED_RESTART=false
STATE_FILE="$AB/watchdog.state"

# Load persisted restart timestamps (filter stale entries)
if [[ -f "$STATE_FILE" ]]; then
  _now=$(date +%s)
  while IFS= read -r _ts; do
    if [[ -n "$_ts" ]] && (( _now - _ts < CIRCUIT_WINDOW )); then
      RESTART_TIMES+=("$_ts")
    fi
  done < "$STATE_FILE"
fi

# ── Load .env for Telegram notifications ──
TG_TOKEN=""
MAIN_CHAT_ID=""
if [[ -f "$ENV_FILE" ]]; then
  TG_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
  MAIN_CHAT_ID=$(grep -m1 '^MAIN_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
fi

mkdir -p "$AB/logs"

# ── Ensure nvm/node is available ──
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if ! command -v node &>/dev/null; then
  echo "FATAL: node not found" >&2
  exit 1
fi

log() {
  local ts
  ts=$(date '+%Y-%m-%dT%H:%M:%S')
  echo "$ts $1" >> "$LOG"
  echo "$ts $1"
}

notify() {
  if [[ -n "$TG_TOKEN" && -n "$MAIN_CHAT_ID" ]]; then
    curl -s "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      -d "chat_id=${MAIN_CHAT_ID}" -d "text=$1" >/dev/null 2>&1 || true
  fi
}

read_lock() {
  if [[ ! -f "$LOCK" ]]; then echo "ERR"; return; fi
  local content
  content=$(cat "$LOCK" 2>/dev/null) || { echo "ERR"; return; }
  local pid hb sleep started
  pid=$(echo "$content" | grep -o '"pid":[0-9]*' | grep -o '[0-9]*') || pid=0
  hb=$(echo "$content" | grep -o '"lastHeartbeat":[0-9]*' | grep -o '[0-9]*') || hb=0
  sleep=$(echo "$content" | grep -o '"sleepStatus":"[^"]*"' | cut -d'"' -f4) || sleep="awake"
  started=$(echo "$content" | grep -o '"startedAt":[0-9]*' | grep -o '[0-9]*') || started=0
  echo "${pid:-0} ${hb:-0} ${sleep:-awake} ${started:-0}"
}

now_ms() { echo $(( $(date +%s) * 1000 )); }

wait_for_death() {
  local pid=$1 max=10 i=0
  while kill -0 "$pid" 2>/dev/null && (( i < max )); do
    sleep 0.5
    ((i++))
  done
}

write_lock_field() {
  local field=$1 value=$2
  python3 -c "
import json, os
p = '$LOCK'
d = {}
if os.path.exists(p):
    try: d = json.load(open(p))
    except: pass
d['$field'] = $value
with open(p + '.tmp', 'w') as f: json.dump(d, f)
os.rename(p + '.tmp', p)
" 2>/dev/null || true
}

rotate_log() {
  if [[ -f "$LOG" ]]; then
    local size
    size=$(stat -f%z "$LOG" 2>/dev/null || stat -c%s "$LOG" 2>/dev/null || echo 0)
    if (( size > MAX_LOG_BYTES )); then
      mv "$LOG" "$LOG.1"
      log "Log rotated (was ${size} bytes)"
    fi
  fi
}

circuit_check() {
  local now
  now=$(date +%s)
  local fresh=()
  for ts in ${RESTART_TIMES[@]+"${RESTART_TIMES[@]}"}; do
    if (( now - ts < CIRCUIT_WINDOW )); then
      fresh+=("$ts")
    fi
  done
  RESTART_TIMES=(${fresh[@]+"${fresh[@]}"})
  if (( ${#RESTART_TIMES[@]} >= CIRCUIT_MAX )); then
    return 1
  fi
  return 0
}

spawn_bridge() {
  if ! circuit_check; then
    # Cascading rollback: try slots 1→2→3 (#1048)
    local ROLLBACK_STATE="$AB/.rollback-state"
    local TRIED=$(cat "$ROLLBACK_STATE" 2>/dev/null || echo "0")

    for SLOT in 1 2 3; do
      (( SLOT <= TRIED )) && continue
      local PREV="$AB/app.prev.$SLOT"
      [ -d "$PREV" ] || continue

      echo "$SLOT" > "$ROLLBACK_STATE"
      local ROLLED_VER
      ROLLED_VER=$(python3 -c "import json; print(json.load(open('$PREV/package.json'))['version'])" 2>/dev/null || echo "unknown")
      log "🔄 Circuit breaker — attempting rollback to slot $SLOT ($ROLLED_VER)..."
      rm -rf "$AB/app.broken"
      mv "$AB/app" "$AB/app.broken"
      mv "$PREV" "$AB/app"
      RESTART_TIMES=()
      rm -f "$STATE_FILE"

      if [ -x "$AB/scripts/doctor.sh" ]; then
        timeout 30 "$AB/scripts/doctor.sh" --fix >> "$AB/logs/launchd.log" 2>&1 || true
      fi
      if [ -f "$AB/config/.env" ]; then set -a; source "$AB/config/.env"; set +a; fi
      log "Starting bridge (rollback slot $SLOT): node app/bundle/abtars.js"
      cd "$AB"
      ABTARS_WATCHDOG_PID=$$ NODE_PATH="${ABMIND_HOME:-$HOME/.abmind}/lib/node_modules:${NODE_PATH:-}" node app/bundle/abtars.js >> "$AB/logs/launchd.log" 2>&1 200>&- &
      BRIDGE_PID=""
      for i in $(seq 1 15); do
        sleep 2
        if [ -f "$LOCK" ]; then
          BRIDGE_PID=$(grep -o '"pid":[0-9]*' "$LOCK" | grep -o '[0-9]*' || echo "")
          if [[ -n "$BRIDGE_PID" && "$BRIDGE_PID" != "0" ]]; then break; fi
        fi
      done

      if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
        rm -rf "$AB/app.broken"
        rm -f "$ROLLBACK_STATE"
        log "✓ Auto-rollback successful — running $ROLLED_VER (slot $SLOT, PID=$BRIDGE_PID)"
        notify "⚠️ Auto-rolled back to $ROLLED_VER (slot $SLOT) after crash loop"
        return 0
      fi
      log "❌ Slot $SLOT ($ROLLED_VER) also failed — trying next..."
    done

    # All slots exhausted — full shutdown
    log "🚨 All rollback slots exhausted. Shutting down."
    notify "🚨 All 3 rollback slots exhausted. Shutting down — manual intervention required."
    rm -f "$STATE_FILE"
    abtars stop 2>/dev/null || true
    exit 0
  fi

  # Health check before every spawn
  if [ -x "$AB/scripts/doctor.sh" ]; then
    log "Running doctor --fix..."
    if ! timeout 30 "$AB/scripts/doctor.sh" --fix >> "$AB/logs/launchd.log" 2>&1; then
      log "⚠️ doctor --fix failed — spawning anyway (non-fatal)"
    fi
  fi

  if [[ "$PLANNED_RESTART" != "true" ]]; then
    RESTART_TIMES+=("$(date +%s)")
    printf '%s\n' "${RESTART_TIMES[@]}" > "$STATE_FILE"
  fi
  PLANNED_RESTART=false

  # #686: Kill stale bridge holding port 3100
  if [ -f "$AB/bridge.pid" ]; then
    old_pid=$(cat "$AB/bridge.pid")
    if kill -0 "$old_pid" 2>/dev/null; then
      log "Killing stale bridge (pid $old_pid)..."
      kill "$old_pid" 2>/dev/null
      for i in 1 2 3 4 5; do kill -0 "$old_pid" 2>/dev/null || break; sleep 1; done
      kill -0 "$old_pid" 2>/dev/null && kill -9 "$old_pid" 2>/dev/null
    fi
  fi
  # Wait for port 3100 release
  for i in 1 2 3 4 5; do lsof -ti :3100 >/dev/null 2>&1 || break; sleep 1; done

  # Clean stale socket
  rm -f "${ABMIND_HOME:-$HOME/.abmind}/memory.sock" 2>/dev/null || true

  # Source .env so platform ENABLED vars reach the node process
  if [ -f "$AB/config/.env" ]; then set -a; source "$AB/config/.env"; set +a; fi
  log "Starting bridge: node app/bundle/abtars.js $*"
  cd "$AB"
  ABTARS_WATCHDOG_PID=$$ NODE_PATH="${ABMIND_HOME:-$HOME/.abmind}/lib/node_modules:${NODE_PATH:-}" node app/bundle/abtars.js "$@" >> "$AB/logs/launchd.log" 2>&1 200>&- &
  SPAWNED_AT=$(date +%s)

  # Wait for bridge.lock with PID
  local wait=0
  local spawned_pid=$!
  BRIDGE_PID=""
  while (( wait < 30 )); do
    # Instant-death check: if process already died, bridge can't boot
    if ! kill -0 "$spawned_pid" 2>/dev/null; then
      log "Bridge died during startup (PID=$spawned_pid)"
      RESTART_TIMES+=("$(date +%s)")
      RESTART_TIMES+=("$(date +%s)")
      printf '%s\n' "${RESTART_TIMES[@]}" > "$STATE_FILE"
      return
    fi
    if [[ -f "$LOCK" ]]; then
      BRIDGE_PID=$(grep -o '"pid":[0-9]*' "$LOCK" | grep -o '[0-9]*' || echo "")
      if [[ -n "$BRIDGE_PID" && "$BRIDGE_PID" != "0" ]]; then
        break
      fi
    fi
    sleep 1
    ((wait++))
  done
  log "Bridge spawned (PID=$BRIDGE_PID)"
  rm -f "$AB/.rollback-state"  # Clear stale rollback state on successful start
}

kill_bridge() {
  local reason=$1
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    log "Killing bridge PID=$BRIDGE_PID ($reason)"
    notify "🚨 Watchdog: $reason — killing PID $BRIDGE_PID"
    kill -9 "$BRIDGE_PID" 2>/dev/null || true
    wait_for_death "$BRIDGE_PID"
  fi
  BRIDGE_PID=""
}

graceful_restart() {
  RESTARTING=true
  RESTART_STARTED_AT=$(date +%s)
  log "USR1 received — graceful restart"
  notify "♻️ Restarting bridge..."
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    log "Stopping old bridge (PID=$BRIDGE_PID)..."
    kill -TERM "$BRIDGE_PID" 2>/dev/null || true
    local i=0
    while kill -0 "$BRIDGE_PID" 2>/dev/null && (( i < 20 )); do
      sleep 0.5
      ((i++))
    done
    if kill -0 "$BRIDGE_PID" 2>/dev/null; then
      log "Bridge didn't stop gracefully, SIGKILL"
      kill -9 "$BRIDGE_PID" 2>/dev/null || true
      wait_for_death "$BRIDGE_PID"
    fi
    log "Old bridge exited"
  fi
  BRIDGE_PID=""
  PLANNED_RESTART=true
  # Don't spawn here — let the new watchdog instance handle it cleanly after exec.
  # Spawning before exec causes orphans: the spawned bridge and the post-exec bridge race.
  RESTARTING=false
  log "Reloading watchdog from disk"
  ABTARS_WD_EXEC=1 exec "$0" "${BRIDGE_ARGS[@]}"
}

BRIDGE_ARGS=("$@")
trap 'graceful_restart' USR1
trap '
  _wd_owner=$(python3 -c "import json; print(json.load(open(\"$LOCK\")).get(\"watchdogPid\",0))" 2>/dev/null || echo 0)
  if [[ "$_wd_owner" == "$$" ]]; then
    log "SIGTERM received (owner) — killing bridge"
    kill_bridge "watchdog SIGTERM"
    write_lock_field "watchdogPid" "null"
  else
    log "SIGTERM received but not owner (file=$_wd_owner, me=$$) — exiting without kill"
  fi
  exit 0
' TERM INT

# ── Startup ──
log "Watchdog starting (stale=${STALE_SEC}s, poll=${POLL_SEC}s, circuit=${CIRCUIT_MAX}/${CIRCUIT_WINDOW}s)"
write_lock_field "watchdogPid" $$

# Adopt existing bridge if alive (exec self-replace after USR1, or manual restart)
if [[ -f "$LOCK" ]]; then
  _existing_pid=$(python3 -c "import json; print(json.load(open('$LOCK')).get('pid',0))" 2>/dev/null || echo 0)
  if [[ "$_existing_pid" -gt 0 ]] 2>/dev/null && kill -0 "$_existing_pid" 2>/dev/null; then
    BRIDGE_PID="$_existing_pid"
    log "Adopted existing bridge (PID=$BRIDGE_PID)"
  else
    spawn_bridge "$@"
  fi
else
  spawn_bridge "$@"
fi
LAST_POLL_AT=$(date +%s)

# ── Monitor loop ──
while true; do
  sleep "$POLL_SEC" &
  wait $! 2>/dev/null || true

  rotate_log

  # Suspend detection: if real elapsed >> POLL_SEC, the host (laptop, VM, WSL)
  # was suspended. Bridge was suspended too — its heartbeat is "stale" only
  # because wall-clock advanced while both processes were frozen. Skip the
  # staleness check for one cycle so the bridge can heartbeat on resume.
  _now_s=$(date +%s)
  _poll_gap=$(( _now_s - LAST_POLL_AT ))
  LAST_POLL_AT=$_now_s
  if [[ "$SUSPEND_GRACE" == "true" ]] && (( _poll_gap > POLL_SEC * 3 )); then
    log "Suspend detected (poll gap ${_poll_gap}s >> ${POLL_SEC}s) — granting one-cycle grace"
    continue
  fi

  local_lock=$(read_lock)
  if [[ "$local_lock" == "ERR" ]]; then
    log "bridge.lock missing or corrupt — self-healing"
    write_lock_field "watchdogPid" $$
    BRIDGE_PID=""
    spawn_bridge "${BRIDGE_ARGS[@]}"
    continue
  fi

  lock_pid=$(echo "$local_lock" | awk '{print $1}')
  lock_hb=$(echo "$local_lock" | awk '{print $2}')
  lock_sleep=$(echo "$local_lock" | awk '{print $3}')
  lock_started=$(echo "$local_lock" | awk '{print $4}')
  now=$(now_ms)

  if [[ -n "$lock_pid" && "$lock_pid" != "0" ]]; then
    BRIDGE_PID="$lock_pid"
  fi

  # Guard: don't spawn if graceful_restart is in progress
  if [[ "$RESTARTING" == "true" ]]; then
    local elapsed=$(( $(date +%s) - RESTART_STARTED_AT ))
    if (( elapsed > 30 )); then
      log "RESTARTING flag stuck for ${elapsed}s — resetting"
      RESTARTING=false
    else
      continue
    fi
  fi

  if [[ -z "$BRIDGE_PID" ]] || ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    log "Bridge process gone (PID=$BRIDGE_PID)"
    notify "🚨 Watchdog: bridge process gone, restarting"
    BRIDGE_PID=""
    spawn_bridge "${BRIDGE_ARGS[@]}"
    continue
  fi

  if [[ "$lock_sleep" == "hw_sleep" ]]; then
    continue
  fi

  if (( lock_hb == 0 )); then
    if (( lock_started > 0 )); then
      age_s=$(( (now - lock_started) / 1000 ))
      if (( age_s > STARTUP_TIMEOUT )); then
        kill_bridge "startup timeout (${age_s}s from startedAt, no heartbeat)"
        spawn_bridge "${BRIDGE_ARGS[@]}"
      fi
    fi
    continue
  fi

  age_sec=$(( (now - lock_hb) / 1000 ))
  if [[ "$KILL_ON_STALE" == "true" ]] && (( age_sec > STALE_SEC )); then
    # Skip if update in progress — bridge will be restarted by update command
    if [[ -f "$AB/state/update.sentinel" ]] && grep -q '"pending"' "$AB/state/update.sentinel" 2>/dev/null; then
      continue
    fi
    kill_bridge "heartbeat stale (${age_sec}s)"
    spawn_bridge "${BRIDGE_ARGS[@]}"
  fi
done
