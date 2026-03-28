#!/usr/bin/env bash
# Setup embedding search (Se sidecar) — installs ollama + pulls model + batch-embeds
set -e

echo "🧠 Setting up embedding search..."

# 1. Install ollama if missing
if ! command -v ollama &>/dev/null; then
  echo "📦 Installing ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "   ✅ ollama already installed"
fi

# 2. Ensure ollama is running
if ! curl -sf http://localhost:11434/api/tags &>/dev/null; then
  echo "🔄 Starting ollama..."
  sudo systemctl start ollama
  sleep 2
fi

# 3. Pull model
if ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
  echo "📥 Pulling nomic-embed-text (274MB)..."
  ollama pull nomic-embed-text
else
  echo "   ✅ nomic-embed-text already pulled"
fi

# 4. Enable in .env if not already
ENV_FILE="$HOME/.agentbridge/.env"
if [ -f "$ENV_FILE" ]; then
  if ! grep -q "^EMBEDDING_ENABLED=true" "$ENV_FILE"; then
    echo "" >> "$ENV_FILE"
    echo "EMBEDDING_ENABLED=true" >> "$ENV_FILE"
    echo "   ✅ EMBEDDING_ENABLED=true added to .env"
  else
    echo "   ✅ EMBEDDING_ENABLED already set"
  fi
fi

# 5. Batch-embed existing memories
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$PROJECT_DIR/dist/cli/agentbridge-embed.js" ]; then
  echo "🔢 Embedding existing memories..."
  EMBEDDING_ENABLED=true node "$PROJECT_DIR/dist/cli/agentbridge-embed.js"
else
  echo "   ⚠️  Build first: npm run build"
fi

echo ""
echo "✅ Se pipeline ready."
