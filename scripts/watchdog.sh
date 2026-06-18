#!/usr/bin/env bash
# Minimal watchdog: start bridge, poll alive + heartbeat, respawn on death.
# No rollback, no circuit breaker (bridge handles that), no USR1.
AB="${ABTARS_HOME:-$HOME/.abtars}"
LOCK="$AB/bridge.lock"
STALE=300
POLL=60
LOG="$AB/logs/bridge.log"
STATE="$AB/watchdog.state"

# Singleton: only one watchdog instance (flock on Linux, lockf on Mac)
exec 200>>"$AB/.bridge.flock"
if command -v flock &>/dev/null; then
  flock -n 200 || exit 0
else
  lockf -s -t 0 200 || exit 0
fi

# Don't propagate signals to bridge child
trap '' HUP
trap 'exit 0' TERM INT

[[ -f "$AB/.stopped" ]] && exit 0

while true; do
  # Read start reason (written by update/rollback/start, default: watchdog-respawn)
  REASON=$(cat "$AB/.start-reason" 2>/dev/null || echo "watchdog-respawn")
  rm -f "$AB/.start-reason"

  # Start bridge
  cd "$AB" && ABTARS_WATCHDOG_PID=$$ NODE_PATH="${ABMIND_HOME:-$HOME/.abmind}/lib/node_modules:${NODE_PATH:-}" ABTARS_START_REASON="$REASON" nohup node app/bundle/abtars.js >> "$LOG" 2>&1 200>&- &
  PID=$!
  disown $PID
  SPAWNED_AT=$(date +%s)

  # Poll: alive + heartbeat
  while sleep "$POLL"; do
    [[ -f "$AB/.stopped" ]] && exit 0
    kill -0 "$PID" 2>/dev/null || break
    # Grace period: skip stale check while bridge is booting
    (( $(date +%s) - SPAWNED_AT < 180 )) && continue
    HB=$(grep -o '"lastHeartbeat":[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*')
    NOW=$(($(date +%s) * 1000))
    if [[ -n "$HB" ]] && (( (NOW - HB) / 1000 > STALE )); then
      kill -9 "$PID" 2>/dev/null
      break
    fi
  done

  [[ -f "$AB/.stopped" ]] && exit 0

  # Record death
  echo "$(date +%s)" >> "$STATE"

  # AG5 edge case: if bridge never wrote a heartbeat and 4+ deaths → give up
  DEATHS=$(awk -v cutoff=$(($(date +%s) - 420)) '$1 > cutoff' "$STATE" 2>/dev/null | wc -l)
  HB_CHECK=$(grep -o '"lastHeartbeat":[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*')
  if (( DEATHS >= 4 )) && [[ -z "$HB_CHECK" || "$HB_CHECK" == "0" ]]; then
    touch "$AB/.stopped"
    exit 0
  fi

  sleep 2
done
