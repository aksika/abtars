#!/usr/bin/env bash
# run.sh — Start agentbridge from WSL.
#
# Usage: ./wsl/run.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")/agentbridge"
AB_HOME="$HOME/.agentbridge"

# Source nvm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
  nvm use 22 2>/dev/null || true
fi

# Ensure ~/.agentbridge exists with .env
mkdir -p "$AB_HOME"
if [ ! -f "$AB_HOME/.env" ]; then
  if [ -f "$PROJECT_DIR/.env.example" ]; then
    cp "$PROJECT_DIR/.env.example" "$AB_HOME/.env"
    echo "⚠️  Created $AB_HOME/.env from template — edit it with your bot token and user IDs"
    exit 1
  else
    echo "❌ No .env found. Copy .env.example to $AB_HOME/.env and configure it."
    exit 1
  fi
fi

cd "$PROJECT_DIR"

# Source .env for tmux session name
set -a; source "$AB_HOME/.env"; set +a

# Start tmux session if not running
if ! tmux has-session -t "${TMUX_SESSION:-kiro-bridge}" 2>/dev/null; then
  echo "Starting tmux session..."
  ./scripts/tmux-session.sh
fi

# Build if dist/ is missing
if [ ! -f dist/main.js ]; then
  echo "Building..."
  npm install 2>/dev/null
  npm run build
fi

echo "Starting agentbridge..."
node dist/main.js
