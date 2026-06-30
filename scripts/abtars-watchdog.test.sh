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

echo "ALL TESTS PASSED"
exit 0
