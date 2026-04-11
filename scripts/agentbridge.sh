#!/usr/bin/env bash
# agentbridge.sh — One-command launcher for the AgentBridge.
#
# PID-guarded: if bridge is already running, exits silently.
# LaunchAgent handles restarts — no internal restart loop.
#
# Usage:
#   ~/.agentbridge/agentbridge.sh                  # default: --telegram
#   ~/.agentbridge/agentbridge.sh --telegram
#   ~/.agentbridge/agentbridge.sh --all
#   ~/.agentbridge/agentbridge.sh stop             # kill bridge + tmux session

set -euo pipefail

AB_HOME="${HOME}/.agentbridge"
PROJECT_DIR="$HOME/.agentbridge"
ARGS=("${@:---telegram}")
PIDFILE="$AB_HOME/bridge.pid"

# Load env
if [ -f "$AB_HOME/.env" ]; then
  set -a; source "$AB_HOME/.env"; set +a
fi

SESSION="${TMUX_SESSION:-kiro-bridge}"

# --- stop command ---
if [[ " ${ARGS[*]} " == *" stop "* ]]; then
  echo "🛑 Stopping agentbridge..."
  if [ -f "$PIDFILE" ]; then
    pid=$(cat "$PIDFILE")
    kill "$pid" 2>/dev/null && echo "   Bridge stopped (pid $pid)." || echo "   Bridge not running."
    rm -f "$PIDFILE"
  else
    pkill -f "node.*dist/src/main.js" 2>/dev/null && echo "   Bridge stopped." || echo "   Bridge not running."
  fi
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux kill-session -t "$SESSION"
    echo "   tmux session '$SESSION' killed."
  fi
  if command -v mcporter &>/dev/null; then
    mcporter daemon stop 2>/dev/null && echo "   mcporter daemon stopped." || true
  fi
  exit 0
fi

# --- PID guard: if bridge is already running, exit ---
if [ -f "$PIDFILE" ]; then
  existing_pid=$(cat "$PIDFILE")
  if kill -0 "$existing_pid" 2>/dev/null; then
    echo "Bridge already running (pid $existing_pid). Exiting."
    exit 0
  fi
  # Stale PID file — process dead, clean up
  rm -f "$PIDFILE"
fi

# --- ensure nvm is loaded ---
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "🚀 AgentBridge launcher"
echo "   Args:     ${ARGS[*]}"
echo "   Node:     $(node --version)"
echo ""

# --- kill any orphaned bridge process ---
if pkill -f "node.*dist/src/main.js" 2>/dev/null; then
  echo "   Killed orphaned bridge process."
  sleep 1
fi

# --- run doctor health check ---
if [ -x "$AB_HOME/scripts/doctor.sh" ]; then
  "$AB_HOME/scripts/doctor.sh" --fix 2>&1 | sed 's/^/   /'
  echo ""
fi

# --- start the bridge (no restart loop — LaunchAgent handles restarts) ---
echo "🌉 Starting bridge..."
cd "$PROJECT_DIR"

# Write PID file, clean up on exit
cleanup() { rm -f "$PIDFILE"; }
trap cleanup EXIT

node dist/src/main.js "${ARGS[@]}" &
BRIDGE_PID=$!
echo "$BRIDGE_PID" > "$PIDFILE"
echo "   Bridge started (pid $BRIDGE_PID)"

# Wait for bridge to exit
wait $BRIDGE_PID
exit_code=$?

if [ $exit_code -eq 0 ]; then
  echo "Bridge exited cleanly."
else
  echo "⚠️ Bridge exited (code $exit_code) — LaunchAgent will restart."
fi

exit $exit_code
