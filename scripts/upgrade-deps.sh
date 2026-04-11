#!/usr/bin/env bash
# upgrade-deps.sh — Upgrade all AgentBridge external dependencies.
# Run periodically or when version drift is suspected.
#
# What it upgrades:
#   - Node.js packages (npm)
#   - pipx Python tools (nlm, mcporter, yt-dlp, etc.)
#   - kiro-cli (if updater available)
#
# Safe to run anytime — does not restart the bridge.

set -euo pipefail

echo "🔄 AgentBridge dependency upgrade"
echo ""

# --- Node.js packages ---
echo "📦 npm packages..."
cd "$(dirname "$0")/.."
npm update --save 2>&1 | tail -5
npm audit fix --force 2>/dev/null || true
echo ""

# --- pipx Python tools ---
echo "🐍 pipx tools..."
PIPX_TOOLS=(
  "notebooklm-mcp-cli"          # nlm — NotebookLM CLI for /nlm command
  "office-powerpoint-mcp-server" # mcporter — PowerPoint MCP server
  "yt-dlp"                       # YouTube downloader (used by browse agent)
)
for tool in "${PIPX_TOOLS[@]}"; do
  name="${tool%% *}"
  echo -n "  $name: "
  current=$(pipx list --short 2>/dev/null | grep "^$name " | awk '{print $2}' || echo "not installed")
  latest=$(pip index versions "$name" 2>/dev/null | head -1 | grep -oP '\(.*?\)' | tr -d '()' || echo "?")
  if [ "$current" = "$latest" ]; then
    echo "$current (up to date)"
  else
    echo "$current → $latest"
    pipx install "$name==$latest" --force 2>&1 | tail -1
  fi
done
echo ""

# --- Homebrew (macOS) ---
if command -v brew &>/dev/null; then
  echo "🍺 Homebrew..."
  brew update 2>&1 | tail -2
  brew upgrade 2>&1 | tail -5
  echo ""
fi

# --- kiro-cli ---
echo "🤖 kiro-cli..."
kiro_version=$(kiro-cli --version 2>/dev/null || echo "not found")
echo "  Current: $kiro_version"
echo "  (update via: kiro-cli update, or download from kiro.dev)"
echo ""

echo "✅ Done"
