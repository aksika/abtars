#!/usr/bin/env bash
# Watchdog: start bridge, poll alive + heartbeat, respawn on death.
# Reads .start-reason for instructions. Exits on "stopped" (code 2) or update/restart (code 0).
AB="${ABTARS_HOME:-$HOME/.abtars}"
LOCK="$AB/bridge.lock"
STALE=300
POLL=60
LOG="$AB/logs/bridge.log"
STATE="$AB/deploy.state"

# Singleton: flock (Linux) / lockf (macOS)
exec 200>>"$AB/.bridge.flock"
if command -v flock &>/dev/null; then
  if ! flock -w 5 200; then
    WD_PID=$(python3 -c "import json; print(json.load(open('$LOCK')).get('watchdogPid',''))" 2>/dev/null)
    if [[ -n "$WD_PID" ]] && ! kill -0 "$WD_PID" 2>/dev/null; then
      rm -f "$AB/.bridge.flock"
      exec "$0" "$@"
    fi
    exit 0
  fi
else
  if ! lockf -s -t 5 200; then
    WD_PID=$(python3 -c "import json; print(json.load(open('$LOCK')).get('watchdogPid',''))" 2>/dev/null)
    if [[ -n "$WD_PID" ]] && ! kill -0 "$WD_PID" 2>/dev/null; then
      rm -f "$AB/.bridge.flock"
      exec "$0" "$@"
    fi
    exit 0
  fi
fi

# Write our PID into bridge.lock
python3 -c "
import json
p='$LOCK'
try: d=json.load(open(p))
except: d={}
d['watchdogPid']=$$
with open(p,'w') as f: json.dump(d,f)
" 2>/dev/null

# Don't propagate signals to bridge child
trap '' HUP
trap 'exit 0' TERM INT

while true; do
  # Read .start-reason (one-shot message from update/stop/restart)
  REASON=""
  if [[ -f "$AB/.start-reason" ]]; then
    REASON=$(cat "$AB/.start-reason")
    rm -f "$AB/.start-reason"
  fi

  # Act on reason
  case "$REASON" in
    stopped) exit 2 ;;            # intentional stop — daemon won't respawn (exit 2)
    update:*|restart|rollback:*)  # update/restart just killed bridge — we exit so daemon respawns with new code
      exit 0 ;;
  esac

  # Pre-flight doctor
  [ -x "$AB/scripts/doctor.sh" ] && "$AB/scripts/doctor.sh" --fix >> "$AB/logs/watchdog.log" 2>&1 || true

  # Start bridge
  BRIDGE_REASON="${REASON:-watchdog-respawn}"
  cd "$AB" && ABTARS_WATCHDOG_PID=$$ NODE_PATH="$HOME/.abtars-releases/deps/node_modules:${NODE_PATH:-}" ABTARS_START_REASON="$BRIDGE_REASON" nohup node --max-old-space-size=1024 app/bundle/abtars.js >> "$LOG" 2>&1 200>&- &
  PID=$!
  disown $PID
  SPAWNED_AT=$(date +%s)

  # Poll: alive + heartbeat + .start-reason
  DEATH_REASON=""
  LAST_POLL_AT=$(date +%s)
  while sleep "$POLL"; do
    # Suspend detection: if poll gap >> POLL, host was asleep — skip stale check
    _now_s=$(date +%s)
    _poll_gap=$(( _now_s - LAST_POLL_AT ))
    LAST_POLL_AT=$_now_s
    if (( _poll_gap > POLL * 3 )); then
      echo "$(date +%FT%T) Suspend detected (poll gap ${_poll_gap}s >> ${POLL}s) — granting one-cycle grace" >> "$AB/logs/watchdog.log"
      continue
    fi
    # Check for new instructions
    if [[ -f "$AB/.start-reason" ]]; then
      REASON=$(cat "$AB/.start-reason")
      rm -f "$AB/.start-reason"
      case "$REASON" in
        stopped)
          kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
          exit 2 ;;
        update:*|restart|rollback:*)
          kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
          exit 0 ;;
      esac
    fi
    # Bridge alive?
    if ! kill -0 "$PID" 2>/dev/null; then
      wait "$PID" 2>/dev/null; EXIT_CODE=$?
      DEATH_REASON="process-gone:exit=$EXIT_CODE"
      break
    fi
    # Stale heartbeat? (skip during boot grace period)
    (( $(date +%s) - SPAWNED_AT < 180 )) && continue
    HB=$(grep -o '"lastHeartbeat":[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*')
    NOW=$(($(date +%s) * 1000))
    if [[ -n "$HB" ]] && (( (NOW - HB) / 1000 > STALE )); then
      DEATH_REASON="stale-heartbeat:$(( (NOW - HB) / 1000 ))s"
      kill -9 "$PID" 2>/dev/null
      break
    fi
  done

  # Log death + update deploy.state restartCount
  echo "$(date +%FT%T) Bridge died: $DEATH_REASON (PID=$PID)" >> "$AB/logs/watchdog.log"
  python3 -c "
import json
p='$STATE'
try: d=json.load(open(p))
except: d={}
d['restartCount'] = d.get('restartCount', 0) + 1
d['lastDeath'] = '$(date +%FT%T)'
with open(p,'w') as f: json.dump(d,f)
" 2>/dev/null

  # Failsafe: 4+ deaths in 7min with no heartbeat ever → give up
  HB_CHECK=$(grep -o '"lastHeartbeat":[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*')
  RESTART_COUNT=$(python3 -c "import json; print(json.load(open('$STATE')).get('restartCount',0))" 2>/dev/null || echo 0)
  if (( RESTART_COUNT >= 4 )) && [[ -z "$HB_CHECK" || "$HB_CHECK" == "0" ]]; then
    echo "stopped" > "$AB/.start-reason"
    exit 2
  fi

  sleep 2
done
