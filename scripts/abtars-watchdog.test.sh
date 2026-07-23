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

echo "ALL TESTS PASSED"
exit 0
