#!/usr/bin/env bash
# Watchdog: start bridge, poll alive + heartbeat, respawn on death.
# Uses supervisor.state for durable command and desired-state arbitration.
# Exit codes: 0 no-op, 1 fault, 2 durable stop, 3 running handoff
AB="${ABTARS_HOME:-$HOME/.abtars}"
LOCK="$AB/bridge.lock"
STALE=300
POLL=60
POLL_INTERVAL=5
WD_LOG="$AB/logs/watchdog.log"

# Resolve supervisor-state CLI entry
SUPERVISOR_CLI=""
for candidate in "$AB/app/bundle/abtars-supervisor-state.js" "$AB/../src/abtars/bundle/abtars-supervisor-state.js"; do
  if [[ -f "$candidate" ]]; then
    SUPERVISOR_CLI="$candidate"
    break
  fi
done
if [[ -z "$SUPERVISOR_CLI" ]]; then
  echo "$(date +%FT%T) FATAL: abtars-supervisor-state.js not found" >> "$WD_LOG"
  exit 1
fi

svc() { node "$SUPERVISOR_CLI" "$@"; }

# Singleton: flock (Linux) / lockf (macOS)
exec 200>>"$AB/.bridge.flock"
if command -v flock &>/dev/null; then
  if ! flock -w 5 200; then
    exit 0
  fi
else
  if ! lockf -s -t 5 200; then
    exit 0
  fi
fi

# Write watchdog PID into bridge.lock
python3 -c "
import json
p='$LOCK'
try: d=json.load(open(p))
except: d={}
d['watchdogPid']=$$
with open(p,'w') as f: json.dump(d,f)
" 2>/dev/null

# Signal traps: set in-memory flags only; never kill bridge or mutate state
TERMINATE_FLAG=0
WAKE_FLAG=0
trap '' HUP
trap 'TERMINATE_FLAG=1' TERM INT
trap 'WAKE_FLAG=1' USR1

migrate_supervisor_state() {
  local result
  result=$(svc migrate 2>/dev/null)
  if [[ "$result" == "migrated" ]]; then
    echo "$(date +%FT%T) Supervisor state migrated from legacy" >> "$WD_LOG"
  fi
}

read_desired_state() {
  svc desired-state 2>/dev/null || echo "unavailable"
}

claim_and_ack_command() {
  local cmd_json cmd_seq cmd_type
  cmd_json=$(svc claim-command 2>/dev/null)
  if [[ "$cmd_json" == "null" || -z "$cmd_json" ]]; then
    return 1
  fi
  cmd_seq=$(echo "$cmd_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('seq',''))" 2>/dev/null)
  cmd_type=$(echo "$cmd_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('type',''))" 2>/dev/null)
  if [[ -z "$cmd_seq" || -z "$cmd_type" ]]; then
    return 1
  fi
  echo "$cmd_type"
  svc ack-command "$cmd_seq" "applied" 2>/dev/null
  return 0
}

handle_stopped() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  echo "$(date +%FT%T) Watchdog exit: desiredState=stopped" >> "$WD_LOG"
  exit 2
}

handle_running_handoff() {
  echo "$(date +%FT%T) Watchdog exit: handoff with running bridge (PID=${PID:-none})" >> "$WD_LOG"
  exit 3
}

# Fast poll: check durable state flags, commands, desired state
# Runs every POLL_INTERVAL (5s) seconds during monitoring and backoff.
poll_state() {
  if [[ "$TERMINATE_FLAG" -eq 1 ]]; then
    TERMINATE_FLAG=0
    DESIRED=$(read_desired_state)
    if [[ "$DESIRED" == "stopped" ]]; then
      handle_stopped
    fi
    handle_running_handoff
  fi
  if [[ "$WAKE_FLAG" -eq 1 ]]; then
    WAKE_FLAG=0
    claim_and_ack_command > /dev/null 2>&1
  fi
  DESIRED=$(read_desired_state)
  if [[ "$DESIRED" == "stopped" ]]; then
    handle_stopped
  fi
  local cmd_type
  cmd_type=$(claim_and_ack_command 2>/dev/null)
  if [[ "$cmd_type" == "stop" ]]; then
    handle_stopped
  elif [[ "$cmd_type" == "update" || "$cmd_type" == "restart" || "$cmd_type" == "rollback" ]]; then
    echo "$(date +%FT%T) Watchdog exit: command=$cmd_type" >> "$WD_LOG"
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
    fi
    exit 3
  fi
}

# ── Startup ──────────────────────────────────────────────────────────────
migrate_supervisor_state
DESIRED=$(read_desired_state)
if [[ "$DESIRED" == "stopped" ]]; then
  handle_stopped
fi

# ── Main loop ────────────────────────────────────────────────────────────
while true; do
  # Check desired state before spawn (bounded poll every 5s)
  while true; do
    poll_state
    sleep "$POLL_INTERVAL"
  done

  # Start bridge
  cd "$AB" && exec env ABTARS_WATCHDOG_PID=$$ NODE_PATH="$HOME/.local/lib/node_modules:${NODE_PATH:-}" ABTARS_START_REASON="watchdog-respawn" nohup node --max-old-space-size=1024 app/bundle/abtars.js 200>&- &
  PID=$!
  SPAWNED_AT=$(date +%s)

  DEATH_REASON=""
  LAST_POLL_AT=$(date +%s)
  while true; do
    poll_state

    # Suspend detection
    _now_s=$(date +%s)
    _poll_gap=$(( _now_s - LAST_POLL_AT ))
    LAST_POLL_AT=$_now_s
    if (( _poll_gap > POLL * 3 )); then
      echo "$(date +%FT%T) Suspend detected (poll gap ${_poll_gap}s >> ${POLL}s) — granting one-cycle grace" >> "$WD_LOG"
      sleep "$POLL_INTERVAL"
      continue
    fi

    # Bridge alive?
    if ! kill -0 "$PID" 2>/dev/null; then
      wait "$PID" 2>/dev/null
      EXIT_CODE=$(python3 -c "
import json
try:
    d = json.load(open('$LOCK'))
    ec = d.get('lastExitCode')
    ea = d.get('lastExitAt', 0)
    print(ec if (ec is not None and ea / 1000 > $SPAWNED_AT) else '')
except Exception:
    print('')
" 2>/dev/null)
      [[ -z "$EXIT_CODE" ]] && EXIT_CODE="unknown"
      DEATH_REASON="process-gone:exit=$EXIT_CODE"
      break
    fi

    # Stale heartbeat? (skip during boot grace period)
    (( $(date +%s) - SPAWNED_AT < 180 )) && { sleep "$POLL_INTERVAL"; continue; }
    HB=$(grep -o '"lastHeartbeat":[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*')
    NOW=$(($(date +%s) * 1000))
    if [[ -n "$HB" ]] && (( (NOW - HB) / 1000 > STALE )); then
      DEATH_REASON="stale-heartbeat:$(( (NOW - HB) / 1000 ))s"
      kill -9 "$PID" 2>/dev/null
      break
    fi

    sleep "$POLL_INTERVAL"
  done

  # Log death + record via supervisor state
  echo "$(date +%FT%T) Bridge died: $DEATH_REASON (PID=$PID)" >> "$WD_LOG"
  svc record-death "$DEATH_REASON" 2>/dev/null
  svc record-healthy 2>/dev/null

  # Read backoff delay from supervisor state
  BACKOFF_MS=$(svc get-backoff 2>/dev/null || echo 0)
  if [[ "$BACKOFF_MS" -gt 0 ]]; then
    BACKOFF_S=$(( BACKOFF_MS / 1000 ))
    # Bounded poll during backoff — check state every 5s
    for ((i=0; i<BACKOFF_S; i+=POLL_INTERVAL)); do
      poll_state
      sleep "$POLL_INTERVAL"
    done
  fi

  # Check desired state before respawn
  DESIRED=$(read_desired_state)
  if [[ "$DESIRED" == "stopped" ]]; then
    handle_stopped
  fi
done
