#!/usr/bin/env bash
# deploy.sh — Deploy agentbridge to ~/.agentbridge runtime directory.
#
# Copies .env, builds the project, and deploys steering files.
# Run from the project root: ./scripts/deploy.sh
#
# Usage:
#   ./scripts/deploy.sh          # full deploy (build + env + steering + restart tmux)
#   ./scripts/deploy.sh --quick  # env + steering only (skip build, skip tmux restart)

set -euo pipefail

AB_HOME="${HOME}/.agentbridge"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
QUICK=false

if [[ "${1:-}" == "--quick" ]]; then
  QUICK=true
fi

echo "🚀 Deploying agentbridge..."
echo "   Project: $PROJECT_DIR"
echo "   Runtime: $AB_HOME"
echo ""

# 1. Sync .env
echo "📋 Syncing .env..."
cp "$PROJECT_DIR/.env" "$AB_HOME/.env"

# 2. Build (unless --quick)
if [ "$QUICK" = false ]; then
  echo "🔨 Building..."
  cd "$PROJECT_DIR"
  npm run build
fi

# 3. Deploy steering files (SOUL.md + skills as steering)
echo "📝 Deploying steering files..."
mkdir -p "$AB_HOME/.kiro/steering"
cp "$PROJECT_DIR/persona/SOUL.md" "$AB_HOME/.kiro/steering/SOUL.md"
cp "$PROJECT_DIR/skills/memory-search/SKILL.md" "$AB_HOME/.kiro/steering/memory-search.md"

# 4. Deploy launcher script + recall CLI
echo "🚀 Deploying launcher + recall CLI..."
cp "$PROJECT_DIR/scripts/agentbridge.sh" "$AB_HOME/agentbridge.sh"
chmod +x "$AB_HOME/agentbridge.sh"

# Deploy agentbridge-recall CLI (agent-callable memory search)
RECALL_SCRIPT="$AB_HOME/agentbridge-recall"
echo '#!/usr/bin/env bash' > "$RECALL_SCRIPT"
echo "exec node \"$PROJECT_DIR/dist/cli/agentbridge-recall.js\" \"\$@\"" >> "$RECALL_SCRIPT"
chmod +x "$RECALL_SCRIPT"
mkdir -p "$HOME/.local/bin"
ln -sf "$RECALL_SCRIPT" "$HOME/.local/bin/agentbridge-recall"

# 4. Restart tmux session (unless --quick)
if [ "$QUICK" = false ]; then
  echo "🔄 Restarting tmux session..."
  # Source the deployed .env for session config
  set -a; source "$AB_HOME/.env"; set +a
  SESSION="${TMUX_SESSION:-kiro-bridge}"

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux kill-session -t "$SESSION"
    echo "   Killed existing session '$SESSION'"
    sleep 1
  fi

  "$PROJECT_DIR/scripts/tmux-session.sh"
fi

echo ""
echo "✅ Deploy complete."
echo ""
echo "Next steps:"
if [ "$QUICK" = true ]; then
  echo "  Restart tmux:  tmux kill-session -t kiro-bridge && ./scripts/tmux-session.sh"
fi
echo "  Start bridge:  ~/.agentbridge/agentbridge.sh"
echo "  Start bridge:  ~/.agentbridge/agentbridge.sh --all"
echo "  Stop bridge:   ~/.agentbridge/agentbridge.sh stop"
