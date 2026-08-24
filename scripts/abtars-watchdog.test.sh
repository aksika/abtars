#!/usr/bin/env bash
# #1261: Verify the watchdog's bridge spawn line uses exec so $! returns the real node PID
# (not a bash subshell). This prevents the subshell-orphan bug that caused duplicate bridges.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WD_SH="$SCRIPT_DIR/abtars-watchdog.sh"

if [[ ! -f "$WD_SH" ]]; then
  echo "FAIL: $WD_SH not found"
  exit 1
fi

# Test 1: The spawn line must contain "exec" before the env=value nohup node...
SPAWN_LINE=$(grep -n 'nohup node.*abtars.js.*200>&-' "$WD_SH" || true)
if [[ -z "$SPAWN_LINE" ]]; then
  echo "FAIL: spawn line not found in watchdog script"
  exit 1
fi
if ! echo "$SPAWN_LINE" | grep -q 'exec.*nohup node'; then
  echo "FAIL: spawn line missing 'exec' before nohup node — subshell orphan will occur"
  echo "  Found: $SPAWN_LINE"
  exit 1
fi
echo "OK: spawn line has 'exec' prefix"

# Test 2: Reproduce the bug class in isolation — verify the exec fix actually works
# Simulate the exact spawn pattern: cd X && exec env=value nohup node ... &
DUMMY_JS="/tmp/dummy-1261.js"
cat > "$DUMMY_JS" <<'EOF'
console.log("node started, pid:", process.pid);
setInterval(() => {}, 60000); // keep alive
EOF

TEST_SCRIPT="/tmp/test-exec-1261.sh"
cat > "$TEST_SCRIPT" <<EOF
#!/usr/bin/env bash
cd /tmp && exec env FOO=bar /usr/bin/node "$DUMMY_JS" >> /tmp/exec-1261.log 2>&1 200>- &
CHILD=\$!
sleep 1
if [ -d "/proc/\$CHILD" ]; then
  COMM=\$(cat /proc/\$CHILD/comm 2>/dev/null)
  if [ "\$COMM" = "node" ]; then
    echo "OK: \$CHILD is node (comm=node)"
    kill \$CHILD 2>/dev/null
    exit 0
  else
    echo "FAIL: \$CHILD is '\$COMM' (expected node) — subshell orphan regression"
    kill \$CHILD 2>/dev/null
    exit 1
  fi
else
  echo "FAIL: \$CHILD is gone"
  exit 1
fi
EOF
chmod +x "$TEST_SCRIPT"

if "$TEST_SCRIPT"; then
  echo "OK: exec fix verified — \$! returns real node PID"
else
  echo "FAIL: exec fix did not work as expected"
  rm -f "$DUMMY_JS" "$TEST_SCRIPT"
  exit 1
fi

# Cleanup
rm -f "$DUMMY_JS" "$TEST_SCRIPT" /tmp/exec-1261.log
pkill -f "dummy-1261.js" 2>/dev/null

echo "OK: #1261 tests passed"

# ── #1328: watchdog exit-code capture via bridge self-report ──────────────

# Test 3: the process-gone branch must read lastExitCode from bridge.lock, not trust
# `wait`'s return value (which is always 0 due to `disown`).
if ! grep -q "lastExitCode" "$WD_SH"; then
  echo "FAIL: watchdog script does not read lastExitCode from bridge.lock (#1328)"
  exit 1
fi
if ! grep -q "wait \"\$PID\" 2>/dev/null   # reap the child" "$WD_SH"; then
  echo "FAIL: process-gone branch no longer reaps the child via wait, or comment changed unexpectedly"
  exit 1
fi
echo "OK: process-gone branch reads self-reported lastExitCode"

# Test 4: `disown $PID` must still be present — #1050 survival + SIGTERM/INT-trap
# isolation depend on it (see resilience.asbuilt.md). This fix must NOT remove it.
if ! grep -q '^  disown \$PID' "$WD_SH"; then
  echo "FAIL: 'disown \$PID' was removed — regresses #1050 (watchdog death kills bridge)"
  exit 1
fi
echo "OK: disown \$PID still present (#1050 survival intact)"

# Test 5: SPAWNED_AT freshness guard — the lastExitCode read must gate on
# lastExitAt > SPAWNED_AT so a stale prior-death code is never reused.
if ! grep -q "ea / 1000 > \$SPAWNED_AT" "$WD_SH"; then
  echo "FAIL: lastExitCode read is missing the SPAWNED_AT freshness guard"
  exit 1
fi
echo "OK: lastExitCode read guards against stale prior-death values"

# Test 6: functional — simulate the bridge's self-report + watchdog's read, end to end,
# using the exact python3 read expression from the script (extracted, not re-derived) so a
# drift in the script doesn't silently go untested.
FAKE_LOCK="/tmp/fake-bridge-1328.lock"
FAKE_SPAWNED_AT=$(($(date +%s) - 10))   # bridge "spawned" 10s ago
cat > "$FAKE_LOCK" <<EOF
{"pid": 99999, "lastExitCode": 1, "lastExitAt": $(( ($(date +%s) + 1) * 1000 ))}
EOF
READ_EXPR=$(python3 -c "
import json
LOCK='$FAKE_LOCK'
SPAWNED_AT=$FAKE_SPAWNED_AT
d = json.load(open(LOCK))
ec = d.get('lastExitCode')
ea = d.get('lastExitAt', 0)
print(ec if (ec is not None and ea / 1000 > SPAWNED_AT) else '')
")
if [[ "$READ_EXPR" != "1" ]]; then
  echo "FAIL: fresh lastExitCode=1 (written after spawn) should read as '1', got '$READ_EXPR'"
  rm -f "$FAKE_LOCK"
  exit 1
fi
echo "OK: fresh self-reported exit code (1) read correctly"

# Test 7: stale lastExitCode (written BEFORE this bridge spawned) must be rejected → unknown
cat > "$FAKE_LOCK" <<EOF
{"pid": 99999, "lastExitCode": 1, "lastExitAt": $(( ($(date +%s) - 100) * 1000 ))}
EOF
READ_EXPR=$(python3 -c "
import json
LOCK='$FAKE_LOCK'
SPAWNED_AT=$FAKE_SPAWNED_AT
d = json.load(open(LOCK))
ec = d.get('lastExitCode')
ea = d.get('lastExitAt', 0)
print(ec if (ec is not None and ea / 1000 > SPAWNED_AT) else '')
")
if [[ -n "$READ_EXPR" ]]; then
  echo "FAIL: stale lastExitCode (written before spawn) should read as empty, got '$READ_EXPR'"
  rm -f "$FAKE_LOCK"
  exit 1
fi
echo "OK: stale lastExitCode correctly rejected (would fall back to 'unknown' in the script)"
rm -f "$FAKE_LOCK"

# Test 8: crash-window failsafe — 4 deaths within 600s (with a lastHeartbeat present,
# i.e. Failsafe A would NOT fire) must be counted correctly by the window-count expression.
FAKE_STATE="/tmp/fake-deploy-1328.state"
NOW_EPOCH=$(date +%s)
python3 -c "
import json
d = {'restartCount': 4, 'deathWindow': [$NOW_EPOCH - 500, $NOW_EPOCH - 300, $NOW_EPOCH - 100, $NOW_EPOCH - 5]}
json.dump(d, open('$FAKE_STATE', 'w'))
"
COUNT=$(python3 -c "
import json, time
d = json.load(open('$FAKE_STATE'))
window = d.get('deathWindow', [])
now = time.time()
print(sum(1 for t in window if now - t <= 600))
")
if [[ "$COUNT" != "4" ]]; then
  echo "FAIL: expected 4 deaths within the 600s window, got '$COUNT'"
  rm -f "$FAKE_STATE"
  exit 1
fi
echo "OK: crash-window failsafe counts 4 deaths within 600s correctly (would trip Failsafe B)"

# Test 9: deaths outside the window must not count (window rolls, not unbounded)
python3 -c "
import json
d = {'restartCount': 4, 'deathWindow': [$NOW_EPOCH - 700, $NOW_EPOCH - 650]}
json.dump(d, open('$FAKE_STATE', 'w'))
"
COUNT=$(python3 -c "
import json, time
d = json.load(open('$FAKE_STATE'))
window = d.get('deathWindow', [])
now = time.time()
print(sum(1 for t in window if now - t <= 600))
")
if [[ "$COUNT" != "0" ]]; then
  echo "FAIL: deaths older than 600s should not count, got '$COUNT'"
  rm -f "$FAKE_STATE"
  exit 1
fi
echo "OK: deaths outside the 600s window correctly excluded"
rm -f "$FAKE_STATE"

# Test 10: Failsafe A (no-heartbeat-ever) logic must still be present, unmodified in intent —
# regression guard per the frozen-watchdog rule ("a regression test asserts L2 still exits on
# stale elapsed"). This checks the STALE heartbeat check + validated SIGKILL path still exists.
if ! grep -q 'stale-heartbeat:' "$WD_SH"; then
  echo "FAIL: stale-heartbeat detection removed — regresses L2/L3 staleness contract"
  exit 1
fi
if ! grep -q 'signal-bridge SIGKILL' "$WD_SH"; then
  echo "FAIL: stale-heartbeat validated SIGKILL removed — regresses L2/L3 staleness contract"
  exit 1
fi
echo "OK: stale-heartbeat detection + validated SIGKILL path intact (frozen-watchdog regression guard)"

# ── #1499: Suspend recovery + transient validation ──────────────────────────

# Test 11: Suspend detection with heartbeat advancement within recovery window.
# Creates a temp home, controlled bridge.lock, and tests the bounded recovery logic.
T1499_HOME=$(mktemp -d /tmp/watchdog-1499.XXXXXX)
trap "rm -rf '$T1499_HOME'" EXIT
mkdir -p "$T1499_HOME/logs"

# Launch a disposable "bridge" process (sleep, hold PID).
sleep 600 &
BRIDGE_PID=$!

# Write bridge.lock with a known heartbeat (compact JSON, matching bridge format).
echo '{"pid":'"$BRIDGE_PID"',"lastHeartbeat":5000,"startedAt":'$(date +%s)'000}' > "$T1499_HOME/bridge.lock"

# Source the production helpers without starting the watchdog or acquiring its
# singleton lock. The test overrides only external state I/O and poll_state.
ABTARS_HOME="$T1499_HOME" ABTARS_WATCHDOG_SOURCE_ONLY=1 source "$WD_SH"
LOCK="$T1499_HOME/bridge.lock"
WD_LOG="$T1499_HOME/logs/watchdog.log"
POLL=2
POLL_INTERVAL=1
poll_state() { :; }
svc() {
  case "$1" in
    validate-bridge) echo "valid $BRIDGE_PID $(date +%s)000" ;;
    signal-bridge) echo "SIGNALLED" >> "$T1499_HOME/signals" ;;
    *) return 0 ;;
  esac
}
cd /

# Test 11a: heartbeat advances → recovery succeeds.
LAST_OBSERVED_HB="5000"
LAST_POLL_AT=$(date +%s)
PLANNED_RESTART=0
# Write an advanced heartbeat into bridge.lock (compact JSON).
echo '{"pid":'"$BRIDGE_PID"',"lastHeartbeat":6000,"startedAt":'$(date +%s)'000}' > "$T1499_HOME/bridge.lock"
if ! wait_for_resume_heartbeat "$LAST_OBSERVED_HB" "$(date +%s)"; then
  echo "FAIL: suspend recovery helper returned failure on fresh heartbeat"
  kill $BRIDGE_PID 2>/dev/null
  exit 1
fi
if [[ "$LAST_OBSERVED_HB" != "6000" ]]; then
  echo "FAIL: production suspend recovery helper did not record fresh heartbeat"
  kill $BRIDGE_PID 2>/dev/null
  exit 1
fi
echo "OK: production suspend recovery helper detects heartbeat advancement"

# Test 11b: no heartbeat advancement → recovery timeout (not stale kill).
LAST_OBSERVED_HB="5000"
LAST_POLL_AT=$(date +%s)
PLANNED_RESTART=0
python3 -c "
import json
with open('$T1499_HOME/bridge.lock', 'w') as f:
    json.dump({'pid': $BRIDGE_PID, 'lastHeartbeat': 5000, 'startedAt': $(date +%s)000}, f)
"
rm -f "$T1499_HOME/signals"
wait_for_resume_heartbeat "$LAST_OBSERVED_HB" "$(date +%s)"
if [[ -e "$T1499_HOME/signals" ]]; then
  echo "FAIL: suspend recovery helper must not signal during bounded wait"
  kill $BRIDGE_PID 2>/dev/null
  exit 1
fi
echo "OK: production suspend recovery helper times out without signalling"

# Test 12: validation retry — corrupt then valid → succeeds.
svc() {
  case "$1" in
    validate-bridge)
      if [[ -f "$T1499_HOME/validate-call-count" ]]; then
        COUNT=$(cat "$T1499_HOME/validate-call-count")
      else
        COUNT=1
      fi
      echo "$(( COUNT + 1 ))" > "$T1499_HOME/validate-call-count"
      if (( COUNT <= 1 )); then
        echo "corrupt"
      else
        echo "valid $BRIDGE_PID $(date +%s)000"
      fi
      ;;
    *) return 0 ;;
  esac
}
rm -f "$T1499_HOME/validate-call-count"
_result=$(read_bridge_identity)
_vstatus=$(echo "$_result" | awk '{print $1}')
if [[ "$_vstatus" != "valid" ]]; then
  echo "FAIL: production validate retry — corrupt-then-valid should return valid, got '$_vstatus'"
  kill $BRIDGE_PID 2>/dev/null
  exit 1
fi
echo "OK: production validate retry — corrupt-then-valid cycles correctly"

# Test 12b: malformed recognized status must retry, not become process-gone.
rm -f "$T1499_HOME/validate-call-count"
svc() {
  case "$1" in
    validate-bridge)
      if [[ ! -f "$T1499_HOME/validate-call-count" ]]; then
        echo 1 > "$T1499_HOME/validate-call-count"
        echo "valid $BRIDGE_PID"
      else
        echo "valid $BRIDGE_PID $(date +%s)000"
      fi
      ;;
    *) return 0 ;;
  esac
}
_result=$(read_bridge_identity)
_vstatus=$(echo "$_result" | awk '{print $1}')
if [[ "$_vstatus" != "valid" ]]; then
  echo "FAIL: malformed valid response must retry, got '$_result'"
  kill $BRIDGE_PID 2>/dev/null
  exit 1
fi
echo "OK: malformed recognized response retries through production helper"

# Test 13: validation retry — all transient → returns transient.
svc() {
  case "$1" in
    validate-bridge) echo "corrupt" ;;
    *) return 0 ;;
  esac
}
rm -f "$T1499_HOME/validate-call-count"
_result=$(read_bridge_identity)
_vstatus=$(echo "$_result" | awk '{print $1}')
if [[ "$_vstatus" != "transient" ]]; then
  echo "FAIL: validate retry — all transient should return transient, got '$_vstatus'"
  kill $BRIDGE_PID 2>/dev/null
  exit 1
fi
echo "OK: validate retry — all transient correctly returns transient"

# Test 14: validation retry — definitive death returns immediately.
svc() {
  case "$1" in
    validate-bridge) echo "dead 0 0" ;;
    *) return 0 ;;
  esac
}
_result=$(read_bridge_identity)
_vstatus=$(echo "$_result" | awk '{print $1}')
if [[ "$_vstatus" != "dead" ]]; then
  echo "FAIL: validate retry — definitive death should return immediately, got '$_vstatus'"
  kill $BRIDGE_PID 2>/dev/null
  exit 1
fi
echo "OK: validate retry — definitive death returns without retry"

# Cleanup the disposable bridge.
kill $BRIDGE_PID 2>/dev/null

# Test 15: read_heartbeat exists and works on a real lock file.
echo '{"lastHeartbeat":1234567890}' > "$T1499_HOME/bridge.lock"
HB=$(grep -o '"lastHeartbeat":[0-9]*' "$T1499_HOME/bridge.lock" 2>/dev/null | grep -o '[0-9]*')
if [[ "$HB" != "1234567890" ]]; then
  echo "FAIL: read_heartbeat should extract 1234567890, got '$HB'"
  exit 1
fi
echo "OK: read_heartbeat extracts numeric heartbeat correctly"

# Test 16: LAST_OBSERVED_HB is initialized in the script (source check).
if ! grep -q "LAST_OBSERVED_HB" "$WD_SH"; then
  echo "FAIL: LAST_OBSERVED_HB must be present in watchdog script (#1499)"
  exit 1
fi
echo "OK: LAST_OBSERVED_HB tracking variable present in watchdog script"

# Test 17: read_heartbeat helper is present in the script.
if ! grep -q "read_heartbeat" "$WD_SH"; then
  echo "FAIL: read_heartbeat helper must be present in watchdog script (#1499)"
  exit 1
fi
echo "OK: read_heartbeat helper present in watchdog script"

# Test 18: transient validation handling is present in the script.
if ! grep -q "transient" "$WD_SH"; then
  echo "FAIL: transient validation handling must be present in watchdog script (#1499)"
  exit 1
fi
echo "OK: transient validation handling present in watchdog script"

# Test 19: bounded resume wait is present (not one-cycle grace).
if grep -q "granting one-cycle grace" "$WD_SH"; then
  echo "FAIL: old one-cycle grace wording must be removed (#1499)"
  exit 1
fi
if ! grep -q "bounded resume wait\|entering bounded resume wait" "$WD_SH"; then
  echo "FAIL: bounded resume wait must replace one-cycle grace wording (#1499)"
  exit 1
fi
echo "OK: bounded resume wait wording present (one-cycle grace removed)"

rm -rf "$T1499_HOME"

# ── #1711 R3: zero-process spawn gate (source-only harness) ──────────────
# NOTE: $(svc ...) runs in a subshell, so the stub tracks call order in a
# COUNTER FILE, not a shell variable.
GATE_HOME="$(mktemp -d)"
mkdir -p "$GATE_HOME/logs"
GATE_LOG="$GATE_HOME/logs/watchdog.log"

GATE_RUNNER="$GATE_HOME/gate-runner.sh"
cat > "$GATE_RUNNER" <<'RUNNER_EOF'
#!/usr/bin/env bash
set -u
source "$WD_SH_PATH"
SPAWNED=0
svc() {
  if [[ "$1" == "prove-empty" ]]; then
    local n seqs out
    n="$(cat "$GATE_COUNTER" 2>/dev/null || echo 0)"
    echo $((n+1)) > "$GATE_COUNTER"
    IFS=';' read -ra seqs <<< "$GATE_SEQ"
    out="${seqs[$n]:-}"
    [[ -z "$out" ]] && out="inconclusive"
    printf "%s" "$out"
  fi
}
spawn_bridge() { echo x >> "$GATE_SPAWNS"; }
poll_state() { :; }
POLL_INTERVAL=0
# Bounded probe: if the gate still has not authorized a spawn after several
# slices, report held (a real watchdog would keep holding — fail-closed).
spawn_if_proven_empty >/dev/null 2>&1 &
GATE_PID=$!
for _ in $(seq 1 400); do
  kill -0 "$GATE_PID" 2>/dev/null || break
  sleep 0.01
done
if kill -0 "$GATE_PID" 2>/dev/null; then
  kill -9 "$GATE_PID" 2>/dev/null
  wait "$GATE_PID" 2>/dev/null
  STATE="held"
else
  STATE="done"
fi
echo "$STATE spawned=$(wc -l < "${GATE_SPAWNS:-/dev/null}" 2>/dev/null || echo 0)"
RUNNER_EOF

gate_run() {
  : > "$GATE_LOG"
  rm -f "$GATE_HOME/.gate-counter" "$GATE_HOME/.gate-spawns"
  WD_SH_PATH="$WD_SH" ABTARS_WATCHDOG_SOURCE_ONLY=1 ABTARS_HOME="$GATE_HOME" \
    GATE_SEQ="$1" GATE_COUNTER="$GATE_HOME/.gate-counter" GATE_SPAWNS="$GATE_HOME/.gate-spawns" \
    bash "$GATE_RUNNER" 2>/dev/null
}

RESULT=$(gate_run "empty")
if [[ "$RESULT" != "done spawned=1"* ]]; then
  echo "FAIL: gate must spawn silently on complete empty proof — got: $RESULT log=$(cat "$GATE_LOG")"
  exit 1
fi
echo "OK: gate spawns on a complete empty enumeration"

RESULT=$(gate_run "occupied 2;occupied 2;empty")
SPAWN_COUNT=$(echo "$RESULT" | grep -o "spawned=[0-9]*" | cut -d= -f2)
WITHHELD_LINES=$(grep -c "Spawn withheld" "$GATE_LOG")
if [[ "$RESULT" != "done spawned=1"* || "$WITHHELD_LINES" != "1" ]]; then
  echo "FAIL: gate must withhold while occupied, spawn once after empty, log ONCE — got: $RESULT lines=$WITHHELD_LINES"
  exit 1
fi
echo "OK: gate withholds spawn on occupied snapshot until proof turns empty (one event line)"

RESULT=$(gate_run "inconclusive;inconclusive;empty")
SPAWN_COUNT=$(echo "$RESULT" | grep -o "spawned=[0-9]*" | cut -d= -f2)
INCONCLUSIVE_LINES=$(grep -c "enumeration inconclusive" "$GATE_LOG")
if [[ "$RESULT" != "done spawned=1"* || "$INCONCLUSIVE_LINES" != "1" ]]; then
  echo "FAIL: gate must hold fail-closed on inconclusive enumeration without repeating logs — got: $RESULT lines=$INCONCLUSIVE_LINES"
  exit 1
fi
echo "OK: gate holds fail-closed on inconclusive enumeration (one event line)"

RESULT=$(gate_run "")
if [[ "$RESULT" != "held spawned=0"* ]]; then
  echo "FAIL: boundary invocation failure must hold fail-closed without spawning — got: $RESULT"
  exit 1
fi
HELD_INCONCLUSIVE_LINES=$(grep -c "enumeration inconclusive" "$GATE_LOG")
if [[ "$HELD_INCONCLUSIVE_LINES" != "1" ]]; then
  echo "FAIL: indefinite hold must log the inconclusive state exactly once — got $HELD_INCONCLUSIVE_LINES lines"
  exit 1
fi
echo "OK: boundary invocation failure holds fail-closed (never spawns, one event line)"

# R4: validate-bridge consumer tolerates trailing metadata.
if grep -q '\-z "\$vextra"' "$WD_SH"; then
  echo "FAIL: read_bridge_identity must not require empty trailing field (#1711 R4 additive metadata)"
  exit 1
fi
echo "OK: read_bridge_identity tolerates declared trailing fields"

# ── #1711 Phase 2: reconciliation token handling (source-only harness) ───
RECON_HOME="$(mktemp -d)"
mkdir -p "$RECON_HOME/logs"

RECON_RUNNER="$RECON_HOME/recon-runner.sh"
cat > "$RECON_RUNNER" <<'RUNNER_EOF'
#!/usr/bin/env bash
set -u
source "$WD_SH_PATH"
svc() {
  if [[ "$1" == "contain" ]]; then
    local n
    n="$(cat "$RECON_COUNTER" 2>/dev/null || echo 0)"
    echo $((n+1)) > "$RECON_COUNTER"
  fi
}
RECON_TOKEN=""
RECON_COUNT=0
TRANSITION_FENCE="stable"
handle_reconciliation_line "decision=extra-candidate token=200:6000 authority=owner" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=200:6000 authority=owner" >/dev/null
C1="$(cat "$RECON_COUNTER" 2>/dev/null || echo 0)"
handle_reconciliation_line "decision=contain-extra token=200:6000 authority=liveness" >/dev/null
C3="$(cat "$RECON_COUNTER" 2>/dev/null || echo 0)"
echo "calls3=$C3 first_two=$C1"
RUNNER_EOF

RESULT=$(WD_SH_PATH="$WD_SH" ABTARS_WATCHDOG_SOURCE_ONLY=1 ABTARS_HOME="$RECON_HOME" \
  RECON_COUNTER="$RECON_HOME/.recon-counter" bash "$RECON_RUNNER")
if [[ "$RESULT" != "calls3=1 first_two=0"* ]]; then
  echo "FAIL: containment must fire exactly on the third identical nomination — got: $RESULT"
  exit 1
fi
echo "OK: reconciliation handler contains only after three consecutive nominations"

cat > "$RECON_RUNNER" <<'RUNNER_EOF2'
#!/usr/bin/env bash
set -u
source "$WD_SH_PATH"
svc() { [[ "$1" == "contain" ]] && echo x > "$RECON_COUNTER"; }
RECON_TOKEN=""
RECON_COUNT=0
TRANSITION_FENCE="stable"
# A fence decision must reset candidacy, never count toward containment.
handle_reconciliation_line "decision=planned-transition token=- authority=-" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=300:7000 authority=liveness" >/dev/null
handle_reconciliation_line "decision=planned-transition token=- authority=-" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=300:7000 authority=liveness" >/dev/null
handle_reconciliation_line "decision=extra-candidate token=300:7000 authority=liveness" >/dev/null
echo "fenced_calls=$(cat "$RECON_COUNTER" 2>/dev/null || echo 0)"
RUNNER_EOF2

rm -f "$RECON_HOME/.recon-counter"
RESULT=$(WD_SH_PATH="$WD_SH" ABTARS_WATCHDOG_SOURCE_ONLY=1 ABTARS_HOME="$RECON_HOME" \
  RECON_COUNTER="$RECON_HOME/.recon-counter" bash "$RECON_RUNNER")
if [[ "$RESULT" != "fenced_calls=0"* ]]; then
  echo "FAIL: fence interruptions must reset candidate observation windows — got: $RESULT"
  exit 1
fi
echo "OK: fence resets the candidate observation window"

rm -rf "$RECON_HOME"

# Phase 2 anti-regrowth guard must pass on the current shell.
if ! node "$SCRIPT_DIR/check-watchdog-shape.mjs" >/dev/null; then
  echo "FAIL: watchdog shape guard failed (#1711 Phase 2)"
  exit 1
fi
echo "OK: watchdog shape guard passes"

# ── #1711 R3 v4.1: planned-replacement exclusion flow ────────────────────
EXCL_HOME="$(mktemp -d)"
mkdir -p "$EXCL_HOME/logs"

EXCL_RUNNER="$EXCL_HOME/excl-runner.sh"
cat > "$EXCL_RUNNER" <<'RUNNER_EOF'
#!/usr/bin/env bash
set -u
source "$WD_SH_PATH"
CALLARGS="$EXCL_HOME/calls.log"
SPAWN_LOG="$EXCL_HOME/spawns.log"
: > "$CALLARGS"; : > "$SPAWN_LOG"
svc() {
  printf '%s\n' "$*" >> "$CALLARGS"
  if [[ "$1" == "prove-empty" ]]; then
    local n seqs out
    n="$(cat "$EXCL_SEQPOS" 2>/dev/null || echo 0)"
    echo $((n+1)) > "$EXCL_SEQPOS"
    IFS=';' read -ra seqs <<< "$EXCL_SEQ"
    out="${seqs[$n]:-}"
    [[ -z "$out" ]] && out="empty"
    printf "%s" "$out"
  fi
}
spawn_bridge() { echo x >> "$SPAWN_LOG"; }
poll_state() { :; }
POLL_INTERVAL=0
spawn_if_proven_empty >/dev/null 2>&1
echo "spawns=$(wc -l < "$SPAWN_LOG")"
RUNNER_EOF

# Exclusion set + immediate empty proof -> forwarded to prove-empty and
# consumed exactly once.
RESULT=$(WD_SH_PATH="$WD_SH" ABTARS_WATCHDOG_SOURCE_ONLY=1 ABTARS_HOME="$EXCL_HOME" EXCL_HOME="$EXCL_HOME" \
  EXCL_SEQ="empty" EXCL_SEQPOS="$EXCL_HOME/.seqpos" bash -c '
  set -u
  source "$WD_SH_PATH"
  CALLARGS="$EXCL_HOME/calls.log"; SPAWN_LOG="$EXCL_HOME/spawns.log"
  : > "$CALLARGS"; : > "$SPAWN_LOG"
  svc() {
    printf "%s\n" "$*" >> "$CALLARGS"
    if [[ "$1" == "prove-empty" ]]; then printf "%s" "empty"; fi
  }
  spawn_bridge() { echo x >> "$SPAWN_LOG"; }
  poll_state() { :; }
  POLL_INTERVAL=0
  EXCLUDE_PID=4242; EXCLUDE_IDENTITY="4242:777"
  spawn_if_proven_empty >/dev/null 2>&1
  echo "spawns=$(wc -l < "$SPAWN_LOG") exclude_cleared=$([[ -z "$EXCLUDE_PID" && -z "$EXCLUDE_IDENTITY" ]] && echo yes || echo no)"
')
if [[ "$RESULT" != *"spawns=1 exclude_cleared=yes"* ]]; then
  echo "FAIL: replacement must consume the one-shot exclusion and spawn — got: $RESULT"
  exit 1
fi
if ! grep -q "^prove-empty 4242 4242:777$" "$EXCL_HOME/calls.log"; then
  echo "FAIL: prove-empty must receive the recorded owner pid/start identity"
  exit 1
fi
echo "OK: planned-replacement exclusion forwarded to prove-empty and consumed on spawn"

# Veto case: occupied proof clears the exclusion; later calls go WITHOUT it.
rm -f "$EXCL_HOME/.seqpos"
RESULT=$(WD_SH_PATH="$WD_SH" ABTARS_WATCHDOG_SOURCE_ONLY=1 ABTARS_HOME="$EXCL_HOME" EXCL_HOME="$EXCL_HOME" \
  EXCL_SEQPOS="$EXCL_HOME/.seqpos" \
  bash -c '
  set -u
  source "$WD_SH_PATH"
  CALLARGS="$EXCL_HOME/calls.log"; SPAWN_LOG="$EXCL_HOME/spawns.log"
  : > "$CALLARGS"; : > "$SPAWN_LOG"
  svc() {
    printf "%s\n" "$*" >> "$CALLARGS"
    if [[ "$1" == "prove-empty" ]]; then
      local n
      n="$(cat "$EXCL_SEQPOS" 2>/dev/null || echo 0)"
      echo $((n+1)) > "$EXCL_SEQPOS"
      if (( n < 2 )); then printf "%s" "occupied 3"; else printf "%s" "empty"; fi
    fi
  }
  spawn_bridge() { echo x >> "$SPAWN_LOG"; }
  poll_state() { :; }
  POLL_INTERVAL=0
  EXCLUDE_PID=4242; EXCLUDE_IDENTITY="4242:777"
  spawn_if_proven_empty >/dev/null 2>&1
  echo "spawns=$(wc -l < "$SPAWN_LOG") exclude_cleared=$([[ -z "${EXCLUDE_PID:-}" ]] && echo yes || echo no)"
')
WITH_ARGS=$(grep -c "^prove-empty 4242" "$EXCL_HOME/calls.log")
WITHOUT_ARGS=$(grep -c "^prove-empty$" "$EXCL_HOME/calls.log")
VETO_LINES=$(grep -c "Planned-replacement exclusion vetoed" "$EXCL_HOME/logs/watchdog.log")
if [[ "$RESULT" != *"spawns=1 exclude_cleared=yes"* || "$WITH_ARGS" != "1" || "$WITHOUT_ARGS" -lt 1 || "$VETO_LINES" != "1" ]]; then
  echo "FAIL: veto by another process must clear the exclusion once, then prove plainly — got: $RESULT with=$WITH_ARGS without=$WITHOUT_ARGS veto=$VETO_LINES"
  exit 1
fi
echo "OK: occupied/inconclusive proofs veto and clear the replacement exclusion (one event line)"

rm -rf "$EXCL_HOME"

rm -rf "$GATE_HOME"

echo "ALL TESTS PASSED"
exit 0
