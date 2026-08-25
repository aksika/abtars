#!/usr/bin/env bash
# Watchdog M-suite executor (#1712): shell-owned mock projections of selected
# acceptance contracts, executed through the production source-only seam
# (ABTARS_WATCHDOG_SOURCE_ONLY=1) of scripts/abtars-watchdog.sh.
#
# Contract: exactly one machine-readable row per case on stdout:
#   <M-ID><TAB>pass|fail<TAB>detail
# fast.ts classifies these rows against the reviewed manifest; this file owns
# no scoreboard policy.
#
# Usage: abtars-watchdog.test.sh [MA08 MA09 ...]   (default: all 12)
#
# Safety: no watchdog, bridge, supervisor/doctor CLI, esbuild, or other
# long-lived process is started. Clock and sleep are deterministic doubles;
# svc, process enumeration, and signal targets are stubs. A post-run scan
# proves no child process was left behind. check-watchdog-shape.mjs remains a
# separate self-check (npm run check:watchdog-shape), not an M case.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WD_SH="$SCRIPT_DIR/abtars-watchdog.sh"

if [[ ! -f "$WD_SH" ]]; then
  echo "FATAL: $WD_SH not found" >&2
  exit 1
fi

ALL_M_IDS=(MA08 MA09 MA12 MA20 MA21 MA24 MB02 MB09 MB10 MB11 MB13 MB14)

# ── Selection ────────────────────────────────────────────────────────────────
REQUESTED=()
if (( $# > 0 )); then
  for arg in "$@"; do
    id="$(echo "$arg" | tr '[:lower:]' '[:upper:]')"
    ok=0
    for known in "${ALL_M_IDS[@]}"; do
      [[ "$id" == "$known" ]] && ok=1
    done
    if (( ok == 0 )); then
      echo "FATAL: unknown M selector '$arg' (approved set: ${ALL_M_IDS[*]})" >&2
      exit 2
    fi
    REQUESTED+=("$id")
  done
else
  REQUESTED=("${ALL_M_IDS[@]}")
fi

RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/abtars-watchdog-m.XXXXXX")"
trap 'rm -rf "$RUN_ROOT"' EXIT
PRELUDE="$RUN_ROOT/prelude.sh"

# Deterministic clock/sleep doubles plus tiny assert helpers, sourced by every
# case child BEFORE the production script so waits become clock steps.
cat > "$PRELUDE" <<'PRELUDE_EOF'
WD_FAKE_EPOCH="${WD_FAKE_EPOCH:-1700000000}"
date() {
  case "${1:-}" in
    +%FT%T) echo "2023-11-14T22:13:20+00:00" ;;
    *) echo "$WD_FAKE_EPOCH" ;;
  esac
}
sleep() {
  local s="${1:-0}"
  WD_FAKE_EPOCH=$(( WD_FAKE_EPOCH + ${s%%.*} ))
  [[ "$s" == *.* ]] && WD_FAKE_EPOCH=$(( WD_FAKE_EPOCH + 1 ))
  return 0
}
wd_log_lines() { cat "${CASE_HOME}/logs/watchdog.log" 2>/dev/null || true; }
wd_assert_eq() {
  if [[ "$1" != "$2" ]]; then
    printf 'assert failed: %s (got <%s>, want <%s>)\n' "$3" "$1" "$2" >&2
    exit 10
  fi
}
wd_assert() {
  if [[ "$1" != "1" ]]; then
    printf 'assert failed: %s\n' "$2" >&2
    exit 10
  fi
}
PRELUDE_EOF

PASS=0
FAILS=0

emit() { # emit <id> <pass|fail> <detail>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3"
  if [[ "$2" == "pass" ]]; then
    PASS=$((PASS + 1))
  else
    FAILS=$((FAILS + 1))
  fi
}

# Run one case child: $1 = case label; stdin = child script body. The child
# gets its own home with logs/, the prelude doubles, and the source-only seam.
# The label doubles as the evidence home name, so sub-legits use distinct ones.
run_child() {
  local label="$1"
  local home="$RUN_ROOT/$label/home"
  mkdir -p "$home/logs"
  local body="$RUN_ROOT/$label.child.sh"
  cat > "$body"
  (
    cd /
    export WD_SH_PATH="$WD_SH" PRELUDE="$PRELUDE" CASE_HOME="$home"
    export ABTARS_WATCHDOG_SOURCE_ONLY=1 ABTARS_HOME="$home"
    exec bash "$body"
  ) 2>"$RUN_ROOT/$label.stderr"
}

child_detail() { # bounded one-line tail of a failing child's stderr files
  local f out=""
  for f in "$RUN_ROOT/$1"*.stderr; do
    [[ -e "$f" ]] || continue
    out+="$(tail -n 2 "$f")"
  done
  printf '%s' "${out//$'\n'/;}" | cut -c1-200
}

finish_case() { # finish_case <id> <rc...>: pass iff every rc is 0
  local id="$1"; shift
  local rc bad=""
  for rc in "$@"; do
    [[ "$rc" == "0" ]] || bad="$bad$rc "
  done
  if [[ -z "$bad" ]]; then
    emit "$id" pass "ok"
  else
    emit "$id" fail "$(child_detail "$id")"
  fi
}

# ── MA08: bounded resume observes heartbeat advancement, never signals ──────
case_MA08() {
  run_child MA08 <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
TERMINATE_FLAG=0
POLL=3
POLL_INTERVAL=1
svc() {
  case "$1" in
    signal-bridge) echo x > "$CASE_HOME/signals" ;;
    desired-state) echo "running" ;;
  esac
  return 0
}
printf '{"pid":4242,"lastHeartbeat":5000,"startedAt":%s000}\n' "$WD_FAKE_EPOCH" > "$LOCK"
# (a) heartbeat advances within the wait -> success, fresh value observed.
LAST_OBSERVED_HB="5000"; PLANNED_RESTART=0
printf '{"pid":4242,"lastHeartbeat":6000,"startedAt":%s000}\n' "$WD_FAKE_EPOCH" > "$LOCK"
wait_for_resume_heartbeat "5000" "$WD_FAKE_EPOCH"
wd_assert_eq "$?" "0" "advanced heartbeat must return success"
wd_assert_eq "$LAST_OBSERVED_HB" "6000" "production helper must record the fresh heartbeat"
wd_assert_eq "$(wd_log_lines | grep -c 'Resume recovery')" "1" "exactly one recovery event line"
wd_assert_eq "$(ls "$CASE_HOME/signals" 2>/dev/null | wc -l)" "0" "resume wait must not signal during heartbeat advancement"
# (b) heartbeat frozen -> bounded timeout, still no signal, no stall.
printf '{"pid":4242,"lastHeartbeat":5000,"startedAt":%s000}\n' "$WD_FAKE_EPOCH" > "$LOCK"
LAST_OBSERVED_HB="5000"; PLANNED_RESTART=0
START_EPOCH="$WD_FAKE_EPOCH"
wait_for_resume_heartbeat "5000" "$START_EPOCH"
wd_assert_eq "$?" "0" "bounded timeout returns success (watchdog keeps supervising)"
ELAPSED=$(( WD_FAKE_EPOCH - START_EPOCH ))
wd_assert "$(( ELAPSED >= POLL ))" "1" "timeout path must be bounded by POLL (${ELAPSED} < ${POLL})"
wd_assert "$(( ELAPSED < POLL + 5 ))" "1" "timeout path must terminate promptly after the deadline (${ELAPSED})"
wd_assert_eq "$LAST_OBSERVED_HB" "5000" "frozen heartbeat must not be misreported as advanced"
wd_assert_eq "$(ls "$CASE_HOME/signals" 2>/dev/null | wc -l)" "0" "resume timeout must not signal"
EOF
  finish_case MA08 $?
}

# ── MA09: apply_command ordering + planned-restart fence/exclusion ──────────
case_MA09() {
  run_child MA09a <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
TRANSCRIPT="$CASE_HOME/transcript"
: > "$TRANSCRIPT"
svc() {
  printf '%s\n' "$*" >> "$TRANSCRIPT"
  case "$1" in
    claim-command) echo "41 restart" ;;
    owner-identity) echo "valid 777 777:33" ;;
  esac
  return 0
}
TRANSITION_FENCE="stable"
TRANSITION_FAILED_OPEN=0
PLANNED_RESTART=0
apply_command || true
want=$'claim-command\nowner-identity\nsignal-bridge SIGTERM\nreset-restart-count command:restart\nack-command 41'
wd_assert_eq "$(cat "$TRANSCRIPT")" "$want" "apply_command ordering must be claim/authorize/signal/reset/ack"
wd_assert_eq "$TRANSITION_FENCE" "planned-restart" "planned restart raises the transition fence"
wd_assert_eq "$PLANNED_RESTART" "1" "planned restart flag set for the monitor loop"
wd_assert_eq "$EXCLUDE_PID/$EXCLUDE_IDENTITY" "777/777:33" "freshly validated owner becomes the one-shot exclusion"
wd_assert_eq "$FENCE_PRED_PID/$FENCE_PRED_IDENTITY" "777/777:33" "refusal classifier retains its own predecessor copy"
wd_assert_eq "${REFUSAL_COUNT:-}" "0" "refusal budget starts at zero for this fence"
EOF
  local ra=$?

  run_child MA09b <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
CALLARGS="$CASE_HOME/calls.log"; SPAWN_LOG="$CASE_HOME/spawns.log"
: > "$CALLARGS"; : > "$SPAWN_LOG"
SEQ="occupied 3;empty"
svc() {
  printf '%s\n' "$*" >> "$CALLARGS"
  if [[ "$1" == "prove-empty" ]]; then
    local n seqs out
    n="$(cat "$CASE_HOME/.seqpos" 2>/dev/null || echo 0)"
    echo $((n+1)) > "$CASE_HOME/.seqpos"
    IFS=';' read -ra seqs <<< "$SEQ"
    out="${seqs[$n]:-}"
    [[ -z "$out" ]] && out="empty"
    printf '%s' "$out"
  fi
  return 0
}
spawn_bridge() { echo x >> "$SPAWN_LOG"; }
poll_state() { :; }
POLL_INTERVAL=0
printf '{"instanceId":"pred-instance","pid":777,"lastHeartbeat":1}\n' > "$LOCK"
EXCLUDE_PID=777; EXCLUDE_IDENTITY="777:33"
spawn_if_proven_empty >/dev/null 2>&1
wd_assert_eq "$(wc -l < "$SPAWN_LOG")" "1" "replacement spawns exactly once once proof turns empty"
wd_assert_eq "$(grep -c '^prove-empty 777 777:33$' "$CALLARGS")" "1" "exclusion forwarded to prove-empty exactly once"
wd_assert "$(($(grep -c '^prove-empty$' "$CALLARGS") >= 1))" "1" "post-veto proofs go without the exclusion"
wd_assert_eq "$(grep -c 'Planned-replacement exclusion vetoed' "$CASE_HOME/logs/watchdog.log")" "1" "veto logged exactly once"
wd_assert_eq "${EXCLUDE_PID}/${EXCLUDE_IDENTITY}" "/" "one-shot exclusion consumed after the authorized spawn"
EOF
  local rb=$?
  finish_case MA09 $ra $rb
}

# ── MA12: unknown command drained; next legitimate command applies ─────────
case_MA12() {
  run_child MA12 <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
TRANSCRIPT="$CASE_HOME/transcript"
: > "$TRANSCRIPT"
NEXT_CLAIM="7 frobnicate"
svc() {
  printf '%s\n' "$*" >> "$TRANSCRIPT"
  case "$1" in
    claim-command)
      printf '%s\n' "$NEXT_CLAIM"
      NEXT_CLAIM="" ;;
    owner-identity) echo "valid 888 888:9" ;;
  esac
  return 0
}
TRANSITION_FENCE="stable"
TRANSITION_FAILED_OPEN=0
PLANNED_RESTART=0
apply_command || true
wd_assert_eq "$(cat "$TRANSCRIPT")" $'claim-command\nack-command 7' "unknown command must only be claimed then acknowledged"
wd_assert_eq "$PLANNED_RESTART" "0" "unknown command must not arm a planned restart"
wd_assert_eq "$TRANSITION_FENCE" "stable" "unknown command must not raise a fence"
# The queue is free: a legitimate restart published next is applied fully.
: > "$TRANSCRIPT"
NEXT_CLAIM="8 restart"
apply_command || true
want=$'claim-command\nowner-identity\nsignal-bridge SIGTERM\nreset-restart-count command:restart\nack-command 8'
wd_assert_eq "$(cat "$TRANSCRIPT")" "$want" "next legitimate restart applies without stalling"
wd_assert_eq "$TRANSITION_FENCE" "planned-restart" "legitimate restart raises the fence"
EOF
  finish_case MA12 $?
}

# ── MA20: fence resets candidacy; containment never fires during a fence ───
case_MA20() {
  run_child MA20 <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
COUNTER="$CASE_HOME/.contain"
: > "$COUNTER"
svc() { [[ "$1" == "contain" ]] && echo x >> "$COUNTER"; return 0; }
RECON_TOKEN=""; RECON_COUNT=0
HB_ADVANCED=0
TRANSITION_FENCE="planned-restart"
handle_reconciliation_line "decision=extra-candidate token=300:7000 authority=liveness" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=300:7000 authority=liveness" >/dev/null
handle_reconciliation_line "decision=planned-transition token=- authority=-" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=300:7000 authority=liveness" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=300:7000 authority=liveness" >/dev/null
wd_assert_eq "$(wc -l < "$COUNTER")" "0" "containment must never fire during a planned-transition fence"
# Fence cleared (stable): nominations accumulate again and fire on the third.
TRANSITION_FENCE="stable"
RECON_TOKEN=""; RECON_COUNT=0
: > "$COUNTER"
handle_reconciliation_line "decision=extra-candidate token=400:8000 authority=liveness" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=400:8000 authority=liveness" >/dev/null
wd_assert_eq "$(wc -l < "$COUNTER")" "0" "two identical nominations must not contain yet"
handle_reconciliation_line "decision=extra-candidate token=400:8000 authority=liveness" >/dev/null
wd_assert_eq "$(wc -l < "$COUNTER")" "1" "third stable nomination contains exactly once"
EOF
  finish_case MA20 $?
}

# ── MA21: inconclusive/enumeration-failed holds fail-closed, one log line ──
case_MA21() {
  # Hold leg: the slice guard ends the child with rc 42 once the fail-closed
  # hold has been observed across 40 poll slices; the parent then inspects the
  # child's home files directly (spawn log, transcript, watchdog log).
  local home="$RUN_ROOT/MA21a/home"
  run_child MA21a <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
SPAWN_LOG="$CASE_HOME/spawns.log"; TRANSCRIPT="$CASE_HOME/transcript"
: > "$SPAWN_LOG"; : > "$TRANSCRIPT"
SLICES=0
bounded_sleep() {
  SLICES=$(( SLICES + 1 ))
  (( SLICES > 25 )) && exit 42  # observed enough slices of the fail-closed hold
}
sleep() { bounded_sleep; }
svc() {
  printf '%s\n' "$*" >> "$TRANSCRIPT"
  [[ "$1" == "prove-empty" ]] && return 1  # enumeration invocation fails
  return 0
}
spawn_bridge() { echo x >> "$SPAWN_LOG"; }
poll_state() { :; }
POLL_INTERVAL=0
EXCLUDE_PID=""; EXCLUDE_IDENTITY=""
spawn_if_proven_empty >/dev/null 2>&1
exit 43  # must never be reached: the guard above ends the hold
EOF
  local ra=$?
  if [[ "$ra" != "42" ]]; then
    emit MA21 fail "hold leg ended with rc $ra (expected the bounded-slice guard 42)"
    return
  fi
  if [[ "$(wc -l < "$home/spawns.log")" != "0" ]]; then
    emit MA21 fail "a spawn occurred while enumeration was inconclusive"
    return
  fi
  if [[ "$(grep -c 'signal-bridge' "$home/transcript")" != "0" ]]; then
    emit MA21 fail "a signal was issued during the hold"
    return
  fi
  if [[ "$(grep -c 'enumeration inconclusive' "$home/logs/watchdog.log")" != "1" ]]; then
    emit MA21 fail "unchanged inconclusive state did not log exactly one transition line"
    return
  fi

  run_child MA21b <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
COUNTER="$CASE_HOME/.contain"
: > "$COUNTER"
svc() { [[ "$1" == "contain" ]] && echo x >> "$COUNTER"; return 0; }
RECON_TOKEN=""; RECON_COUNT=0
TRANSITION_FENCE="stable"
handle_reconciliation_line "decision=enumeration-failed token=- authority=harness" >/dev/null
handle_reconciliation_line "decision=enumeration-failed token=- authority=harness" >/dev/null
wd_assert_eq "$(wc -l < "$COUNTER")" "0" "enumeration failure must never invoke containment"
wd_assert_eq "$(grep -c 'process enumeration failed' "$CASE_HOME/logs/watchdog.log")" "1" "enumeration-failed logs exactly one transition line"
EOF
  finish_case MA21 $?
}

# ── Planned-refusal classifier snapshot procedure (MA24 / MB14 rows) ────────
# Reproduces the production pre-classification state: retained predecessor
# evidence, pre-spawn instanceId snapshot, then the post-exit lock contents.
class_body() {
  cat <<'CLASS_EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
svc() { [[ "$1" == "owner-identity" ]] && printf '%s' "$OWNER_OUT"; return 0; }
TRANSITION_FENCE="$FENCE"
FENCE_PRED_PID="$PPID_E"; FENCE_PRED_IDENTITY="$PIDENT_E"
PRES_SPAWN_INSTANCE="$BEFORE_SNAPSHOT"
if [[ -n "$AFTER_RAW" ]]; then
  printf '{"instanceId":"%s","pid":9999,"lastHeartbeat":1}\n' "$AFTER_RAW" > "$LOCK"
else
  printf '{"pid":9999,"lastHeartbeat":1}\n' > "$LOCK"
fi
if classify_planned_refusal; then echo planned-refusal; else echo ordinary-death; fi
CLASS_EOF
}

run_class_row() { # run_class_row <label> <fence> <ppid> <pident> <before-snap> <after> <owner-out>; prints classification
  local label="$1"
  mkdir -p "$RUN_ROOT/$label/home/logs"
  (
    cd /
    export WD_SH_PATH="$WD_SH" PRELUDE="$PRELUDE" CASE_HOME="$RUN_ROOT/$label/home"
    export ABTARS_WATCHDOG_SOURCE_ONLY=1 ABTARS_HOME="$RUN_ROOT/$label/home"
    export FENCE="$2" PPID_E="$3" PIDENT_E="$4" BEFORE_SNAPSHOT="$5" AFTER_RAW="$6" OWNER_OUT="$7"
    bash -s <<< "$(class_body)"
  ) 2>/dev/null
}

# ── MA24: fresh child instanceId under an active fence = ordinary death ────
case_MA24() {
  local out control
  out="$(run_class_row MA24-row planned-restart 1234 "1234:55" '"instanceId":"inst-a"' fresh-child-id "valid 1234 1234:55")"
  if [[ "$out" != "ordinary-death" ]]; then
    emit MA24 fail "fresh child instanceId under active fence classified as <$out>"
    return
  fi
  # Negative control: same fence/pred but UNCHANGED instanceId -> planned refusal,
  # proving the discriminator is specifically the fresh child identity.
  control="$(run_class_row MA24-ctrl planned-restart 1234 "1234:55" '"instanceId":"inst-a"' inst-a "valid 1234 1234:55")"
  if [[ "$control" != "planned-refusal" ]]; then
    emit MA24 fail "control row (unchanged instanceId) classified as <$control>"
    return
  fi
  emit MA24 pass "ok"
}

# ── MB02: occupied/inconclusive proof withholds spawn until empty proof ────
gate_body() { # gate_body via env SEQ/MARKER; asserts internally
  cat <<'GATE_EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
SPAWN_LOG="$CASE_HOME/spawns.log"
: > "$SPAWN_LOG"
svc() {
  if [[ "$1" == "prove-empty" ]]; then
    local n seqs out
    n="$(cat "$CASE_HOME/.seqpos" 2>/dev/null || echo 0)"
    echo $((n+1)) > "$CASE_HOME/.seqpos"
    IFS=';' read -ra seqs <<< "$SEQ"
    out="${seqs[$n]:-}"
    [[ -z "$out" ]] && out="empty"
    printf '%s' "$out"
  fi
  return 0
}
spawn_bridge() { echo x >> "$SPAWN_LOG"; }
poll_state() { :; }
POLL_INTERVAL=0
EXCLUDE_PID=""; EXCLUDE_IDENTITY=""
spawn_if_proven_empty >/dev/null 2>&1
wd_assert_eq "$(wc -l < "$SPAWN_LOG")" "1" "spawn authorized only after the complete empty proof"
wd_assert_eq "$(grep -c "$MARKER" "$CASE_HOME/logs/watchdog.log")" "1" "unchanged withholding state logs exactly one line"
GATE_EOF
}

case_MB02() {
  local rc_occupied rc_inconclusive
  mkdir -p "$RUN_ROOT/MB02a/home/logs" "$RUN_ROOT/MB02b/home/logs"
  (
    cd /
    export WD_SH_PATH="$WD_SH" PRELUDE="$PRELUDE" CASE_HOME="$RUN_ROOT/MB02a/home"
    export ABTARS_WATCHDOG_SOURCE_ONLY=1 ABTARS_HOME="$RUN_ROOT/MB02a/home"
    export SEQ="occupied 2;occupied 2;empty" MARKER='Spawn withheld: occupied'
    bash -s <<< "$(gate_body)"
  ) 2>"$RUN_ROOT/MB02a.stderr"
  rc_occupied=$?
  (
    cd /
    export WD_SH_PATH="$WD_SH" PRELUDE="$PRELUDE" CASE_HOME="$RUN_ROOT/MB02b/home"
    export ABTARS_WATCHDOG_SOURCE_ONLY=1 ABTARS_HOME="$RUN_ROOT/MB02b/home"
    export SEQ="inconclusive;inconclusive;empty" MARKER='process enumeration inconclusive'
    bash -s <<< "$(gate_body)"
  ) 2>"$RUN_ROOT/MB02b.stderr"
  rc_inconclusive=$?
  finish_case MB02 $rc_occupied $rc_inconclusive
}

# ── MB09: transition-only logging — same key logs once, new key re-logs ────
case_MB09() {
  run_child MB09 <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
LAST_EVENT_KEY=""
log_event "k1" "first episode message"
log_event "k1" "first episode message"
log_event "k1" "first episode message"
wd_assert_eq "$(grep -c 'first episode message' "$CASE_HOME/logs/watchdog.log")" "1" "repeating the same event key must log exactly once"
log_event "k2" "second episode message"
wd_assert_eq "$(grep -c 'second episode message' "$CASE_HOME/logs/watchdog.log")" "1" "a changed event key opens a new episode immediately"
log_event "k1" "first episode message"
wd_assert_eq "$(grep -c 'first episode message' "$CASE_HOME/logs/watchdog.log")" "2" "returning to an earlier key opens a new episode"
wd_assert_eq "$(wc -l < "$CASE_HOME/logs/watchdog.log")" "3" "steady-state repetition emits zero additional lines"
EOF
  finish_case MB09 $?
}

# ── MB10: trailing metadata accepted; missing required fields still retry ──
case_MB10() {
  run_child MB10 <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
ATTEMPTS="$CASE_HOME/.attempts"
VALID_OUT="valid 555 1700000000000 extra-metadata-field"
svc() {
  [[ "$1" == "validate-bridge" ]] || return 0
  local n
  n="$(cat "$ATTEMPTS" 2>/dev/null || echo 0)"
  echo $((n+1)) > "$ATTEMPTS"
  printf '%s' "$VALID_OUT"
}
poll_state() { :; }
POLL_INTERVAL=0
PLANNED_RESTART=0
result="$(read_bridge_identity)"
wd_assert_eq "$result" "valid 555 1700000000000" "additive trailing metadata must be tolerated on the happy path"
wd_assert_eq "$(cat "$ATTEMPTS")" "1" "tolerated metadata must not enter transient retry"
# Contrast: a MISSING REQUIRED field retries through the full budget -> transient.
rm -f "$ATTEMPTS"
VALID_OUT="valid 555"
result="$(read_bridge_identity)"
wd_assert_eq "$result" "transient" "missing required fields must exhaust retries into transient"
wd_assert_eq "$(cat "$ATTEMPTS")" "3" "retry budget stays at three attempts"
EOF
  finish_case MB10 $?
}

# ── MB11: liveness nomination stability + frozen-heartbeat window ──────────
case_MB11() {
  run_child MB11 <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
COUNTER="$CASE_HOME/.contain"
: > "$COUNTER"
CONTAIN_ARGS="$CASE_HOME/.contain-args"
svc() {
  if [[ "$1" == "contain" ]]; then
    echo x >> "$COUNTER"
    printf '%s\n' "$*" >> "$CONTAIN_ARGS"
  fi
  return 0
}
RECON_TOKEN=""; RECON_COUNT=0
HB_ADVANCED=0
TRANSITION_FENCE="stable"
# Two identical liveness nominations are not yet containment...
handle_reconciliation_line "decision=extra-candidate token=200:6000 authority=liveness" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=200:6000 authority=liveness" >/dev/null
wd_assert_eq "$(wc -l < "$COUNTER")" "0" "two stable nominations must withhold containment"
# ...the third identical one fires exactly once, naming PID/identity/authority.
handle_reconciliation_line "decision=extra-candidate token=200:6000 authority=liveness" >/dev/null
wd_assert_eq "$(wc -l < "$COUNTER")" "1" "third stable nomination contains exactly once"
wd_assert_eq "$(head -n 1 "$CONTAIN_ARGS")" "contain 200 6000 liveness stable 0" "containment runs through svc contain with nomination identity"
# A changed token resets the window; a new episode needs its own three strikes.
RECON_TOKEN=""; RECON_COUNT=0
: > "$COUNTER"
handle_reconciliation_line "decision=extra-candidate token=300:7000 authority=liveness" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=301:7001 authority=liveness" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=301:7001 authority=liveness" >/dev/null
wd_assert_eq "$(wc -l < "$COUNTER")" "0" "changed token must reset candidacy"
handle_reconciliation_line "decision=extra-candidate token=301:7001 authority=liveness" >/dev/null
wd_assert_eq "$(wc -l < "$COUNTER")" "1" "new episode contains after its own three stable nominations"
# Frozen-heartbeat observation feeds the liveness path: no advance opens the
# deep-stale window; ANY later value change reopens it as a veto (HB_ADVANCED).
STALE=300
LOCK_BAK="$LOCK"
printf '{"pid":9,"lastHeartbeat":%s000}\n' "$(( WD_FAKE_EPOCH - 1000 ))" > "$LOCK_BAK"
LAST_HB_PREV=""; HB_ADVANCED=0; LIVENESS_WINDOW_STARTED=0
observe_liveness_heartbeat
observe_liveness_heartbeat
wd_assert_eq "$LIVENESS_WINDOW_STARTED" "1" "no heartbeat advance beyond 2x STALE opens the liveness window"
wd_assert_eq "$HB_ADVANCED" "0" "frozen heartbeat must not claim advancement"
printf '{"pid":9,"lastHeartbeat":%s000}\n' "$WD_FAKE_EPOCH" > "$LOCK_BAK"
observe_liveness_heartbeat
wd_assert_eq "$HB_ADVANCED" "1" "any later value change reopens the veto window"
wd_assert_eq "$LIVENESS_WINDOW_STARTED" "0" "advancement resets the deep-stale window"
EOF
  finish_case MB11 $?
}

# ── MB13: blocked-unattributable withholds spawn loudly ───────────────────
case_MB13() {
  local rc
  mkdir -p "$RUN_ROOT/MB13/home/logs"
  (
    cd /
    export WD_SH_PATH="$WD_SH" PRELUDE="$PRELUDE" CASE_HOME="$RUN_ROOT/MB13/home"
    export ABTARS_WATCHDOG_SOURCE_ONLY=1 ABTARS_HOME="$RUN_ROOT/MB13/home"
    export SEQ=$'occupied 1\nblocked-unattributable 4242 4242:777 cwd-unreadable(linux) app/bundle/abtars.js;empty'
    MARKER='blocked-unattributable'
    bash -s <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
SPAWN_LOG="$CASE_HOME/spawns.log"; CALLARGS="$CASE_HOME/calls.log"
: > "$SPAWN_LOG"; : > "$CALLARGS"
# One prove-empty response per ';'-separated slot; a response may itself be
# multi-line, exactly like the production enumeration report.
svc() {
  if [[ "$1" == "prove-empty" ]]; then
    local n seqs out
    n="$(cat "$CASE_HOME/.seqpos" 2>/dev/null || echo 0)"
    echo $((n+1)) > "$CASE_HOME/.seqpos"
    IFS=';' read -r -d '' -a seqs < <(printf '%s\0' "$SEQ")
    out="${seqs[$n]:-}"
    [[ -z "$out" ]] && out="empty"
    printf '%s' "$out"
  fi
  return 0
}
spawn_bridge() { echo x >> "$SPAWN_LOG"; }
poll_state() { :; }
POLL_INTERVAL=0
EXCLUDE_PID=""; EXCLUDE_IDENTITY=""
spawn_if_proven_empty >/dev/null 2>&1
wd_assert_eq "$(wc -l < "$SPAWN_LOG")" "1" "unattributable blockers hold the spawn until they clear"
wd_assert_eq "$(grep -c 'blocked-unattributable' "$CASE_HOME/logs/watchdog.log")" "1" "blocking set change logs exactly ONE loud event line"
wd_assert "$(( $(grep -c '4242' "$CASE_HOME/logs/watchdog.log") >= 1 ))" "1" "loud event carries the blocked PID list"
wd_assert "$(( $(grep -c 'app/bundle/abtars.js' "$CASE_HOME/logs/watchdog.log") >= 1 ))" "1" "loud event carries the relative-spelled argv"
wd_assert "$(( $(grep -c 'restart or terminate these processes to restore supervision' "$CASE_HOME/logs/watchdog.log") >= 1 ))" "1" "loud event carries operator recovery text"
EOF
  ) 2>"$RUN_ROOT/MB13.stderr"
  rc=$?
  finish_case MB13 $rc
}

# ── MB14: planned-refusal truth table + authorization refresh + snapshot ───
case_MB14() {
  local r
  # Truth table: every uncertain row falls through to ordinary-death; only the
  # exact three-part match (active fence + live matching pred + unchanged
  # instanceId sentinel, including unchanged-MISSING) classifies planned-refusal.
  local rows=(
    "planned-restart|1234|1234:55|inst-a|inst-a|valid 1234 1234:55|planned-refusal"
    "stable|1234|1234:55|inst-a|inst-a|valid 1234 1234:55|ordinary-death"
    "planned-restart|||||valid 1234 1234:55|ordinary-death"
    "planned-restart|1234|1234:55|inst-a|inst-a|invalid 0 -|ordinary-death"
    "planned-restart|1234|1234:55|inst-a|inst-a|valid 777 777:11|ordinary-death"
    "planned-restart|1234|1234:55|inst-a|inst-a|valid 1234 9999:1|ordinary-death"
    "planned-restart|1234|1234:55|inst-a|fresh-child-id|valid 1234 1234:55|ordinary-death"
    "planned-restart|1234|1234:55|||valid 1234 1234:55|planned-refusal"
    "planned-restart|1234|1234:55||fresh-child-id|valid 1234 1234:55|ordinary-death"
    "planned-restart|1234|1234:55|inst-a||valid 1234 1234:55|ordinary-death"
  )
  # All rows run in ONE child (each resets the classifier state first), so the
  # case stays cheap while every row still observes the production helper. The
  # body is a QUOTED heredoc: every variable it references comes from the env
  # run_child provides, so no outer-shell escaping is needed.
  export ROWS_ENV="$(printf '%s\n' "${rows[@]}")"
  run_child MB14-rows <<'MB14_ROWS_EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
svc() { [[ "$1" == "owner-identity" ]] && printf '%s' "$OWNER_OUT"; return 0; }
IFS=$'\n' read -r -d '' -a ROWS < <(printf '%s\0' "$ROWS_ENV")
local_i=0
for row in "${ROWS[@]}"; do
  local_i=$(( local_i + 1 ))
  IFS='|' read -r fence ppid_e pident_e before after owner want <<< "$row"
  local_snap=""
  if [[ -n "$before" ]]; then
    local_snap="\"instanceId\":\"$before\""
  fi
  TRANSITION_FENCE="$fence"
  FENCE_PRED_PID="$ppid_e"; FENCE_PRED_IDENTITY="$pident_e"
  PRES_SPAWN_INSTANCE="$local_snap"
  if [[ -n "$after" ]]; then
    printf '{"instanceId":"%s","pid":9999,"lastHeartbeat":1}\n' "$after" > "$LOCK"
  else
    printf '{"pid":9999,"lastHeartbeat":1}\n' > "$LOCK"
  fi
  OWNER_OUT="$owner"
  got=ordinary-death
  classify_planned_refusal && got=planned-refusal
  if [[ "$got" != "$want" ]]; then
    printf 'truth-table row %s (%s/pred=%s/after=%s) classified <%s>, want <%s>\n' \
      "$local_i" "${fence:-stable}" "${ppid_e:-none}" "${after:-none}" "$got" "$want" >&2
    exit 10
  fi
done
MB14_ROWS_EOF
  r=$?
  if [[ $r != 0 ]]; then
    emit MB14 fail "$(child_detail MB14-rows)"
    return
  fi

  # Authorization refresh: a fresh exact predecessor probe re-arms the one-shot
  # exclusion; anything else leaves it empty (fail-closed).
  run_child MB14-refresh <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
OWNER_OUT="valid 1234 1234:55"
svc() { [[ "$1" == "owner-identity" ]] && printf '%s' "$OWNER_OUT"; return 0; }
FENCE_PRED_PID=1234; FENCE_PRED_IDENTITY="1234:55"
EXCLUDE_PID=""; EXCLUDE_IDENTITY=""
refresh_replacement_authorization
wd_assert_eq "$EXCLUDE_PID/$EXCLUDE_IDENTITY" "1234/1234:55" "fresh exact match re-arms the replacement exclusion"
EXCLUDE_PID=999; EXCLUDE_IDENTITY="stale"
OWNER_OUT="valid 777 777:2"
refresh_replacement_authorization
wd_assert_eq "$EXCLUDE_PID/$EXCLUDE_IDENTITY" "/" "mismatched probe leaves the exclusion empty"
OWNER_OUT="invalid 0 -"
refresh_replacement_authorization
wd_assert_eq "$EXCLUDE_PID/$EXCLUDE_IDENTITY" "/" "failed probe leaves the exclusion empty"
EOF
  r=$?
  if [[ $r != 0 ]]; then
    finish_case MB14 $r
    return
  fi

  # Authorized spawn snapshots bridge.lock's instanceId BEFORE spawning (#1719 R1).
  run_child MB14-snapshot <<'EOF'
set -u
source "$PRELUDE"
source "$WD_SH_PATH"
printf '{"instanceId":"snap-check","pid":9999,"lastHeartbeat":1}\n' > "$LOCK"
svc() { [[ "$1" == "prove-empty" ]] && printf 'empty'; return 0; }
spawn_bridge() { :; }
poll_state() { :; }
POLL_INTERVAL=0
EXCLUDE_PID=""; EXCLUDE_IDENTITY=""
PRES_SPAWN_INSTANCE="unset"
spawn_if_proven_empty >/dev/null 2>&1
wd_assert_eq "$PRES_SPAWN_INSTANCE" '"instanceId":"snap-check"' "authorized spawn must snapshot the pre-spawn instanceId"
EOF
  r=$?
  if [[ $r == 0 ]]; then
    emit MB14 pass "ok (${#rows[@]} truth-table rows, refresh, snapshot)"
  else
    emit MB14 fail "$(child_detail MB14-snapshot)"
  fi
}

# ── Dispatch ────────────────────────────────────────────────────────────────
STARTED_MS="$(date +%s%3N)"
for id in "${REQUESTED[@]}"; do
  "case_$id"
done

# No-process proof: everything ran synchronously in waited children, so any
# surviving descendant of this shell at this point is a leaked process. The
# scan is read-only detection of OUR subtree via pgrep -P (never a cleanup or
# signal authority) so its cost does not scale with the host's process count.
leak_scan() {
  local frontier collected p all
  frontier=("$$")
  for _ in 1 2 3 4 5 6; do # descendant depth bound
    all="${frontier[*]}"
    collected=()
    for p in $(pgrep -P "$all" 2>/dev/null || true); do
      collected+=("$p")
    done
    ((${#collected[@]} == 0)) && return 0
    frontier=("${collected[@]}")
  done
  return 1
}

LEAKS=0
if ! leak_scan; then LEAKS=1; fi
DURATION_MS=$(( $(date +%s%3N) - STARTED_MS ))

echo "M-SUITE total=$(( PASS + FAILS )) pass=$PASS fail=$FAILS duration_ms=$DURATION_MS leak_scan=$([[ $LEAKS == 0 ]] && echo ok || echo FAILED)"
if (( FAILS > 0 || LEAKS != 0 )); then
  exit 1
fi
exit 0
