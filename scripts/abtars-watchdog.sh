#!/usr/bin/env bash
# Watchdog: start (or adopt) one bridge, poll alive + heartbeat, respawn on death.
# Uses supervisor.state for durable command and desired-state arbitration.
# Exit codes (R4): 0 no-op/duplicate, 1 fault, 2 durable stop, 3 running handoff
AB="${ABTARS_HOME:-$HOME/.abtars}"
# #1711 R2: identity is a literal argv comparison, so a trailing separator here
# would create a second identity class (never contained, never spawned beside).
while [[ "$AB" == */ && "$AB" != "/" ]]; do AB="${AB%/}"; done
if [[ "$AB" != /* ]]; then
  echo "FATAL: ABTARS_HOME must be absolute: $AB" >&2
  exit 1
fi
LOCK="$AB/bridge.lock"
STALE=300        # heartbeat staleness threshold (seconds)
POLL=60          # documented poll cadence
POLL_INTERVAL=5  # bounded state-poll slice (R3.5: check durable state <=5s)
WD_LOG="$AB/logs/watchdog.log"

# Resolve supervisor-state CLI entry (dev/alpha/stable/rollback). The source-only
# mode is used by the focused shell regression test to exercise the production
# helpers without starting a watchdog or acquiring the singleton lock.
SUPERVISOR_CLI=""
if [[ "${ABTARS_WATCHDOG_SOURCE_ONLY:-0}" != "1" ]]; then
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
fi

svc() { node "$SUPERVISOR_CLI" "$@"; }
logw() { echo "$(date +%FT%T) $*" >> "$WD_LOG"; }

# R8 transition-only logging: one line per distinct event, zero repetition for
# unchanged state. The key encodes the episode; a new episode re-logs.
log_event() {
  local key="$1"; shift
  if [[ "${LAST_EVENT_KEY:-}" != "$key" ]]; then
    logw "$*"
    LAST_EVENT_KEY="$key"
  fi
}

clear_ownership_episode() {
  if [[ "${OWNERSHIP_EPISODE_OPEN:-0}" == "1" ]]; then
    svc clear-ownership-episode 2>/dev/null || true
    OWNERSHIP_EPISODE_OPEN=0
    LAST_EVENT_KEY=""
  fi
}

# Read numeric lastHeartbeat from bridge.lock (R2.2: read-only, never mutates).
read_heartbeat() {
  grep -o '"lastHeartbeat":[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*'
}

# Track heartbeat advancement for the CURRENT deep-stale candidate window.
# A process may have heartbeated normally for days before its lock becomes
# unprovable; that earlier history must not permanently suppress the narrow
# R5 liveness escape. Once a deep-stale window starts, any later value change
# reopens the window and remains a veto until the next reset.
observe_liveness_heartbeat() {
  local hb now_ms changed=0
  hb="$(read_heartbeat)"
  [[ "$hb" =~ ^[0-9]+$ ]] || return 0
  if [[ "${LAST_HB_PREV:-}" =~ ^[0-9]+$ && "$hb" != "${LAST_HB_PREV:-}" ]]; then
    HB_ADVANCED=1
    LIVENESS_WINDOW_STARTED=0
    changed=1
  fi
  if (( changed == 0 && ${LIVENESS_WINDOW_STARTED:-0} == 0 )); then
    now_ms=$(( $(date +%s) * 1000 ))
    if (( now_ms - hb > 2 * STALE * 1000 )); then
      HB_ADVANCED=0
      LIVENESS_WINDOW_STARTED=1
    fi
  fi
  LAST_HB_PREV="$hb"
  LAST_OBSERVED_HB="$hb"
}

if [[ "${ABTARS_WATCHDOG_SOURCE_ONLY:-0}" != "1" ]]; then
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
fi

# ── Helpers ──────────────────────────────────────────────────────────────
migrate_supervisor_state() {
  if [[ "$(svc migrate 2>/dev/null)" == "migrated" ]]; then
    logw "Supervisor state migrated from legacy"
  fi
}

read_desired_state() { svc desired-state 2>/dev/null || echo "unavailable"; }

handle_stopped() {
  svc signal-bridge SIGTERM 2>/dev/null || true
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
      svc signal-bridge SIGTERM 2>/dev/null || true
      svc ack-command "$seq" 2>/dev/null
      logw "Watchdog exit: command=stop"
      exit 2
      ;;
    restart|update|rollback)
      # Planned bridge termination (R7.2 resets the rollback counter). Record
      # the freshly validated owner at the SAME authorization point as its
      # termination (#1711 R3 planned-replacement exception): during this
      # command's fence, exactly that PID/start identity may be disregarded by
      # the replacement proof. Validation failure = no exclusion; stop and
      # handoff never record one.
      read -r _ostatus _opid _oidentity <<< "$(svc owner-identity 2>/dev/null)"
      if [[ "$_ostatus" == "valid" && "$_opid" =~ ^[0-9]+$ && "$_opid" != "0" && -n "$_oidentity" && "$_oidentity" != "-" ]]; then
        EXCLUDE_PID="$_opid"
        EXCLUDE_IDENTITY="$_oidentity"
      else
        EXCLUDE_PID=""
        EXCLUDE_IDENTITY=""
      fi
      # #1719 R1: retain a SEPARATE copy of the predecessor identity for the
      # refusal classifier. The EXCLUDE_* pair above is one-shot (consumed by
      # the spawn proof); classification must use this retained copy, never a
      # later lock snapshot. Empty when validation failed = no predecessor
      # evidence, so the classifier stays fail-closed for that fence.
      FENCE_PRED_PID="$EXCLUDE_PID"
      FENCE_PRED_IDENTITY="$EXCLUDE_IDENTITY"
      FENCE_TYPE="$type"
      REFUSAL_COUNT=0
      svc signal-bridge SIGTERM 2>/dev/null || true
      svc reset-restart-count "command:$type" 2>/dev/null
      svc ack-command "$seq" 2>/dev/null
      logw "Planned bridge restart: command=$type"
      PID=""
      PLANNED_RESTART=1
      # A new planned command supersedes any abandoned-transition report from
      # a previous fence (#1719 R4.1): the operator has acted.
      if [[ "${TRANSITION_FAILED_OPEN:-0}" == "1" ]]; then
        svc clear-ownership-episode 2>/dev/null || true
        TRANSITION_FAILED_OPEN=0
      fi
      # Raise the transition fence (#1711 R7): observation-only through
      # termination, activation, overlap, and post-spawn ownership settling.
      TRANSITION_FENCE="planned-restart"
      FENCE_AT=$(date +%s)
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

# Return a complete, validated supervisor response or "transient". A status
# alone is not enough: truncated output such as "valid" must not bypass the
# retry path and become a false process-gone result.
read_bridge_identity() {
  local attempt=1 identity vstatus vpid vstarted vextra
  while (( attempt <= 3 )); do
    identity="$(svc validate-bridge 2>/dev/null)"
    vstatus=""
    vpid=""
    vstarted=""
    vextra=""
    read -r vstatus vpid vstarted vextra <<< "$identity"
    case "$vstatus" in
      valid|dead|reused|wrong-command|mismatch)
        # #1711 R4: required fields are status/pid/startedAt; declared trailing
        # metadata is tolerated. Only missing/malformed REQUIRED fields retry.
        if [[ "$vpid" =~ ^[0-9]+$ && "$vstarted" =~ ^[0-9]+$ ]]; then
          if [[ "$vstatus" != "valid" || "$vpid" != "0" ]]; then
            printf '%s %s %s\n' "$vstatus" "$vpid" "$vstarted"
            return 0
          fi
        fi
        ;;
    esac
    if (( attempt < 3 )); then
      poll_state
      if [[ "$PLANNED_RESTART" -eq 1 ]]; then
        echo "transient"
        return 0
      fi
      sleep "$POLL_INTERVAL"
    fi
    (( attempt++ ))
  done
  echo "transient"
}

# Wait for a heartbeat newer than the pre-suspend baseline. Return 0 after a
# fresh heartbeat or bounded timeout, and 2 when a planned restart was applied.
wait_for_resume_heartbeat() {
  local baseline_hb="$1" start_s="$2" deadline hb_now
  deadline=$(( start_s + POLL ))
  while (( $(date +%s) < deadline )); do
    poll_state
    [[ "$PLANNED_RESTART" -eq 1 ]] && return 2
    hb_now="$(read_heartbeat)"
    if [[ -n "$baseline_hb" && -n "$hb_now" && "$baseline_hb" -lt "$hb_now" ]]; then
      LAST_OBSERVED_HB="$hb_now"
      logw "Resume recovery: fresh heartbeat detected within ${POLL}s — resuming normal monitoring"
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  return 0
}

# Zero-process proof before ANY unplanned spawn (#1711 R3). Only a complete,
# successful enumeration proving zero exact same-home bridge processes
# authorizes spawn_bridge. During a planned restart/update/rollback fence, the
# ONE recorded terminated-owner identity (EXCLUDE_PID/EXCLUDE_IDENTITY) is
# disregarded so the replacement is not withheld by the dying owner; the
# exclusion is one-shot and cleared on veto, failed attempt, or fence end.
# Stop and handoff never set it. Unchanged state logs once.
# R2.1 (v5): `blocked-unattributable` lines carry relative-spelled processes no
# home could claim — they block the spawn and are logged LOUDLY (one event line
# per change of the blocking set, PID list included); a silent freeze is a
# spec violation (B13).
#
# Task 8A split: the authorization decision lives in prove_empty_once (ONE
# prove-empty invocation, no polling, no sleeping); spawn_if_proven_empty is
# only the recovery-path wrapper that repeats it on the existing poll cadence.
# Verdict of the last prove_empty_once call (fixed vocabulary):
#   spawned | occupied | inconclusive
SPAWN_PROOF_VERDICT=""

prove_empty_once() {
  local proof blocked=""
  SPAWN_PROOF_VERDICT="inconclusive"
  if [[ -n "${EXCLUDE_PID:-}" && -n "${EXCLUDE_IDENTITY:-}" ]]; then
    proof="$(svc prove-empty "$EXCLUDE_PID" "$EXCLUDE_IDENTITY" 2>/dev/null || echo inconclusive)"
  else
    proof="$(svc prove-empty 2>/dev/null || echo inconclusive)"
  fi
  blocked="$(printf '%s\n' "$proof" | grep '^blocked-unattributable ' || true)"
  case "$proof" in
    empty)
      # One-shot consumption: the exception authorizes exactly this attempt.
      EXCLUDE_PID=""
      EXCLUDE_IDENTITY=""
      # #1719 R1: snapshot bridge.lock's instanceId immediately before the
      # authorized spawn. The refusing child never reaches initBridgeLock,
      # so an UNCHANGED value after its exit proves it never took ownership;
      # a fresh value proves a genuine owner-generation failure (A24).
      PRES_SPAWN_INSTANCE="$(read_instance_field)"
      spawn_bridge
      SPAWN_PROOF_VERDICT="spawned"
      return 0
      ;;
    occupied*|inconclusive)
      # Any other/unknown process or an incomplete snapshot vetoes the
      # replacement: the exception dies with the attempt (R3).
      if [[ -n "${EXCLUDE_PID:-}" ]]; then
        logw "Planned-replacement exclusion vetoed (${proof%%$'\n'*}) — ordinary zero-process proof applies"
        EXCLUDE_PID=""
        EXCLUDE_IDENTITY=""
      fi
      # R2.1 loud block: unattributable relative-spelled processes carry
      # PID + argv + reason; one event line per change of the blocking set.
      if [[ -n "$blocked" ]]; then
        log_event "blocked:$blocked" "Spawn withheld: $blocked — cannot be attributed to any home; restart or terminate these processes to restore supervision"
      fi
      case "$proof" in
        occupied*)
          log_event "withheld:${proof%%$'\n'*}" "Spawn withheld: ${proof%%$'\n'*} exact same-home process(es) — refusing to create a duplicate"
          SPAWN_PROOF_VERDICT="occupied"
          ;;
        *)
          log_event "withheld:inconclusive" "Spawn withheld: process enumeration inconclusive"
          SPAWN_PROOF_VERDICT="inconclusive"
          ;;
      esac
      return 0
      ;;
  esac
}

# Recovery-path wrapper: repeats the one-shot proof until it authorizes a
# spawn, delegating every consumption/veto/logging rule to prove_empty_once.
# Each iteration also runs the SHARED reconciliation tick (Task 8A): while the
# wrapper holds, the typed boundary must stay live or an extra could never be
# contained (B7's owner-died-first shape starved containment forever here).
#
# A12 deadlock fix: an occupant that has SINCE become the validated owner
# (e.g. a replacement that outlived a stale-lock misread) is adopted through
# the existing adoption path instead of being withheld forever — EXCEPT the
 #1719 refusal shape (retained fence predecessor alive and unchanged), which
# keeps its own bounded budget and transition-failed accounting.
# Startup admission NEVER loops in the blocking form — it drives the one-shot
# directly between reconciliation ticks.
spawn_if_proven_empty() {
  while true; do
    prove_empty_once
    [[ "$SPAWN_PROOF_VERDICT" == "spawned" ]] && return 0
    run_reconciliation_tick
    if ! classify_planned_refusal && adopt_validated_bridge; then
      return 0
    fi
    poll_state
    sleep "$POLL_INTERVAL"
  done
}

# ── Typed reconciliation integration (#1711 Phase 2) ─────────────────────
# Shell state (in-memory, watchdog lifetime):
#   RECON_TOKEN / RECON_COUNT — consecutive identical boundary nominations
#   TRANSITION_FENCE / FENCE_AT — planned-transition protection (R7)
#   LAST_HB_PREV / HB_ADVANCED — frozen-heartbeat observation window (R5)
#
# The shell only compares opaque tokens and counts; it never parses process
# records or chooses targets. Containment runs through svc contain, which
# revalidates everything fresh.
handle_reconciliation_line() {
  local line="$1" dec tok auth
  dec="${line%% *}"
  line="${line#* }"
  tok="${line%% *}"
  line="${line#* }"
  auth="${line#authority=}"
  dec="${dec#decision=}"
  tok="${tok#token=}"

  case "$dec" in
    extra-candidate|contain-extra)
      if [[ "$tok" == "${RECON_TOKEN:-}" ]]; then
        RECON_COUNT=$(( ${RECON_COUNT:-0} + 1 ))
      else
        RECON_TOKEN="$tok"
        RECON_COUNT=1
      fi
      if (( RECON_COUNT >= 3 )); then
        local cpid cid cres
        cpid="${tok%%:*}"
        cid="${tok#*:}"
        logw "Containment decision ($auth) for extra PID=$cpid"
        cres="$(svc contain "$cpid" "$cid" "$auth" "$TRANSITION_FENCE" "${HB_ADVANCED:-0}" 2>/dev/null || echo "failed invoke")"
        logw "Containment result: $cres"
        RECON_TOKEN=""
        RECON_COUNT=0
      fi
      ;;
    ownership-inconclusive)
      # Marker persisted by the boundary; one event line on entry (R8).
      log_event "recon-inconclusive:${tok}" "Reconciliation: ownership inconclusive (${auth}) — holding supervision"
      RECON_TOKEN=""
      RECON_COUNT=0
      ;;
    enumeration-failed)
      log_event "recon-enumfail" "Reconciliation: process enumeration failed — holding fail-closed"
      RECON_TOKEN=""
      RECON_COUNT=0
      ;;
    clean|none|owner-missing|planned-transition)
      RECON_TOKEN=""
      RECON_COUNT=0
      ;;
  esac
}

# Shared typed-boundary invocation (#1711 Task 8A): exactly ONE reconcile call
# per tick, used by BOTH the steady-state monitor loop and startup admission.
# Forwards the existing fence and frozen-heartbeat window evidence, passes the
# fixed-vocabulary result to the opaque-token counter, and records the bare
# decision word in RECON_DECISION for callers that branch on it. Empty means
# the boundary did not run or said nothing — always fail-closed for callers.
RECON_DECISION=""
run_reconciliation_tick() {
  RECON_DECISION=""
  observe_liveness_heartbeat
  # (#1719 R4.1) While an abandoned-transition episode is open the boundary
  # is NOT invoked: both channels share the one durable episode marker, and
  # the boundary clears it on every clean decision — which would silently
  # erase the operator-visible transition report one tick after it was
  # written. Supervision stays fully live here (validated sole owner,
  # stale-heartbeat containment remains shell-side); escalation authority
  # for the predecessor stays with #1711's reconciliation executor.
  if [[ "${TRANSITION_FAILED_OPEN:-0}" == "1" ]]; then
    return 0
  fi
  local _line
  _line="$(svc reconcile "${TRANSITION_FENCE:-stable}" "${LAST_HB_PREV:--}" "${HB_ADVANCED:-0}" 2>/dev/null || true)"
  [[ -z "$_line" ]] && return 0
  RECON_DECISION="${_line%% *}"; RECON_DECISION="${RECON_DECISION#decision=}"
  handle_reconciliation_line "$_line"
}

# ── Planned-fence refusal classification (#1719) ────────────────────────────
# A replacement that dies at the production duplicate gate while the recorded
# predecessor still holds the lock is a PLANNED outcome, not an unplanned
# death: recording it inflates restartCount/backoff and four such suicides trip
# circuit-breaker MAX_DEATHS — an auto-rollback of a healthy release.

# Raw instanceId field read; identical input → identical output. An absent or
# unparseable value reads as empty, which IS the sentinel (R1): unchanged-missing
# stays distinguishable from a fresh child identity. Read-only (R2.2).
read_instance_field() {
  grep -o '"instanceId":"[^"]*"' "$LOCK" 2>/dev/null | head -n 1
}

# Three-part predicate (requirements R2 / design failure matrix). Ordered so
# any missing or uncertain piece of evidence falls through to ordinary-death:
#   stable fence                     -> ordinary death accounting
#   predecessor gone/reused/mismatch -> ordinary death accounting
#   child wrote its own instanceId   -> genuine in-fence crash accounting
# The exit code is intentionally absent from this predicate: main.ts registers
# its exit handler AFTER the duplicate-gate arms, so a refusal never writes
# lastExitCode and process-gone:exit=unknown carries no signal.
classify_planned_refusal() {
  [[ "${TRANSITION_FENCE:-stable}" != "stable" ]] || return 1
  [[ -n "${FENCE_PRED_PID:-}" && -n "${FENCE_PRED_IDENTITY:-}" ]] || return 1
  local rstatus rpid ridentity
  read -r rstatus rpid ridentity <<< "$(svc owner-identity 2>/dev/null)"
  # Identity-aware fresh probe only — never kill -0, never a cached lock read.
  [[ "$rstatus" == "valid" && "$rpid" == "${FENCE_PRED_PID:-}" && "$ridentity" == "${FENCE_PRED_IDENTITY:-}" ]] || return 1
  [[ "$(read_instance_field)" == "${PRES_SPAWN_INSTANCE:-}" ]] || return 1
  return 0
}

# Re-enter the existing planned replacement authorization for a bounded retry
# (#1719 design: the retry must NOT resurrect the consumed exclusion without a
# fresh one). Same pattern as apply_command's authorization point: a fresh
# owner-identity probe that still matches the retained fence predecessor
# re-arms the one-shot exclusion; anything else leaves it empty and the
# ordinary zero-process proof decides.
refresh_replacement_authorization() {
  local rstatus rpid ridentity
  read -r rstatus rpid ridentity <<< "$(svc owner-identity 2>/dev/null)"
  if [[ "$rstatus" == "valid" && "$rpid" == "$FENCE_PRED_PID" && "$ridentity" == "$FENCE_PRED_IDENTITY" ]]; then
    EXCLUDE_PID="$rpid"
    EXCLUDE_IDENTITY="$ridentity"
  else
    EXCLUDE_PID=""
    EXCLUDE_IDENTITY=""
  fi
}

if [[ "${ABTARS_WATCHDOG_SOURCE_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

# Spawn exactly one bridge. $! is the real node PID (exec replaces the subshell).
# NB: `exec` and `nohup node` MUST stay on one physical line — the #1261 guard
# asserts this so $! is the node PID, not a bash subshell.
spawn_bridge() {
  cd "$AB" && exec env ABTARS_WATCHDOG_PID=$$ NODE_PATH="$HOME/.local/lib/node_modules:${NODE_PATH:-}" ABTARS_START_REASON="${START_REASON:-watchdog-respawn}" nohup node --max-old-space-size=1024 "$AB/app/bundle/abtars.js" 200>&- &
  PID=$!
  disown $PID   # #1050: survive watchdog SIGTERM/HUP — bridge must not die with us
  SPAWNED_AT=$(date +%s)
  PLANNED_RESTART=0
  # New child = fresh observation windows (#1711 R5/R6/R7).
  RECON_TOKEN=""
  RECON_COUNT=0
  HB_ADVANCED=0
  LAST_HB_PREV=""
  LIVENESS_WINDOW_STARTED=0
}

# Adopt one valid existing bridge; otherwise enter STARTUP ADMISSION (v6/B11).
# The v6 defect: failed adoption fell straight into the BLOCKING spawn-proof
# loop, so a live exact process behind an unvalidated lock never reached the
# reconciliation boundary — "Adoption skipped" + "Spawn withheld" forever, no
# decision, no containment, permanent hold.
adopt_or_spawn() {
  if adopt_validated_bridge; then
    return 0
  fi
  logw "Adoption skipped (${_adopt_status:-none}) — entering startup reconciliation admission"
  PID=""
  startup_admission
}

# Startup admission loop (requirements R3 "Startup admission and non-blocking
# proof"): poll durable commands, retry FRESH validated adoption, run the SAME
# typed reconciliation boundary as steady state, and invoke the ONE-SHOT
# zero-process proof only after a complete `none` decision. An occupied or
# inconclusive proof returns control to the next tick — it must never sleep
# inside the proof. While no trusted PID exists here, the cached-PID death,
# stale-heartbeat, and child-reaping branches stay unreachable; a process that
# becomes valid is freshly adopted before any containment acts on it.
startup_admission() {
  local _grace
  while true; do
    poll_state   # commands/desired-state first; stop still exits 2 (R3 order 1)

    # A planned command claimed during the hold: its existing fence and
    # one-shot replacement proof govern (R3) — same sequence as the
    # post-death planned-restart branch, never the ordinary unplanned proof.
    if [[ "$PLANNED_RESTART" -eq 1 ]]; then
      PLANNED_RESTART=0
      [[ "$(read_desired_state)" == "stopped" ]] && handle_stopped
      if [[ -n "$EXCLUDE_PID" ]]; then
        _grace=0
        while (( _grace < 12 )); do
          kill -0 "$EXCLUDE_PID" 2>/dev/null || break
          poll_state
          sleep "$POLL_INTERVAL"
          _grace=$((_grace+1))
        done
      fi
      spawn_if_proven_empty
      return 0
    fi

    # Fence hard cap applies while holding an unvalidated population too
    # (R7): a command may not create a permanent startup fence.
    if [[ "$TRANSITION_FENCE" != "stable" ]] && (( $(date +%s) - FENCE_AT > 300 )); then
      TRANSITION_FENCE="stable"
      HB_ADVANCED=0
      LAST_HB_PREV=""
      LIVENESS_WINDOW_STARTED=0
      EXCLUDE_PID=""
      EXCLUDE_IDENTITY=""
      REFUSAL_COUNT=0
    fi

    if adopt_validated_bridge; then
      return 0   # fresh validated-owner adoption -> normal monitor loop
    fi

    run_reconciliation_tick   # R3 order 3 — same boundary as steady state

    # R3 orders 4-5: only a complete none decision authorizes ONE zero-process
    # proof attempt; occupied/inconclusive falls back to the next tick.
    if [[ "$RECON_DECISION" == "none" && "$TRANSITION_FENCE" == "stable" ]]; then
      prove_empty_once
      [[ "$SPAWN_PROOF_VERDICT" == "spawned" ]] && return 0
    fi

    sleep "$POLL_INTERVAL"
  done
}

# #1719: adoption half of adopt_or_spawn, extracted so fence-budget exhaustion
# can adopt the validated predecessor through the SAME existing path (no new
# mechanism, no new boot grace per R6.6). Returns 1 when no valid bridge can
# be adopted.
adopt_validated_bridge() {
  local vstatus vpid vstarted
  read -r vstatus vpid vstarted <<< "$(svc validate-bridge 2>/dev/null)"
  _adopt_status="$vstatus"
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
    return 0
  fi
  return 1
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
LAST_OBSERVED_HB=""
OWNERSHIP_EPISODE_OPEN=0
LAST_EVENT_KEY=""
RECON_TOKEN=""
RECON_COUNT=0
RECON_DECISION=""
TRANSITION_FENCE="stable"
FENCE_AT=0
LAST_HB_PREV=""
HB_ADVANCED=0
LIVENESS_WINDOW_STARTED=0
EXCLUDE_PID=""
EXCLUDE_IDENTITY=""
# #1719 planned-fence refusal state (in-memory only, watchdog lifetime — a
# restarted watchdog starts with a stable fence and NO predecessor evidence,
# so it can never become an unbounded retry escape).
FENCE_PRED_PID=""
FENCE_PRED_IDENTITY=""
FENCE_TYPE=""
REFUSAL_COUNT=0
TRANSITION_FAILED_OPEN=0
PRES_SPAWN_INSTANCE=""
adopt_or_spawn
LAST_OBSERVED_HB="$(read_heartbeat)"

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

    # Suspend detection (clock jumped): bounded fresh-heartbeat wait (R4.2).
    _now_s=$(date +%s)
    _poll_gap=$(( _now_s - LAST_POLL_AT ))
    LAST_POLL_AT=$_now_s
    if (( _poll_gap > POLL * 3 )); then
      logw "Suspend detected (poll gap ${_poll_gap}s >> ${POLL}s) — entering bounded resume wait"
      _baseline_hb="${LAST_OBSERVED_HB:-$(read_heartbeat)}"
      wait_for_resume_heartbeat "$_baseline_hb" "$_now_s"
      if [[ "$?" -eq 2 ]]; then
        break   # outer loop respawns
      fi
      continue
    fi

    # Typed reconciliation boundary (#1711 Phase 2): one invocation per tick
    # through the shared helper (Task 8A) — the same boundary startup
    # admission runs. The shell forwards its fence state and frozen-heartbeat
    # window evidence; the boundary classifies, maintains the episode marker,
    # and may nominate a containment candidate. The shell only counts tokens.
    run_reconciliation_tick

    # Bridge alive and still the validated process? Never trust a cached PID:
    # PID reuse must be classified before any signal is sent. Bounded retry
    # for transient results (empty output, corrupt) — see design #1499.
    read -r _vstatus _vpid _vstarted <<< "$(read_bridge_identity)"
    if [[ "$PLANNED_RESTART" -eq 1 ]]; then
      break   # outer loop handles the planned restart
    fi
    case "$_vstatus" in
      valid)
        # Post-transition ownership settling (#1711 R7): the first validated
        # observation of the current PID clears the fence; a hard cap prevents
        # a permanent fence if settling never confirms.
        if [[ "$TRANSITION_FENCE" != "stable" ]]; then
          if [[ "$_vpid" == "$PID" ]] || (( $(date +%s) - FENCE_AT > 300 )); then
            TRANSITION_FENCE="stable"
            HB_ADVANCED=0
            LAST_HB_PREV=""
            LIVENESS_WINDOW_STARTED=0
            # Fence end clears any unconsumed replacement exclusion (R3/R7)
            # and closes the refusal budget (#1719 R4).
            EXCLUDE_PID=""
            EXCLUDE_IDENTITY=""
            REFUSAL_COUNT=0
          fi
        fi
        # #1719 R4.1: an abandoned-transition report is only for the recorded
        # predecessor. The moment a DIFFERENT validated owner is observed — a
        # late replacement after containment, or any completed transition —
        # the diagnostic latch clears; no permanent hidden hold may remain.
        if [[ "${TRANSITION_FAILED_OPEN:-0}" == "1" && "$_vpid" != "$FENCE_PRED_PID" ]]; then
          svc clear-ownership-episode 2>/dev/null || true
          TRANSITION_FAILED_OPEN=0
        fi
        if [[ "$_vpid" != "$PID" ]]; then
          # Validated PID mismatch — existing terminal behavior.
          clear_ownership_episode
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
        clear_ownership_episode
        ;;
      transient)
        # Exhausted transient validation attempts: fall back to cached PID liveness.
        if kill -0 "$PID" 2>/dev/null; then
          # #1711 R5/P7: enter a BOUNDED ownership-inconclusive episode — one
          # durable marker, ONE log line, no repetition while unchanged. The
          # healthy-or-not question stays open; we never signal here.
          if [[ "${OWNERSHIP_EPISODE_OPEN:-0}" != "1" ]]; then
            svc set-ownership-episode "validation-inconclusive:cached-pid=$PID" 2>/dev/null || true
            OWNERSHIP_EPISODE_OPEN=1
            LAST_EVENT_KEY=""
            log_event "episode:$PID" "Ownership inconclusive after validation attempts — holding supervision of cached PID $PID"
          fi
          sleep "$POLL_INTERVAL"
          continue
        fi
        # Cached PID is dead — existing process-gone path.
        clear_ownership_episode
        wait "$PID" 2>/dev/null   # reap the child
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
        ;;
      dead|reused|wrong-command|mismatch)
        # Boot-window guard: a JUST-SPAWNED bridge has not written its lock
        # yet, and a MISSING lock validates as definitive dead — recording a
        # death for the healthy newborn is the spawn boot race, not a real
        # outcome. Hold (no reaping, no accounting) while the lock is absent
        # inside the boot-grace window; the next tick revalidates. An EXISTING
        # lock with a terminal verdict keeps the unchanged path below. The
        # literal matches the boot-grace transform anchor.
        if [[ ! -f "$LOCK" && "$_vpid" == "0" ]] && (( $(date +%s) - SPAWNED_AT < 180 )); then
          sleep "$POLL_INTERVAL"
          continue
        fi
        # Definitive identity result — existing terminal behavior unchanged.
        clear_ownership_episode
        wait "$PID" 2>/dev/null   # reap the child
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
        ;;
    esac

    # Stale heartbeat? (skip boot grace — 180s from SPAWNED_AT, which for an
    # adopted bridge is its true process age, so no new boot grace is granted)
    (( $(date +%s) - SPAWNED_AT < 180 )) && { sleep "$POLL_INTERVAL"; continue; }
    HB=$(grep -o '"lastHeartbeat":[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*')
    NOW=$(($(date +%s) * 1000))
    if [[ -n "$HB" ]] && (( (NOW - HB) / 1000 > STALE )); then
      DEATH_REASON="stale-heartbeat:$(( (NOW - HB) / 1000 ))s"
      svc signal-bridge SIGKILL 2>/dev/null || true
      break
    fi

    # Account for continuous health while it is actually observed. Without
    # this call restartCount/backoff never decay after a successful recovery.
    _health_now=$(date +%s)
    if (( _health_now - ${LAST_HEALTH_ACCOUNT:-0} >= 60 )); then
      svc record-healthy 2>/dev/null || true
      LAST_HEALTH_ACCOUNT=$_health_now
    fi

    sleep "$POLL_INTERVAL"
  done

  # Planned command caused the break: respawn immediately (no death record).
  if [[ "$PLANNED_RESTART" -eq 1 ]]; then
    PLANNED_RESTART=0
    [[ "$(read_desired_state)" == "stopped" ]] && handle_stopped
    # Bounded grace (#1711 A9/A20): let a HEALTHY terminated owner finish
    # exiting so the replacement boots clean. A TERM-ignorer past grace is
    # handled by the R3 exclusion in spawn_if_proven_empty (deliberate
    # overlap). kill -0 here only ends the wait early; it never CREATES the
    # exception — that required fresh validation at the authorization point.
    if [[ -n "$EXCLUDE_PID" ]]; then
      _grace=0
      while (( _grace < 12 )); do
        kill -0 "$EXCLUDE_PID" 2>/dev/null || break
        poll_state
        sleep "$POLL_INTERVAL"
        _grace=$((_grace+1))
      done
    fi
    spawn_if_proven_empty
    continue
  fi

  # ── Planned-fence refusal classification (#1719 R2/R4) ──────────────────
  # Runs AFTER a process-gone outcome and BEFORE any unplanned accounting.
  # Only process-gone is eligible: a stale-heartbeat kill is a deliberate
  # containment signal and always follows ordinary accounting (A6 untouched).
  # Positive classification requires ALL evidence; anything missing or
  # uncertain falls through to the ordinary death path below.
  if [[ "$DEATH_REASON" == process-gone:* ]] && classify_planned_refusal; then
    REFUSAL_COUNT=$((REFUSAL_COUNT + 1))
    if (( REFUSAL_COUNT < 3 )); then
      logw "Planned boot-gate refusal ${REFUSAL_COUNT}/3 during command=${FENCE_TYPE:-unknown} (predecessor PID=$FENCE_PRED_PID alive, lock identity unchanged) — retrying authorized replacement"
      # Bounded retry through the EXISTING authorization + zero-process proof;
      # never spawn_bridge directly, never a resurrected exclusion (invariant 7).
      refresh_replacement_authorization
      spawn_if_proven_empty
      continue
    fi
    # Budget exhausted (R4/R4.1): exactly ONE stable transition-failed episode
    # naming the predecessor PID, the abandoned transition surfaced durably
    # through doctor//status (ownership-episode marker; never a health claim),
    # and ADOPTION of the validated predecessor via the existing adoption
    # path — without adoption the loop would keep re-detecting the dead child
    # PID against the predecessor's valid lock, forever.
    log_event "transition-failed:$FENCE_PRED_PID" "Transition failed: command=${FENCE_TYPE:-unknown} predecessor PID=$FENCE_PRED_PID survived $REFUSAL_COUNT replacement attempts — adopting predecessor; requested transition is abandoned"
    svc set-ownership-episode "transition-failed:${FENCE_TYPE:-unknown} predecessor-pid=${FENCE_PRED_PID}" 2>/dev/null || true
    TRANSITION_FAILED_OPEN=1
    REFUSAL_COUNT=0
    if ! adopt_validated_bridge; then
      # Predecessor unprovable inside the classification window: fall back to
      # the ordinary fail-closed proof path (never a direct spawn).
      spawn_if_proven_empty
    fi
    continue
  fi

  # Unplanned death: record + healthy accounting + bounded backoff.
  # (#1719) An ordinary outcome also breaks the consecutive-refusal sequence.
  REFUSAL_COUNT=0
  logw "Bridge died: $DEATH_REASON (PID=$PID)"
  svc record-death "$DEATH_REASON" 2>/dev/null
  svc record-healthy 2>/dev/null

  BACKOFF_MS="$(svc get-backoff 2>/dev/null || echo 0)"
  if [[ "$BACKOFF_MS" -gt 0 ]]; then
    BACKOFF_S=$(( BACKOFF_MS / 1000 ))
    # Bounded poll during backoff — check state every 5s (R3.5).
    _remaining=$BACKOFF_S
    while (( _remaining > 0 )); do
      poll_state
      [[ "$PLANNED_RESTART" -eq 1 ]] && break
      _slice=$(( _remaining < POLL_INTERVAL ? _remaining : POLL_INTERVAL ))
      sleep "$_slice"
      _remaining=$(( _remaining - _slice ))
    done
  fi

  [[ "$(read_desired_state)" == "stopped" ]] && handle_stopped
  spawn_if_proven_empty
done
