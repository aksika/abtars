#!/usr/bin/env bash
# setup.sh — Set up agentbridge in WSL.
#
# Usage: ./wsl/setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")/agentbridge"
AB_HOME="$HOME/.agentbridge"

echo "📦 Setting up agentbridge..."
echo "   Project: $PROJECT_DIR"
echo "   Config:  $AB_HOME"

# Source nvm if available
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
  nvm use 22 2>/dev/null || nvm install 22
fi

echo ""
echo "Node: $(node --version)"
echo "npm:  $(npm --version)"

# Install dependencies
cd "$PROJECT_DIR"
npm install

echo ""
echo "✅ Dependencies installed"

# Build
npm run build
echo "✅ Build complete"

# Create ~/.agentbridge with .env
mkdir -p "$AB_HOME"
if [ ! -f "$AB_HOME/.env" ]; then
  cp .env.example "$AB_HOME/.env"
  echo "✅ Created $AB_HOME/.env"
else
  echo "ℹ️  $AB_HOME/.env already exists — skipping"
fi

# Run tests
npm test
echo "✅ Tests passed"

echo ""
echo "Next steps:"
echo "  1. Edit ~/.agentbridge/.env with your bot token and user ID"
echo "  2. ./agentbridge/scripts/tmux-session.sh"
echo "  3. ./wsl/run.sh"
