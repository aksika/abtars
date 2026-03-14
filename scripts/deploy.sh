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
  echo "🌐 Installing Patchright browser..."
  npx patchright install chrome 2>/dev/null || npx patchright install chromium
fi

# 3. Deploy steering files (SOUL.md + skills as steering)
echo "📝 Deploying steering files..."
mkdir -p "$AB_HOME/.kiro/steering"
cp "$PROJECT_DIR/persona/SOUL.md" "$AB_HOME/.kiro/steering/SOUL.md"
mkdir -p "$AB_HOME/.kiro/agents"
cp "$PROJECT_DIR/persona/professor.json" "$AB_HOME/.kiro/agents/professor.json"
cp "$PROJECT_DIR/skills/memory-search/SKILL.md" "$AB_HOME/.kiro/steering/memory-search.md"
cp "$PROJECT_DIR/skills/instant-store/SKILL.md" "$AB_HOME/.kiro/steering/instant-store.md"
cp "$PROJECT_DIR/skills/nlm/SKILL.md" "$AB_HOME/.kiro/steering/nlm.md"
cp "$PROJECT_DIR/skills/topic-save/SKILL.md" "$AB_HOME/.kiro/steering/topic-save.md"
cp "$PROJECT_DIR/skills/mcporter/SKILL.md" "$AB_HOME/.kiro/steering/mcporter.md"
cp "$PROJECT_DIR/skills/browser/SKILL.md" "$AB_HOME/.kiro/steering/browser.md"
mkdir -p "$AB_HOME/skills/agents"
cp "$PROJECT_DIR/skills/agents/"*.md "$AB_HOME/skills/agents/"

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

# Deploy agentbridge-store CLI (agent-callable memory storage)
STORE_SCRIPT="$AB_HOME/agentbridge-store"
echo '#!/usr/bin/env bash' > "$STORE_SCRIPT"
echo "exec node \"$PROJECT_DIR/dist/cli/agentbridge-store.js\" \"\$@\"" >> "$STORE_SCRIPT"
chmod +x "$STORE_SCRIPT"
ln -sf "$STORE_SCRIPT" "$HOME/.local/bin/agentbridge-store"

# Deploy agentbridge-sleep CLI (overnight memory maintenance)
SLEEP_SCRIPT="$AB_HOME/agentbridge-sleep"
echo '#!/usr/bin/env bash' > "$SLEEP_SCRIPT"
echo "exec node \"$PROJECT_DIR/dist/cli/agentbridge-sleep.js\" \"\$@\"" >> "$SLEEP_SCRIPT"
chmod +x "$SLEEP_SCRIPT"
ln -sf "$SLEEP_SCRIPT" "$HOME/.local/bin/agentbridge-sleep"

# Deploy agentbridge-browser CLI (agent-callable headless browser)
BROWSER_SCRIPT="$AB_HOME/agentbridge-browser"
echo '#!/usr/bin/env bash' > "$BROWSER_SCRIPT"
echo "exec node \"$PROJECT_DIR/dist/cli/agentbridge-browser.js\" \"\$@\"" >> "$BROWSER_SCRIPT"
chmod +x "$BROWSER_SCRIPT"
ln -sf "$BROWSER_SCRIPT" "$HOME/.local/bin/agentbridge-browser"

# Deploy mcporter CLI (MCP tool access)
MCPORTER_DIR="$HOME/workspace/mcporter"
if [ -f "$MCPORTER_DIR/dist/cli.js" ]; then
  MCPORTER_SCRIPT="$AB_HOME/mcporter"
  echo '#!/usr/bin/env bash' > "$MCPORTER_SCRIPT"
  echo "exec node \"$MCPORTER_DIR/dist/cli.js\" \"\$@\"" >> "$MCPORTER_SCRIPT"
  chmod +x "$MCPORTER_SCRIPT"
  ln -sf "$MCPORTER_SCRIPT" "$HOME/.local/bin/mcporter"
  echo "   mcporter CLI linked"
else
  echo "   ⚠️  mcporter not built — skipping (run: cd ~/workspace/mcporter && npm run build)"
fi

# 4. Done
echo ""
echo "✅ Deploy complete."
echo ""
echo "Next steps:"
echo "  Start bridge:  ~/.agentbridge/agentbridge.sh"
echo "  Start bridge:  ~/.agentbridge/agentbridge.sh --all"
echo "  Stop bridge:   ~/.agentbridge/agentbridge.sh stop"
