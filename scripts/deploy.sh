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

# 1. Sync .env — merge new keys from .env.example, never overwrite existing values
echo "📋 Syncing .env..."

merge_env() {
  local source="$1"
  local target="$2"

  if [ ! -f "$target" ]; then
    cp "$source" "$target"
    chmod 600 "$target"
    echo "   ✓ Created .env from .env.example — edit ~/.agentbridge/.env with your tokens"
    return
  fi

  local added=0 preserved=0 obsolete=0

  # Add new keys from source that don't exist in target
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in \#*|"") continue ;; esac
    key="${line%%=*}"
    [ -z "$key" ] && continue
    if ! grep -q "^${key}=" "$target" 2>/dev/null; then
      echo "$line" >> "$target"
      added=$((added + 1))
      echo "   + Added: $key"
    else
      preserved=$((preserved + 1))
    fi
  done < "$source"

  echo "   ✓ .env: ${added} added, ${preserved} preserved"
}

merge_env "$PROJECT_DIR/.env.example" "$AB_HOME/.env"

# .env.memory (ABM config — create from example if missing)
if [ ! -f "$AB_HOME/config/.env.memory" ]; then
  cp "$PROJECT_DIR/.env.memory.example" "$AB_HOME/config/.env.memory"
  chmod 600 "$AB_HOME/config/.env.memory"
  echo "   ℹ️  Created .env.memory from example"
fi
chmod 600 "$AB_HOME/config/.env.memory" 2>/dev/null

# .env.skills (skill/integration config — create from example if missing)
if [ ! -f "$AB_HOME/config/.env.skills" ]; then
  cp "$PROJECT_DIR/.env.skills.example" "$AB_HOME/config/.env.skills"
  chmod 600 "$AB_HOME/config/.env.skills"
  echo "   ℹ️  Created .env.skills from example — edit with your integration keys"
fi
chmod 600 "$AB_HOME/config/.env.skills" 2>/dev/null

# transport.json + models.json (create from examples if missing)
if [ ! -f "$AB_HOME/config/transport.json" ]; then
  cp "$PROJECT_DIR/config/transport.json.example" "$AB_HOME/config/transport.json"
  echo "   ℹ️  Created transport.json from example — edit with your providers"
fi
if [ ! -f "$AB_HOME/config/models.json" ]; then
  cp "$PROJECT_DIR/config/models.json.example" "$AB_HOME/config/models.json"
  echo "   ℹ️  Created models.json from example"
fi
chmod 700 "$AB_HOME/config"

# auto-fix.json (self-healer rules — KEPT if newer)
mkdir -p "$AB_HOME/config"
# Migrate old config files to config/ (one-time)
[ -f "$AB_HOME/.env.memory" ] && [ ! -f "$AB_HOME/config/.env.memory" ] && mv "$AB_HOME/.env.memory" "$AB_HOME/config/.env.memory" && echo "   ↗ Migrated .env.memory → config/"
[ -f "$AB_HOME/.env.skills" ] && [ ! -f "$AB_HOME/config/.env.skills" ] && mv "$AB_HOME/.env.skills" "$AB_HOME/config/.env.skills" && echo "   ↗ Migrated .env.skills → config/"
if [ -f "$PROJECT_DIR/persona/config/auto-fix.json" ]; then
  if [ ! -f "$AB_HOME/config/auto-fix.json" ] || [ "$PROJECT_DIR/persona/config/auto-fix.json" -nt "$AB_HOME/config/auto-fix.json" ]; then
    cp "$PROJECT_DIR/persona/config/auto-fix.json" "$AB_HOME/config/auto-fix.json"
  fi
fi

# 2. Build (unless --quick)
if [ "$QUICK" = false ]; then
  cd "$PROJECT_DIR"
  echo "📥 Pulling latest..."
  git pull --ff-only 2>/dev/null || echo "   ⚠️  git pull failed — building from local"
  echo "📦 Installing dependencies..."
  npm install --no-audit --no-fund 2>&1 | tail -1
  echo "🔨 Building..."
  npm run build
fi

# 2b. Copy runtime files to AB_HOME (self-contained)
echo "📦 Copying runtime..."
cp "$PROJECT_DIR/package.json" "$AB_HOME/package.json"
rsync -a --delete "$PROJECT_DIR/dist/" "$AB_HOME/dist/"
rsync -a --delete "$PROJECT_DIR/node_modules/" "$AB_HOME/node_modules/"

# Wire abmind in deployed node_modules (workspace symlink doesn't survive deploy)
rm -rf "$AB_HOME/node_modules/abmind"
ln -s "$AB_HOME/dist/packages/memory" "$AB_HOME/node_modules/abmind"

# 2c. Copy asbuilts to knowledgebase (agent-readable, no source code paths)
echo "📚 Copying knowledgebase..."
mkdir -p "$AB_HOME/knowledgebase"
cp "$PROJECT_DIR/docs/asbuilts/system.asbuilt.md" "$AB_HOME/knowledgebase/"
cp "$PROJECT_DIR/docs/asbuilts/memory.asbuilt.md" "$AB_HOME/knowledgebase/"

# Generate CLI wrapper scripts in ~/.agentbridge/bin/
echo "🔧 Generating CLI wrappers..."
mkdir -p "$AB_HOME/bin"
# abmind unified CLI
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$AB_HOME/dist/src/cli/abmind.js" > "$AB_HOME/bin/abmind"
chmod +x "$AB_HOME/bin/abmind"
# Other CLIs
for js in "$AB_HOME/dist/src/cli/agentbridge-"*.js; do
  [ -f "$js" ] || continue
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
mkdir -p "$AB_HOME/skills/core" "$AB_HOME/skills/auto" "$AB_HOME/skills/clawhub" "$AB_HOME/agents"
# Clean stale loose .md files from skills/ root (old deploy artifacts)
find "$AB_HOME/skills" -maxdepth 1 -name "*.md" -delete 2>/dev/null
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
for script in "$PROJECT_DIR"/scripts/*; do
  [ -f "$script" ] || continue
  cp "$script" "$AB_HOME/scripts/$(basename "$script")"
  chmod +x "$AB_HOME/scripts/$(basename "$script")"
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

# Deploy abmind embed CLI + check ollama (only if EMBEDDING_ENABLED=true in .env)
if grep -q "^EMBEDDING_ENABLED=true" "$AB_HOME/.env" 2>/dev/null; then
  EMBED_SCRIPT="$AB_HOME/abmind-embed"
  echo '#!/usr/bin/env bash' > "$EMBED_SCRIPT"
  echo "EMBEDDING_ENABLED=true exec node \"$AB_HOME/dist/src/cli/abmind.js\" embed \"\$@\"" >> "$EMBED_SCRIPT"
  chmod +x "$EMBED_SCRIPT"
  ln -sf "$EMBED_SCRIPT" "$HOME/.local/bin/abmind-embed"

  # Check ollama is running and model is pulled
  if command -v ollama &>/dev/null; then
    if ! curl -sf http://localhost:11434/api/tags &>/dev/null; then
      echo "   ⚠️  ollama not running — start with: sudo systemctl start ollama"
    elif ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
      echo "   ⚠️  nomic-embed-text not pulled — run: ollama pull nomic-embed-text"
    else
      echo "   ✅ Se pipeline ready (ollama + nomic-embed-text)"
    fi
    # Ensure OLLAMA_NUM_PARALLEL=2 for concurrent requests (prevents collision between main agent + subagents)
    if [ "$(curl -sf http://localhost:11434/api/tags &>/dev/null && echo ok)" = "ok" ]; then
      PARALLEL=$(printenv OLLAMA_NUM_PARALLEL 2>/dev/null || echo "")
      if [ -z "$PARALLEL" ] || [ "$PARALLEL" -lt 2 ] 2>/dev/null; then
        echo "   ⚠️  OLLAMA_NUM_PARALLEL not set or <2 — set it for concurrent request support:"
        if [ "$(uname)" = "Darwin" ]; then
          echo "      launchctl setenv OLLAMA_NUM_PARALLEL 2 && pkill ollama"
          echo "      Then add to ollama plist: PlistBuddy -c 'Add :EnvironmentVariables:OLLAMA_NUM_PARALLEL string 2' ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist"
        else
          echo "      echo 'Environment=\"OLLAMA_NUM_PARALLEL=2\"' | sudo tee -a /etc/systemd/system/ollama.service.d/override.conf"
          echo "      sudo systemctl daemon-reload && sudo systemctl restart ollama"
        fi
      fi
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
