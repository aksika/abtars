#!/usr/bin/env bash
# AgentBridge External Watchdog
# Spawns the bridge, monitors bridge.lock heartbeat, kills+restarts on stale.
# Usage: watchdog.sh [bridge flags, e.g. --all --web --agent]
set -euo pipefail

AB="${AGENT_BRIDGE_HOME:-$HOME/.agentbridge}"
BRIDGE="$AB/agentbridge.sh"
LOCK="$AB/bridge.lock"
WD_LOCK="$AB/watchdog.lock"
LOG="$AB/logs/watchdog.log"
ENV_FILE="$AB/.env"

POLL_SEC=60
STALE_SEC="${WATCHDOG_STALE_SEC:-360}"
STARTUP_TIMEOUT=120
CIRCUIT_MAX=3
CIRCUIT_WINDOW=300
MAX_LOG_BYTES=10485760  # 10MB

BRIDGE_PID=""
SPAWNED_AT=0
RESTART_TIMES=()

# ── Load .env for Telegram notifications ──
TG_TOKEN=""
MAIN_CHAT_ID=""
if [[ -f "$ENV_FILE" ]]; then
  TG_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
  MAIN_CHAT_ID=$(grep -m1 '^MAIN_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
fi

mkdir -p "$AB/logs"

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
  # Returns: pid heartbeat_ms sleep_status  (or "ERR" on parse failure)
  python3 -c "
import json
try:
    d=json.load(open('$LOCK'))
    print(d.get('pid',0), d.get('lastHeartbeat',0), d.get('sleepStatus','awake'))
except:
    print('ERR')
" 2>/dev/null
}

now_ms() {
  python3 -c "import time; print(int(time.time()*1000))"
}

wait_for_death() {
  local pid=$1 max=10 i=0
  while kill -0 "$pid" 2>/dev/null && (( i < max )); do
    sleep 0.5
    ((i++))
  done
}

write_wd_lock() {
  local now
  now=$(now_ms)
  echo "{\"pid\":$$,\"lastCheck\":$now}" > "$WD_LOCK"
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
  # Prune old timestamps
  local fresh=()
  for ts in "${RESTART_TIMES[@]}"; do
    if (( now - ts < CIRCUIT_WINDOW )); then
      fresh+=("$ts")
    fi
  done
  RESTART_TIMES=("${fresh[@]}")
  if (( ${#RESTART_TIMES[@]} >= CIRCUIT_MAX )); then
    return 1  # tripped
  fi
  return 0
}

spawn_bridge() {
  if ! circuit_check; then
    log "🚨 CIRCUIT BREAKER — ${CIRCUIT_MAX} restarts in ${CIRCUIT_WINDOW}s, stopping"
    notify "🚨 Watchdog circuit breaker tripped — manual intervention needed"
    rm -f "$WD_LOCK"
    exit 1
  fi

  RESTART_TIMES+=("$(date +%s)")
  rm -f "$LOCK"
  log "Starting bridge: $BRIDGE $*"
  "$BRIDGE" "$@" >> "$AB/logs/launchd.log" 2>&1 &
  SPAWNED_AT=$(date +%s)
  # Wait for bridge.lock to appear with a PID (node writes it on startup)
  local wait=0
  BRIDGE_PID=""
  while (( wait < 30 )); do
    if [[ -f "$LOCK" ]]; then
      BRIDGE_PID=$(python3 -c "import json; print(json.load(open('$LOCK')).get('pid',0))" 2>/dev/null || echo "")
      if [[ -n "$BRIDGE_PID" && "$BRIDGE_PID" != "0" ]]; then
        break
      fi
    fi
    sleep 1
    ((wait++))
  done
  log "Bridge spawned (PID=$BRIDGE_PID)"
}

kill_bridge() {
  local reason=$1
  # Kill the node process (from bridge.lock)
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    log "Killing bridge PID=$BRIDGE_PID ($reason)"
    notify "🚨 Watchdog: $reason — killing PID $BRIDGE_PID"
    kill -9 "$BRIDGE_PID" 2>/dev/null || true
    wait_for_death "$BRIDGE_PID"
  fi
  # Also kill any orphaned agentbridge.sh wrappers
  pkill -f "agentbridge.sh.*--all" 2>/dev/null || true
  rm -f "$LOCK"
  BRIDGE_PID=""
}

# ── USR1 = graceful restart ──
graceful_restart() {
  log "USR1 received — graceful restart"
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill -TERM "$BRIDGE_PID" 2>/dev/null || true
    # Wait up to 10s for graceful shutdown
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
  fi
  rm -f "$LOCK"
  BRIDGE_PID=""
  spawn_bridge "$@"
}

# Store bridge args for USR1 handler
BRIDGE_ARGS=("$@")
trap 'graceful_restart "${BRIDGE_ARGS[@]}"' USR1

# ── Cleanup on exit ──
trap 'kill_bridge "watchdog exit"; rm -f "$WD_LOCK"; exit 0' TERM INT

# ── Main ──
log "Watchdog starting (stale=${STALE_SEC}s, poll=${POLL_SEC}s, circuit=${CIRCUIT_MAX}/${CIRCUIT_WINDOW}s)"
spawn_bridge "$@"

while true; do
  sleep "$POLL_SEC" &
  wait $! 2>/dev/null || true  # allow signal interruption

  write_wd_lock
  rotate_log

  # Read bridge.lock
  local_lock=$(read_lock)
  if [[ "$local_lock" == "ERR" ]]; then
    # Partial write or missing — skip this tick
    continue
  fi

  lock_pid=$(echo "$local_lock" | awk '{print $1}')
  lock_hb=$(echo "$local_lock" | awk '{print $2}')
  lock_sleep=$(echo "$local_lock" | awk '{print $3}')
  now=$(now_ms)

  # Update tracked PID from bridge.lock (node process, not bash wrapper)
  if [[ -n "$lock_pid" && "$lock_pid" != "0" ]]; then
    BRIDGE_PID="$lock_pid"
  fi

  # Check if bridge process is alive
  if [[ -z "$BRIDGE_PID" ]] || ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    log "Bridge process gone (PID=$BRIDGE_PID)"
    notify "🚨 Watchdog: bridge process gone, restarting"
    BRIDGE_PID=""
    spawn_bridge "${BRIDGE_ARGS[@]}"
    continue
  fi
  now=$(now_ms)

  # Skip stale check during hardware sleep
  if [[ "$lock_sleep" == "hw_sleep" ]]; then
    continue
  fi

  # Startup timeout — no heartbeat within 2 min of spawn
  if (( lock_hb == 0 )); then
    elapsed=$(( $(date +%s) - SPAWNED_AT ))
    if (( elapsed > STARTUP_TIMEOUT )); then
      kill_bridge "startup timeout (${elapsed}s, no heartbeat)"
      spawn_bridge "${BRIDGE_ARGS[@]}"
    fi
    continue
  fi

  # Stale heartbeat check
  age_sec=$(( (now - lock_hb) / 1000 ))
  if (( age_sec > STALE_SEC )); then
    kill_bridge "heartbeat stale (${age_sec}s)"
    spawn_bridge "${BRIDGE_ARGS[@]}"
  fi
done
