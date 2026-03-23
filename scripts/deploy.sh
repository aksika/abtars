#!/usr/bin/env bash
# deploy.sh — Deploy agentbridge to ~/.agentbridge runtime directory.
#
# Copies .env, builds the project, and deploys steering files.
# Run from the project root: ./scripts/deploy.sh
#
# Usage:
#   ./scripts/deploy.sh          # full deploy (build + env + steering + launcher)
#   ./scripts/deploy.sh --quick  # env + steering + launcher only (skip build)

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
  # Browser install is a one-time manual step (requires sudo for system deps):
  #   npx patchright install chrome   # preferred, or:
  #   npx patchright install chromium  # fallback
fi

# 3. Deploy steering files (SOUL.md + skills as steering)
echo "📝 Deploying steering files..."
mkdir -p "$AB_HOME/.kiro/steering"
mkdir -p "$AB_HOME/.kiro/agents"
mkdir -p "$AB_HOME/skills/agents"
mkdir -p "$AB_HOME/prompts"

# safe_cp: skip if deployed file is newer than source (agent may have modified it)
safe_cp() {
  local src="$1" dst="$2"
  if [[ -f "$dst" && "$dst" -nt "$src" ]]; then
    echo "   ⏭  KEPT newer: $(basename "$dst")"
    return
  fi
  cp "$src" "$dst"
}

safe_cp "$PROJECT_DIR/persona/SOUL.md" "$AB_HOME/.kiro/steering/SOUL.md"
safe_cp "$PROJECT_DIR/persona/professor.json" "$AB_HOME/.kiro/agents/professor.json"
for f in "$PROJECT_DIR/skills/"*.md; do
  safe_cp "$f" "$AB_HOME/.kiro/steering/$(basename "$f")"
done
safe_cp "$PROJECT_DIR/persona/sleeping_prompt.md" "$AB_HOME/prompts/sleeping_prompt.md"
chmod 444 "$AB_HOME/prompts/sleeping_prompt.md"
safe_cp "$PROJECT_DIR/persona/browsing_prompt.md" "$AB_HOME/prompts/browsing_prompt.md"
chmod 444 "$AB_HOME/prompts/browsing_prompt.md"
for f in "$PROJECT_DIR/skills/agents/"*.md; do
  safe_cp "$f" "$AB_HOME/skills/agents/$(basename "$f")"
done

# 4. Deploy launcher script + recall CLI
echo "🚀 Deploying launcher + recall CLI..."
cp "$PROJECT_DIR/scripts/agentbridge.sh" "$AB_HOME/agentbridge.sh"
chmod +x "$AB_HOME/agentbridge.sh"
cp "$PROJECT_DIR/scripts/browser-docker.sh" "$AB_HOME/browser-docker.sh"
sed -i "s|^PROJECT_DIR=.*|PROJECT_DIR=\"$PROJECT_DIR\"|" "$AB_HOME/browser-docker.sh"
chmod +x "$AB_HOME/browser-docker.sh"
mkdir -p "$AB_HOME/scripts"
cp "$PROJECT_DIR/scripts/daily-backup.sh" "$AB_HOME/scripts/daily-backup.sh"
chmod +x "$AB_HOME/scripts/daily-backup.sh"
cp "$PROJECT_DIR/scripts/doctor.sh" "$AB_HOME/scripts/doctor.sh"
chmod +x "$AB_HOME/scripts/doctor.sh"

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

# Deploy agentbridge-todo CLI (persistent todo list)
TODO_SCRIPT="$AB_HOME/agentbridge-todo"
echo '#!/usr/bin/env bash' > "$TODO_SCRIPT"
echo "exec node \"$PROJECT_DIR/dist/cli/agentbridge-todo.js\" \"\$@\"" >> "$TODO_SCRIPT"
chmod +x "$TODO_SCRIPT"
ln -sf "$TODO_SCRIPT" "$HOME/.local/bin/agentbridge-todo"

# Deploy agentbridge-cron CLI (time-based reminders and tasks)
CRON_SCRIPT="$AB_HOME/agentbridge-cron"
echo '#!/usr/bin/env bash' > "$CRON_SCRIPT"
echo "exec node \"$PROJECT_DIR/dist/cli/agentbridge-cron.js\" \"\$@\"" >> "$CRON_SCRIPT"
chmod +x "$CRON_SCRIPT"
ln -sf "$CRON_SCRIPT" "$HOME/.local/bin/agentbridge-cron"

# Deploy agentbridge-browse CLI (browser subagent launcher)
BROWSE_SCRIPT="$AB_HOME/agentbridge-browse"
echo '#!/usr/bin/env bash' > "$BROWSE_SCRIPT"
echo "exec node \"$PROJECT_DIR/dist/cli/agentbridge-browse.js\" \"\$@\"" >> "$BROWSE_SCRIPT"
chmod +x "$BROWSE_SCRIPT"
ln -sf "$BROWSE_SCRIPT" "$HOME/.local/bin/agentbridge-browse"

# Deploy agentbridge-expand CLI (source message lookup)
EXPAND_SCRIPT="$AB_HOME/agentbridge-expand"
echo '#!/usr/bin/env bash' > "$EXPAND_SCRIPT"
echo "exec node \"$PROJECT_DIR/dist/cli/agentbridge-expand.js\" \"\$@\"" >> "$EXPAND_SCRIPT"
chmod +x "$EXPAND_SCRIPT"
ln -sf "$EXPAND_SCRIPT" "$HOME/.local/bin/agentbridge-expand"

# Deploy agentbridge-tweet CLI (Twitter feed + discovery)
TWEET_SCRIPT="$AB_HOME/agentbridge-tweet"
echo '#!/usr/bin/env bash' > "$TWEET_SCRIPT"
echo "exec node \"$PROJECT_DIR/dist/cli/agentbridge-tweet.js\" \"\$@\"" >> "$TWEET_SCRIPT"
chmod +x "$TWEET_SCRIPT"
ln -sf "$TWEET_SCRIPT" "$HOME/.local/bin/agentbridge-tweet"

# Deploy agentbridge-rss CLI (RSS feed fetcher for finance pipeline)
RSS_SCRIPT="$AB_HOME/agentbridge-rss"
echo '#!/usr/bin/env bash' > "$RSS_SCRIPT"
echo "exec node \"$PROJECT_DIR/dist/cli/agentbridge-rss.js\" \"\$@\"" >> "$RSS_SCRIPT"
chmod +x "$RSS_SCRIPT"
ln -sf "$RSS_SCRIPT" "$HOME/.local/bin/agentbridge-rss"

# Deploy stock watchlist (only if not already present — user manages this file)
mkdir -p "$AB_HOME/finance"
if [ ! -f "$AB_HOME/finance/stock_watchlist.md" ]; then
  cp "$PROJECT_DIR/config/stock_watchlist.md" "$AB_HOME/finance/stock_watchlist.md"
fi

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

# 5. Done
echo ""
echo "✅ Deploy complete."
echo ""
echo "Next steps:"
echo "  Start bridge:  ~/.agentbridge/agentbridge.sh"
echo "  Start bridge:  ~/.agentbridge/agentbridge.sh --all"
echo "  Stop bridge:   ~/.agentbridge/agentbridge.sh stop"
