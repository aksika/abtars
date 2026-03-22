#!/usr/bin/env bash
# agentbridge.sh — One-command launcher for the AgentBridge.
#
# Ensures the tmux/kiro-cli session is running, then starts the bridge.
# Deployed to ~/.agentbridge/ by deploy.sh
#
# Usage:
#   ~/.agentbridge/agentbridge.sh                  # default: --telegram
#   ~/.agentbridge/agentbridge.sh --telegram
#   ~/.agentbridge/agentbridge.sh --acp             # use ACP transport
#   ~/.agentbridge/agentbridge.sh --all
#   ~/.agentbridge/agentbridge.sh stop             # kill bridge + tmux session

set -euo pipefail

AB_HOME="${HOME}/.agentbridge"
PROJECT_DIR="/mnt/c/Users/qakosal/workspace/agent/agentbridge"
ARGS=("${@:---telegram}")

# Load env
if [ -f "$AB_HOME/.env" ]; then
  set -a; source "$AB_HOME/.env"; set +a
fi

SESSION="${TMUX_SESSION:-kiro-bridge}"

# --- stop command ---
if [[ " ${ARGS[*]} " == *" stop "* ]]; then
  echo "🛑 Stopping agentbridge..."
  # Kill the bridge process if running
  pkill -f "node.*dist/main.js" 2>/dev/null && echo "   Bridge stopped." || echo "   Bridge not running."
  # Kill tmux session
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux kill-session -t "$SESSION"
    echo "   tmux session '$SESSION' killed."
  else
    echo "   tmux session '$SESSION' not running."
  fi
  exit 0
fi

# --- ensure nvm is loaded ---
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "🚀 AgentBridge launcher"
echo "   Args:     ${ARGS[*]}"
echo "   Node:     $(node --version)"
echo ""

# --- skip tmux session for ACP transport ---
if [[ " ${ARGS[*]} " == *" --tmux "* ]]; then
  echo "♻️  Restarting tmux session '$SESSION'..."
  "$PROJECT_DIR/scripts/tmux-session.sh"
  sleep 2
elif [[ " ${ARGS[*]} " == *" --acp "* ]] || [[ "${KIRO_TRANSPORT:-acp}" == "acp" ]]; then
  echo "🔌 ACP transport — skipping tmux session"
else
  echo "♻️  Restarting tmux session '$SESSION'..."
  "$PROJECT_DIR/scripts/tmux-session.sh"
  sleep 2
fi

# --- ensure mcporter daemon is running (for MCP servers like pptx) ---
if command -v mcporter &>/dev/null; then
  mcporter daemon start 2>/dev/null || true
fi

# --- run doctor health check ---
if [ -x "$AB_HOME/scripts/doctor.sh" ]; then
  "$AB_HOME/scripts/doctor.sh" 2>&1 | sed 's/^/   /'
  echo ""
fi

# --- start the bridge ---
echo "🌉 Starting bridge..."
cd "$PROJECT_DIR"
exec node dist/main.js "${ARGS[@]}"
