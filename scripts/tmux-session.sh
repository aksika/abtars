#!/usr/bin/env bash
# tmux-session.sh — Start a tmux session running kiro-cli for the bridge.
# Run once before starting the telegram-kiro-bridge.
#
# Usage:  ./scripts/tmux-session.sh
# Kill:   tmux kill-session -t kiro-bridge

set -euo pipefail

SESSION="${TMUX_SESSION:-kiro-bridge}"
WORKING_DIR="${WORKING_DIR:-.}"
KIRO_CLI="${KIRO_CLI_PATH:-kiro-cli}"

# Load .env from ~/.agentbridge/ if present
AB_HOME="${HOME}/.agentbridge"
if [ -f "$AB_HOME/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$AB_HOME/.env"; set +a
  SESSION="${TMUX_SESSION:-$SESSION}"
  WORKING_DIR="${WORKING_DIR:-$WORKING_DIR}"
  KIRO_CLI="${KIRO_CLI_PATH:-$KIRO_CLI}"
fi

# Resolve working directory
WORKING_DIR=$(eval echo "$WORKING_DIR")
mkdir -p "$WORKING_DIR" 2>/dev/null || true

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "♻️  Killing existing tmux session '$SESSION'..."
  tmux kill-session -t "$SESSION"
fi

# Build kiro-cli command with optional --model flag
KIRO_CMD="$KIRO_CLI chat --trust-all-tools"
if [ -n "${KIRO_MODEL:-}" ]; then
  KIRO_CMD="$KIRO_CMD --model $KIRO_MODEL"
fi

echo "Starting tmux session '$SESSION'..."
echo "  Working dir: $WORKING_DIR"
echo "  Command:     $KIRO_CMD"

# Create the tmux session with kiro-cli running inside
tmux new-session -d -s "$SESSION" -c "$WORKING_DIR" "$KIRO_CMD"
tmux set-option -t "$SESSION" history-limit 5000
sleep 3

# Verify kiro-cli started
OUTPUT=$(tmux capture-pane -t "$SESSION" -p -S -10 2>/dev/null || echo "")

if [ -n "$OUTPUT" ]; then
  echo "✅ tmux session '$SESSION' started with kiro-cli."
else
  echo "⚠️  tmux session created but kiro-cli may not have started."
  echo "   Check: tmux attach -t $SESSION"
fi

echo ""
echo "Commands:"
echo "  Attach:  tmux attach -t $SESSION"
echo "  Detach:  Ctrl+B then D"
echo "  Kill:    tmux kill-session -t $SESSION"
echo ""
echo "Now start the bridge: npm start"
