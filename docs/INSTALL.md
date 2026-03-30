# AgentBridge — Dependency Installation Guide

## Core Prerequisites

| Dependency | Version | Required | Install |
|-----------|---------|----------|---------|
| Node.js | 22+ | Yes | `nvm install 22` |
| tmux | any | Yes | `apt install tmux` |
| Kiro CLI | latest | Yes | [kiro.dev](https://kiro.dev) |
| Telegram Bot | — | Yes | [@BotFather](https://t.me/BotFather) |

## Optional Dependencies

### Ollama (Embedding Search — Se sidecar)

Provides semantic search via vector embeddings. Without it, recall uses FTS5 text search only.

**Automated setup:**
```bash
chmod +x scripts/setup-embeddings.sh
./scripts/setup-embeddings.sh
```

This installs ollama, pulls `nomic-embed-text` (274MB), enables `EMBEDDING_ENABLED=true` in `.env`, and batch-embeds existing memories.

**Manual setup:**
```bash
# 1. Install ollama
curl -fsSL https://ollama.com/install.sh | sh

# 2. Pull the embedding model
ollama pull nomic-embed-text

# 3. Verify
ollama list  # should show nomic-embed-text
curl -s http://localhost:11434/api/tags | grep nomic  # API check

# 4. Enable in .env
echo 'EMBEDDING_ENABLED=true' >> ~/.agentbridge/.env

# 5. Batch-embed existing memories
npm run build
EMBEDDING_ENABLED=true node dist/cli/agentbridge-embed.js
```

**Verify:** After bridge restart, look for in the log:
```
[memory-manager] Embedding enabled: nomic-embed-text via ollama (Se sidecar ready)
```

### mcporter (MCP Server Runtime)

Connects to Model Context Protocol servers for extended tool capabilities (e.g. PowerPoint generation via `pptx` MCP server).

**Install from source:**
```bash
cd ~/workspace
git clone <mcporter-repo-url> mcporter
cd mcporter
pnpm install
pnpm build

# Create wrapper script
mkdir -p ~/.agentbridge
cat > ~/.agentbridge/mcporter << 'EOF'
#!/usr/bin/env bash
exec node "$HOME/workspace/mcporter/dist/cli.js" "$@"
EOF
chmod +x ~/.agentbridge/mcporter

# Symlink to PATH
ln -sf ~/.agentbridge/mcporter ~/.local/bin/mcporter

# Verify
mcporter --version
```

**Start the daemon:**
```bash
mcporter daemon start
mcporter daemon status  # should show "running"
```

The bridge manages the mcporter daemon lifecycle when `MCPORTER_DAEMON=true` is set in `.env`.

### Google Workspace CLI (Gmail access)

For email reading/sending via Gmail API.

```bash
# Install
npm install -g @googleworkspace/cli
gws --version

# Authenticate (one-time)
# 1. Google Cloud Console → create project → enable Gmail API
# 2. OAuth consent screen → External → add your email as test user
# 3. Credentials → Create OAuth client ID → Desktop app
# 4. Download client_secret.json

mkdir -p ~/.config/gws
cp client_secret_XXX.json ~/.config/gws/client_secret.json
chmod 600 ~/.config/gws/client_secret.json
gws auth login  # opens browser for consent

# Verify
gws auth status
gws gmail users messages list --params '{"userId": "me", "q": "is:unread", "maxResults": 3}'
```

### NotebookLM CLI (Knowledge Base)

For Layer 6 knowledge base operations.

```bash
# Install via pipx
pipx install notebooklm-mcp-cli

# Verify
nlm --version
```

## Post-Install Checklist

After installing dependencies, run:

```bash
# Build the project
npm run build

# Deploy CLIs, skills, prompts
./scripts/deploy.sh

# Health check
./scripts/doctor.sh

# Start the bridge
~/.agentbridge/agentbridge.sh --telegram
```

## Environment Variables

All configuration in `~/.agentbridge/.env`. Key dependency-related vars:

```env
# Embeddings (ollama)
EMBEDDING_ENABLED=true
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_URL=http://localhost:11434

# mcporter
MCPORTER_DAEMON=true

# Sleep subagent model
MEMORY_SUBAGENT_MODEL=claude-sonnet-4.6
```
