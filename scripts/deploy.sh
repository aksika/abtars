#!/usr/bin/env bash
# deploy.sh — Deploy agentbridge to ~/.agentbridge runtime directory.
#
# Copies .env, builds the project, and deploys steering files.
# Run from the project root: ./scripts/deploy.sh
#
# Usage:
#   ./scripts/deploy.sh          # full deploy (build + env + steering + launcher)
#   ./scripts/deploy.sh --quick  # env + steering + launcher only (skip build)
#   ./scripts/deploy.sh --full   # full deploy + pull latest Docker images (Lightpanda)

set -euo pipefail

AB_HOME="${HOME}/.agentbridge"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
QUICK=false
FULL=false

for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=true ;;
    --full) FULL=true ;;
  esac
done

echo "🚀 Deploying agentbridge..."
echo "   Project: $PROJECT_DIR"
echo "   Runtime: $AB_HOME"
echo ""

mkdir -p "$AB_HOME"
mkdir -p "$AB_HOME/logs" "$AB_HOME/topics" "$AB_HOME/workspace" "$AB_HOME/memory/working" "$AB_HOME/memory/sleep" "$AB_HOME/memory/retrospectives" "$AB_HOME/received/media" "$AB_HOME/backup" "$AB_HOME/logo"

# 0. Initialize git backup repo if not present
if [ ! -d "$AB_HOME/.git" ]; then
  echo "📦 Initializing git backup repo..."
  cd "$AB_HOME"
  git init -q
  cat > .gitignore << 'GITIGNORE'
.env
agentbridge-*
mcporter
browser-patchright.sh
agentbridge.sh
scripts/
dist/
memory/memory.db
memory/memory.db-wal
memory/memory.db-shm
memory/pending_*.json
memory/cron_runs.json
memory/cron.json.migrated
memory/.heartbeat
memory/context-window-start.json
memory/garbage.json
logs/
finance/rss-*.json
.kiro/
titok/
sleeping_prompt.md
browsing_prompt.md
professor.json
GITIGNORE
  echo "backup/memory.db.enc binary" > .gitattributes
  git add -A
  git commit -q -m "initial: agentbridge runtime"
  echo "   ✅ Git repo initialized — add remote with: cd ~/.agentbridge && git remote add origin <url>"
fi

# 1. Sync .env (from persona/core/ — gitignored, personal)
echo "📋 Syncing .env..."
if [ -f "$PROJECT_DIR/persona/core/.env" ]; then
  cp "$PROJECT_DIR/persona/core/.env" "$AB_HOME/.env"
elif [ -f "$AB_HOME/.env" ]; then
  echo "   ⏭  No persona/core/.env — keeping existing"
else
  cp "$PROJECT_DIR/.env.example" "$AB_HOME/.env"
  echo "   ℹ️  Created .env from .env.example — edit ~/.agentbridge/.env with your tokens"
fi
chmod 600 "$AB_HOME/.env" 2>/dev/null

# memory.env (ABM config — create from example if missing)
if [ ! -f "$AB_HOME/memory.env" ]; then
  cp "$PROJECT_DIR/memory.env.example" "$AB_HOME/memory.env"
  chmod 600 "$AB_HOME/memory.env"
  echo "   ℹ️  Created memory.env from example"
fi
chmod 600 "$AB_HOME/memory.env" 2>/dev/null

# 2. Build (unless --quick)
if [ "$QUICK" = false ]; then
  echo "🔨 Building..."
  cd "$PROJECT_DIR"
  npm run build
fi

# 2b. Copy runtime files to AB_HOME (self-contained)
echo "📦 Copying runtime..."
cp "$PROJECT_DIR/package.json" "$AB_HOME/package.json"
rsync -a --delete "$PROJECT_DIR/dist/" "$AB_HOME/dist/"
rsync -a --delete "$PROJECT_DIR/node_modules/" "$AB_HOME/node_modules/"

# 2c. Copy asbuilts to knowledgebase (agent-readable, no source code paths)
echo "📚 Copying knowledgebase..."
mkdir -p "$AB_HOME/knowledgebase"
cp "$PROJECT_DIR/docs/asbuilts/system.asbuilt.md" "$AB_HOME/knowledgebase/"
cp "$PROJECT_DIR/docs/asbuilts/memory.asbuilt.md" "$AB_HOME/knowledgebase/"

# Generate CLI wrapper scripts in ~/.agentbridge/bin/
echo "🔧 Generating CLI wrappers..."
mkdir -p "$AB_HOME/bin"
for js in "$AB_HOME/dist/cli/agentbridge-"*.js; do
  name=$(basename "$js" .js)
  printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$js" > "$AB_HOME/bin/$name"
  chmod +x "$AB_HOME/bin/$name"
done
[ -d "$PROJECT_DIR/docker" ] && rsync -a "$PROJECT_DIR/docker/" "$AB_HOME/docker/"
[ -d "$PROJECT_DIR/logo" ] && rsync -a "$PROJECT_DIR/logo/" "$AB_HOME/logo/"

# 3. Deploy persona files
echo "📝 Deploying persona..."

# safe_cp: skip if deployed file is newer than source (agent may have modified it)
safe_cp() {
  local src="$1" dst="$2"
  if [[ -f "$dst" && "$dst" -nt "$src" ]]; then
    echo "   ⏭  KEPT newer: $(basename "$dst")"
    return
  fi
  cp "$src" "$dst"
}

# Core (personal): deploy from persona/core/ if exists, else persona/core_templates/
CORE_SRC="$PROJECT_DIR/persona/core"
if [ -z "$(ls "$CORE_SRC/"*.md 2>/dev/null)" ]; then
  CORE_SRC="$PROJECT_DIR/persona/core_templates"
  echo "   ℹ️  Using core_templates (no .md files in persona/core/)"
fi
mkdir -p "$AB_HOME/core"
for f in "$CORE_SRC/"*.md; do
  [ -f "$f" ] && safe_cp "$f" "$AB_HOME/core/$(basename "$f")"
done

# Transport profiles (skip existing — may contain secrets)
mkdir -p "$AB_HOME/transports"
if [ -d "$CORE_SRC/transports" ]; then
  for f in "$CORE_SRC/transports/"*.env; do
    dest="$AB_HOME/transports/$(basename "$f")"
    [ -f "$f" ] && [ ! -f "$dest" ] && cp "$f" "$dest"
  done
  echo "  ✓ Transport profiles deployed (existing preserved)"
fi

# Prompts: always from repo
mkdir -p "$AB_HOME/prompts"
for f in "$PROJECT_DIR/persona/prompts/"*.md; do
  [ -f "$f" ] && safe_cp "$f" "$AB_HOME/prompts/$(basename "$f")"
done

# Sleep step files — clean old files first
rm -f "$AB_HOME/prompts/sleep/"*.md
mkdir -p "$AB_HOME/prompts/sleep"
for f in "$PROJECT_DIR/persona/prompts/sleep/"*.md; do
  [ -f "$f" ] && safe_cp "$f" "$AB_HOME/prompts/sleep/$(basename "$f")"
done

# Skills: always from repo → core subdir
mkdir -p "$AB_HOME/skills/core" "$AB_HOME/skills/auto" "$AB_HOME/agents"
for f in "$PROJECT_DIR/persona/skills/"*.md; do
  [ -f "$f" ] && safe_cp "$f" "$AB_HOME/skills/core/$(basename "$f")"
done
for f in "$PROJECT_DIR/persona/agents/"*.md; do
  [ -f "$f" ] && safe_cp "$f" "$AB_HOME/agents/$(basename "$f")"
done

# Tasks (personal): deploy from persona/tasks/ if exists, else create empty dir
mkdir -p "$AB_HOME/tasks"
if [ -d "$PROJECT_DIR/persona/tasks" ] && [ -n "$(ls -A "$PROJECT_DIR/persona/tasks" 2>/dev/null)" ]; then
  for f in "$PROJECT_DIR/persona/tasks/"*.md; do
    [ -f "$f" ] && safe_cp "$f" "$AB_HOME/tasks/$(basename "$f")"
  done
fi

# Agent config
safe_cp "$PROJECT_DIR/persona/professor.json" "$AB_HOME/professor.json"

# 4. Deploy launcher script + recall CLI
echo "🚀 Deploying launcher + recall CLI..."
# Write agentbridge.sh with correct AB_HOME baked in
{
  echo "#!/usr/bin/env bash"
  echo "PROJECT_DIR=\"$AB_HOME\""
  tail -n +3 "$PROJECT_DIR/scripts/agentbridge.sh"
} > "$AB_HOME/agentbridge.sh"
chmod +x "$AB_HOME/agentbridge.sh"
# Write browser-patchright.sh pointing to AB_HOME (self-contained)
{
  echo "#!/usr/bin/env bash"
  echo "PROJECT_DIR=\"$AB_HOME\""
  tail -n +3 "$PROJECT_DIR/scripts/browser-patchright.sh"
} > "$AB_HOME/browser-patchright.sh"
chmod +x "$AB_HOME/browser-patchright.sh"

# Deploy browser-lightpanda.sh
cp "$PROJECT_DIR/scripts/browser-lightpanda.sh" "$AB_HOME/browser-lightpanda.sh"
chmod +x "$AB_HOME/browser-lightpanda.sh"
mkdir -p "$AB_HOME/scripts"
for script in daily-backup.sh doctor.sh upgrade-deps.sh; do
  cp "$PROJECT_DIR/scripts/$script" "$AB_HOME/scripts/$script"
  chmod +x "$AB_HOME/scripts/$script"
done

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

# Deploy agentbridge-embed CLI + check ollama (only if EMBEDDING_ENABLED=true in .env)
if grep -q "^EMBEDDING_ENABLED=true" "$AB_HOME/.env" 2>/dev/null; then
  EMBED_SCRIPT="$AB_HOME/agentbridge-embed"
  echo '#!/usr/bin/env bash' > "$EMBED_SCRIPT"
  echo "EMBEDDING_ENABLED=true exec node \"$AB_HOME/dist/cli/agentbridge-embed.js\" \"\$@\"" >> "$EMBED_SCRIPT"
  chmod +x "$EMBED_SCRIPT"
  ln -sf "$EMBED_SCRIPT" "$HOME/.local/bin/agentbridge-embed"

  # Check ollama is running and model is pulled
  if command -v ollama &>/dev/null; then
    if ! curl -sf http://localhost:11434/api/tags &>/dev/null; then
      echo "   ⚠️  ollama not running — start with: sudo systemctl start ollama"
    elif ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
      echo "   ⚠️  nomic-embed-text not pulled — run: ollama pull nomic-embed-text"
    else
      echo "   ✅ Se pipeline ready (ollama + nomic-embed-text)"
    fi
  else
    echo "   ⚠️  ollama not installed — Se pipeline disabled"
  fi
fi

# 5. Docker image pulls (--full only)
if [ "$FULL" = true ]; then
  echo "📦 Pulling/rebuilding Docker images..."
  if command -v docker &>/dev/null; then
    docker pull lightpanda/browser:nightly 2>/dev/null && echo "   ✅ Lightpanda nightly pulled" || echo "   ⚠️  Lightpanda pull failed"
    if [ -d "$PROJECT_DIR/docker/browser" ]; then
      DOCKER_BUILDKIT=0 docker build -t agentbridge-browser -f "$PROJECT_DIR/docker/browser/Dockerfile" "$PROJECT_DIR" 2>&1 | tail -3 && echo "   ✅ Patchright browser image rebuilt" || echo "   ⚠️  Patchright build failed"
    fi
  else
    echo "   ⚠️  Docker not installed — skipping image pulls"
  fi
fi

# 6. Done
echo ""
echo "✅ Deploy complete."
echo ""
echo "Next steps:"
echo "  Start bridge:  ~/.agentbridge/agentbridge.sh"
echo "  Start bridge:  ~/.agentbridge/agentbridge.sh --all"
echo "  Stop bridge:   ~/.agentbridge/agentbridge.sh stop"
