#!/usr/bin/env bash
# Watchdog: start (or adopt) one bridge, poll alive + heartbeat, respawn on death.
# Uses supervisor.state for durable command and desired-state arbitration.
# Exit codes (R4): 0 no-op/duplicate, 1 fault, 2 durable stop, 3 running handoff
AB="${ABTARS_HOME:-$HOME/.abtars}"
LOCK="$AB/bridge.lock"
STALE=300        # heartbeat staleness threshold (seconds)
POLL=60          # documented poll cadence
POLL_INTERVAL=5  # bounded state-poll slice (R3.5: check durable state <=5s)
WD_LOG="$AB/logs/watchdog.log"

# Resolve supervisor-state CLI entry (dev/alpha/stable/rollback)
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
logw() { echo "$(date +%FT%T) $*" >> "$WD_LOG"; }

# ── Singleton: flock (Linux) / lockf (macOS). The inode is never unlinked. ──
exec 200>>"$AB/.bridge.flock"
if command -v flock &>/dev/null; then
  flock -w 5 200 || exit 0     # duplicate contender -> exit 0 (R5.2)
else
  lockf -s -t 5 200 || exit 0  # macOS retained path (R9)
fi

# Record watchdog ownership of bridge.lock via the bundled helper (R2.2 — the
# shell must not mutate JSON directly; this replaces the former inline python3).
svc set-watchdog-pid "$$" 2>/dev/null

# Signal traps: set in-memory flags only (R4.1). Never kill/lock/mutate here.
TERMINATE_FLAG=0
WAKE_FLAG=0
trap '' HUP
trap 'TERMINATE_FLAG=1' TERM INT
trap 'WAKE_FLAG=1' USR1

# ── Helpers ──────────────────────────────────────────────────────────────
migrate_supervisor_state() {
  if [[ "$(svc migrate 2>/dev/null)" == "migrated" ]]; then
    logw "Supervisor state migrated from legacy"
  fi
}

read_desired_state() { svc desired-state 2>/dev/null || echo "unavailable"; }

handle_stopped() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  logw "Watchdog exit: desiredState=stopped"
  exit 2
}

handle_running_handoff() {
  logw "Watchdog exit: handoff with running bridge (PID=${PID:-none})"
  exit 3
}

# Apply a pending command: claim -> apply -> ack (R3.4: ack ONLY after applying).
# Sets PLANNED_RESTART=1 when it terminated a healthy bridge for restart/update/
# rollback so the monitor loop breaks WITHOUT recording an unplanned death.
apply_command() {
  local out seq type
  out="$(svc claim-command 2>/dev/null)"
  [[ -z "$out" ]] && return 1
  read -r seq type <<< "$out"
  [[ -z "$seq" || "$seq" == "0" || -z "$type" ]] && return 1

  case "$type" in
    stop)
      # Stop dominates (R3.3): desiredState is already = stopped. Terminate the
      # validated bridge, THEN ack, THEN exit 2.
      if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
      fi
      svc ack-command "$seq" 2>/dev/null
      logw "Watchdog exit: command=stop"
      exit 2
      ;;
    restart|update|rollback)
      # Planned bridge termination (R7.2 resets the rollback counter). Kill the
      # validated bridge, reset the counter, ack, then break to respawn from the
      # (possibly repointed) release. The watchdog stays in its loop.
      if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
      fi
      svc reset-restart-count "command:$type" 2>/dev/null
      svc ack-command "$seq" 2>/dev/null
      logw "Planned bridge restart: command=$type"
      PID=""
      PLANNED_RESTART=1
      return 0
      ;;
    *)
      # Unknown command: ack and drop so the one-slot queue does not stall.
      svc ack-command "$seq" 2>/dev/null
      return 0
      ;;
  esac
}

# Fast poll: resolve signals against durable state, then apply any command.
# Runs every POLL_INTERVAL during monitoring and backoff (lost-signal safe).
poll_state() {
  if [[ "$TERMINATE_FLAG" -eq 1 ]]; then
    TERMINATE_FLAG=0
    if [[ "$(read_desired_state)" == "stopped" ]]; then
      handle_stopped     # exit 2
    fi
    handle_running_handoff  # exit 3 — preserve the running bridge (R4)
  fi
  WAKE_FLAG=0   # wake is recovered by the apply below; USR1 carries no payload
  if [[ "$(read_desired_state)" == "stopped" ]]; then
    handle_stopped
  fi
  apply_command || true
}

# Spawn exactly one bridge. $! is the real node PID (exec replaces the subshell).
# NB: `exec` and `nohup node` MUST stay on one physical line — the #1261 guard
# asserts this so $! is the node PID, not a bash subshell.
spawn_bridge() {
  cd "$AB" && exec env ABTARS_WATCHDOG_PID=$$ NODE_PATH="$HOME/.local/lib/node_modules:${NODE_PATH:-}" ABTARS_START_REASON="${START_REASON:-watchdog-respawn}" nohup node --max-old-space-size=1024 app/bundle/abtars.js 200>&- &
  PID=$!
  disown $PID   # #1050: survive watchdog SIGTERM/HUP — bridge must not die with us
  SPAWNED_AT=$(date +%s)
  PLANNED_RESTART=0
}

# Adopt one valid existing bridge, otherwise spawn exactly one (R6.4).
adopt_or_spawn() {
  local vstatus vpid vstarted
  read -r vstatus vpid vstarted <<< "$(svc validate-bridge 2>/dev/null)"
  if [[ "$vstatus" == "valid" && -n "$vpid" && "$vpid" != "0" ]]; then
    PID="$vpid"
    # Adoption grants no new boot grace (R6.6): use the bridge's recorded
    # startedAt so heartbeat/health checks apply to its true process age.
    if [[ -n "$vstarted" && "$vstarted" != "0" ]]; then
      SPAWNED_AT=$(( vstarted / 1000 ))
    else
      SPAWNED_AT=$(date +%s)
    fi
    PLANNED_RESTART=0
    logw "Adopted existing bridge PID=$PID (startedAt=$SPAWNED_AT)"
  else
    logw "Adoption skipped (${vstatus:-none}) — spawning new bridge"
    spawn_bridge
  fi
}

# ── Startup ──────────────────────────────────────────────────────────────
migrate_supervisor_state
DESIRED="$(read_desired_state)"
if [[ "$DESIRED" == "stopped" ]]; then
  handle_stopped   # exit 2
fi

PID=""
PLANNED_RESTART=0
START_REASON="watchdog-respawn"
adopt_or_spawn

# ── Main loop ────────────────────────────────────────────────────────────
while true; do
  LAST_POLL_AT=$(date +%s)
  # Monitor the current bridge until it dies or a planned restart is requested.
  while true; do
    poll_state

    # A planned command (restart/update/rollback) killed the bridge cleanly.
    if [[ "$PLANNED_RESTART" -eq 1 ]]; then
      break   # outer loop respawns — NOT an unplanned death
    fi

    # Suspend detection (clock jumped): grant one-cycle grace.
    _now_s=$(date +%s)
    _poll_gap=$(( _now_s - LAST_POLL_AT ))
    LAST_POLL_AT=$_now_s
    if (( _poll_gap > POLL * 3 )); then
      logw "Suspend detected (poll gap ${_poll_gap}s >> ${POLL}s) — granting one-cycle grace"
      sleep "$POLL_INTERVAL"
      continue
    fi

    # Bridge alive?
    if ! kill -0 "$PID" 2>/dev/null; then
      wait "$PID" 2>/dev/null   # reap the child
      # #1328: read the bridge's SELF-REPORTED exit code (lastExitCode), gated on
      # lastExitAt > SPAWNED_AT so a stale prior-death code is never reused.
      # Read-only (R2.2 forbids independent JSON *mutation*, not reads).
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

    # Stale heartbeat? (skip boot grace — 180s from SPAWNED_AT, which for an
    # adopted bridge is its true process age, so no new boot grace is granted)
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

  # Planned command caused the break: respawn immediately (no death record).
  if [[ "$PLANNED_RESTART" -eq 1 ]]; then
    PLANNED_RESTART=0
    [[ "$(read_desired_state)" == "stopped" ]] && handle_stopped
    spawn_bridge
    continue
  fi

  # Unplanned death: record + healthy accounting + bounded backoff.
  logw "Bridge died: $DEATH_REASON (PID=$PID)"
  svc record-death "$DEATH_REASON" 2>/dev/null
  svc record-healthy 2>/dev/null

  BACKOFF_MS="$(svc get-backoff 2>/dev/null || echo 0)"
  if [[ "$BACKOFF_MS" -gt 0 ]]; then
    BACKOFF_S=$(( BACKOFF_MS / 1000 ))
    # Bounded poll during backoff — check state every 5s (R3.5).
    for ((i=0; i<BACKOFF_S; i+=POLL_INTERVAL)); do
      poll_state
      [[ "$PLANNED_RESTART" -eq 1 ]] && break
      sleep "$POLL_INTERVAL"
    done
  fi

  [[ "$(read_desired_state)" == "stopped" ]] && handle_stopped
  spawn_bridge
done
