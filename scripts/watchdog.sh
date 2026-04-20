#!/usr/bin/env bash
# AgentBridge External Watchdog
# Spawns node directly, monitors bridge.lock heartbeat, kills+restarts on stale.
# Usage: watchdog.sh [bridge flags, e.g. --all --web --agent]
set -uo pipefail

AB="${AGENT_BRIDGE_HOME:-$HOME/.agentbridge}"
LOCK="$AB/bridge.lock"
WD_LOCK="$AB/watchdog.lock"
LOG="$AB/logs/watchdog.log"
ENV_FILE="$AB/.env"

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
fi
STARTUP_TIMEOUT=$(( HB_SEC + POLL_SEC * 2 ))
CIRCUIT_MAX=3
CIRCUIT_WINDOW=300
MAX_LOG_BYTES=10485760

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

write_wd_lock() {
  printf '{"pid":%d,"lastCheck":%s}\n' $$ "$(now_ms)" > "$WD_LOCK"
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
    log "🚨 CIRCUIT BREAKER — ${CIRCUIT_MAX} restarts in ${CIRCUIT_WINDOW}s, stopping"
    notify "🚨 Watchdog circuit breaker tripped — manual intervention needed"
    rm -f "$WD_LOCK"
    exit 1
  fi

  RESTART_TIMES+=("$(date +%s)")
  rm -f "$LOCK"

  # Clean stale socket
  rm -f "${ABMIND_HOME:-$HOME/.abmind}/memory.sock" 2>/dev/null || true

  # Note: bridge loads its own .env via src/boot/env.ts — no shell source needed.
  # #158: versioned code at $AB/current/dist; shared node_modules at $AB/node_modules.
  log "Starting bridge: node current/dist/main.js $*"
  cd "$AB"
  node current/dist/main.js "$@" >> "$AB/logs/launchd.log" 2>&1 &
  SPAWNED_AT=$(date +%s)

  # Wait for bridge.lock with PID
  local wait=0
  BRIDGE_PID=""
  while (( wait < 30 )); do
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
}

kill_bridge() {
  local reason=$1
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    log "Killing bridge PID=$BRIDGE_PID ($reason)"
    notify "🚨 Watchdog: $reason — killing PID $BRIDGE_PID"
    kill -9 "$BRIDGE_PID" 2>/dev/null || true
    wait_for_death "$BRIDGE_PID"
  fi
  rm -f "$LOCK"
  BRIDGE_PID=""
}

graceful_restart() {
  log "USR1 received — graceful restart"
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
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
  fi
  rm -f "$LOCK"
  BRIDGE_PID=""
  spawn_bridge "$@"
}

BRIDGE_ARGS=("$@")
trap 'graceful_restart "${BRIDGE_ARGS[@]}"' USR1
trap 'kill_bridge "watchdog exit"; rm -f "$WD_LOCK"; exit 0' TERM INT

# ── Startup ──
log "Watchdog starting (stale=${STALE_SEC}s, poll=${POLL_SEC}s, circuit=${CIRCUIT_MAX}/${CIRCUIT_WINDOW}s)"

# Run doctor once at startup (non-fatal)
if [ -x "$AB/scripts/doctor.sh" ]; then
  "$AB/scripts/doctor.sh" --fix >> "$AB/logs/launchd.log" 2>&1 || true
fi

spawn_bridge "$@"

# ── Monitor loop ──
while true; do
  sleep "$POLL_SEC" &
  wait $! 2>/dev/null || true

  write_wd_lock
  rotate_log

  local_lock=$(read_lock)
  if [[ "$local_lock" == "ERR" ]]; then
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
    kill_bridge "heartbeat stale (${age_sec}s)"
    spawn_bridge "${BRIDGE_ARGS[@]}"
  fi
done
