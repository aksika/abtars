#!/usr/bin/env bash
# Minimal watchdog: start bridge, poll alive + heartbeat, respawn on death.
# No rollback, no circuit breaker (bridge handles that), no USR1.
AB="${ABTARS_HOME:-$HOME/.abtars}"
LOCK="$AB/bridge.lock"
STALE=300
POLL=60
LOG="$AB/logs/bridge.log"
STATE="$AB/watchdog.state"

# Secondary singleton guard: PID check via bridge.lock (belt + suspenders with flock)
OLD_WD=$(python3 -c "import json;print(json.load(open('$LOCK')).get('watchdogPid',''))" 2>/dev/null)
if [[ -n "$OLD_WD" && "$OLD_WD" != "$$" ]] && kill -0 "$OLD_WD" 2>/dev/null; then
  if ps -p "$OLD_WD" -o command= 2>/dev/null | grep -q "watchdog"; then
    exit 0
  fi
fi

# Primary singleton: flock on Linux, lockf on Mac
exec 200>>"$AB/.bridge.flock"
if command -v flock &>/dev/null; then
  flock -n 200 || exit 0
else
  lockf -s -t 0 200 || exit 0
fi

# Write our PID into bridge.lock for secondary guard
python3 -c "
import json,os
p='$LOCK'
try:
  d=json.load(open(p))
except: d={}
d['watchdogPid']=$$
with open(p,'w') as f: json.dump(d,f)
" 2>/dev/null

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
  DEATH_REASON=""
  while sleep "$POLL"; do
    [[ -f "$AB/.stopped" ]] && exit 0
    if ! kill -0 "$PID" 2>/dev/null; then
      wait "$PID" 2>/dev/null; EXIT_CODE=$?
      DEATH_REASON="process-gone:exit=$EXIT_CODE"
      break
    fi
    # Grace period: skip stale check while bridge is booting
    (( $(date +%s) - SPAWNED_AT < 180 )) && continue
    HB=$(grep -o '"lastHeartbeat":[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*')
    NOW=$(($(date +%s) * 1000))
    if [[ -n "$HB" ]] && (( (NOW - HB) / 1000 > STALE )); then
      DEATH_REASON="stale-heartbeat:$(( (NOW - HB) / 1000 ))s"
      kill -9 "$PID" 2>/dev/null
      break
    fi
  done

  [[ -f "$AB/.stopped" ]] && exit 0

  # Log death
  echo "$(date +%FT%T) Bridge died: $DEATH_REASON (PID=$PID)" >> "$AB/logs/watchdog.log"

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
