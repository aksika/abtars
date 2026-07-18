#!/usr/bin/env bash
# Watchdog: start bridge, poll alive + heartbeat, respawn on death.
# Reads .start-reason for instructions. Exits on "stopped" (code 2) or update/restart (code 0).
AB="${ABTARS_HOME:-$HOME/.abtars}"
LOCK="$AB/bridge.lock"
STALE=300
POLL=60
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

  # Start bridge
  BRIDGE_REASON="${REASON:-watchdog-respawn}"
  # #1261: exec replaces the subshell with the env->nohup->node chain so $! is the real node PID.
  # Without exec, bash forks a subshell for `cd && env=value cmd &` and $! returns the subshell,
  # leaving node as a grandchild that gets orphaned when the subshell dies.
  cd "$AB" && exec env ABTARS_WATCHDOG_PID=$$ NODE_PATH="$HOME/.local/lib/node_modules:${NODE_PATH:-}" ABTARS_START_REASON="$BRIDGE_REASON" nohup node --max-old-space-size=1024 app/bundle/abtars.js 200>&- &
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
      wait "$PID" 2>/dev/null   # reap the child; its return is ignored below (always 0 due to disown)
      # #1328: prefer the bridge's self-reported exit code from bridge.lock. `wait` always
      # reports 0 here because of `disown` (kept intentionally — #1050 survival +
      # SIGTERM/INT-trap isolation, see resilience.asbuilt.md). Only trust the lock's
      # lastExitCode if it was written AFTER this bridge instance was spawned — otherwise
      # it's a stale value from a prior death (or the lock predates this fix).
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
    (( $(date +%s) - SPAWNED_AT < 180 )) && continue
    HB=$(grep -o '"lastHeartbeat":[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*')
    NOW=$(($(date +%s) * 1000))
    if [[ -n "$HB" ]] && (( (NOW - HB) / 1000 > STALE )); then
      DEATH_REASON="stale-heartbeat:$(( (NOW - HB) / 1000 ))s"
      kill -9 "$PID" 2>/dev/null
      break
    fi
  done

  # Log death + update deploy.state restartCount + crash-window death log
  echo "$(date +%FT%T) Bridge died: $DEATH_REASON (PID=$PID)" >> "$AB/logs/watchdog.log"
  python3 -c "
import json, time
p='$STATE'
try: d=json.load(open(p))
except: d={}
d['restartCount'] = d.get('restartCount', 0) + 1
d['lastDeath'] = '$(date +%FT%T)'
# #1328: rolling window of recent death timestamps (epoch seconds), for the
# crash-with-heartbeat failsafe below. Keep only the last 10 — plenty for a
# 4-in-N-minutes check without unbounded growth.
window = d.get('deathWindow', [])
window.append(int(time.time()))
d['deathWindow'] = window[-10:]
with open(p,'w') as f: json.dump(d,f)
" 2>/dev/null

  # Failsafe A: 4+ deaths in 7min with no heartbeat ever → give up
  HB_CHECK=$(grep -o '"lastHeartbeat":[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*')
  RESTART_COUNT=$(python3 -c "import json; print(json.load(open('$STATE')).get('restartCount',0))" 2>/dev/null || echo 0)
  if (( RESTART_COUNT >= 4 )) && [[ -z "$HB_CHECK" || "$HB_CHECK" == "0" ]]; then
    echo "stopped" > "$AB/.start-reason"
    exit 2
  fi

  # Failsafe B (#1328): 4+ deaths within a 10min window, REGARDLESS of heartbeat state.
  # Catches the #1327 pattern — bridge heartbeats fine for ~2min each cycle then dies on
  # the same bug every time. Failsafe A never fires in this case because heartbeat IS
  # present; the boot-side circuit breaker (boot/circuit-breaker.ts) eventually catches it
  # via restartCount, but only after a full rollback cycle. This trips sooner, same terminal
  # action (stopped, exit 2) as Failsafe A.
  CRASH_WINDOW_COUNT=$(python3 -c "
import json, time
try:
    d = json.load(open('$STATE'))
    window = d.get('deathWindow', [])
    now = time.time()
    print(sum(1 for t in window if now - t <= 600))
except Exception:
    print(0)
" 2>/dev/null || echo 0)
  if (( CRASH_WINDOW_COUNT >= 4 )); then
    echo "$(date +%FT%T) Failsafe B: $CRASH_WINDOW_COUNT deaths within 10min (heartbeat present) — giving up" >> "$AB/logs/watchdog.log"
    echo "stopped" > "$AB/.start-reason"
    exit 2
  fi

  sleep 2
done
