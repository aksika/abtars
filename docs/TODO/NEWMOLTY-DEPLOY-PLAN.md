# NewMolty Deployment Plan — Mac (akos@molty)

## Context

Deploy AgentBridge as the new Molty agent on the Mac, replacing the existing OpenClaw-based Molty.
The existing `@AksMoltyBot` Telegram bot will be reused — just stop OpenClaw's bridge and start AgentBridge.

**Source:** `~/workspace/agentbridge` (this repo)
**Target machine:** `akos@molty` (Mac Mini)
**Telegram bot:** `@AksMoltyBot` (token already exists in OpenClaw's .env)

---

## Prerequisites (verify on Mac before starting)

```bash
# Node.js 22+
node --version   # must be ≥ 22

# nvm (recommended)
nvm --version

# kiro-cli
kiro-cli --version

# tmux
tmux -V

# git
git --version
```

If kiro-cli is missing: install from https://kiro.dev

---

## Step 1: Stop existing Molty (OpenClaw)

```bash
# On Mac — stop OpenClaw bridge
cd ~/workspace/openclaw
./scripts/stop.sh   # or however OpenClaw is stopped

# Verify no OpenClaw process running
ps aux | grep openclaw | grep -v grep
```

---

## Step 2: Clone AgentBridge

```bash
cd ~/workspace
git clone https://github.com/aksika/agentbridge.git agentbridge
cd agentbridge
npm install
```

---

## Step 3: Build

```bash
npm run build
```

---

## Step 4: Create .env

```bash
mkdir -p ~/.agentbridge
cat > ~/.agentbridge/.env << 'EOF'
# ── Telegram ─────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=<copy from OpenClaw .env — same @AksMoltyBot token>
ALLOWED_USER_IDS=<aksika's Telegram user ID>

# ── Agent CLI ────────────────────────────────────────────────
AGENT_CLI=kiro
AGENT_TRANSPORT=acp
WORKING_DIR=/Users/akos/workspace
TRUST_MODE=true

AGENT_MODEL=claude-sonnet-4.6
AGENT_BROWSE_MODEL=claude-sonnet-4.6
AGENT_SLEEP_MODEL=claude-opus-4.6
AGENT_CODING_MODEL=claude-opus-4.6

# ── Logging ──────────────────────────────────────────────────
LOG_LEVEL=low

# ── STT (optional — Groq key for voice notes) ────────────────
# GROQ_API_KEY=<copy from OpenClaw .env if present>

# ── Web Dashboard (optional) ─────────────────────────────────
# WEB_AUTH_TOKEN=<openssl rand -hex 32>
# WEB_PORT=3000

# ── Embeddings (optional — requires ollama) ──────────────────
# EMBEDDING_ENABLED=true
EOF
```

**Important:** Copy `TELEGRAM_BOT_TOKEN` from OpenClaw's `.env` — it's the `@AksMoltyBot` token.

---

## Step 5: Deploy

```bash
cd ~/workspace/agentbridge
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

This copies the launcher, skills, steering, and CLI wrappers to `~/.agentbridge/`.

---

## Step 6: Start

```bash
~/.agentbridge/agentbridge.sh --telegram
```

Or with web dashboard:
```bash
~/.agentbridge/agentbridge.sh --telegram --web
```

---

## Step 7: Verify

1. Send `/status` to `@AksMoltyBot` on Telegram
2. Expected response: transport status + memory stats
3. Send a test message — should get a response from KiroProfessor

---

## Step 8: Configure persona (optional)

The Mac instance will use the same KiroProfessor persona. If you want a distinct Molty identity:

```bash
# Edit the deployed steering files
nano ~/.agentbridge/.kiro/steering/SOUL.md
```

Or create a `MOLTY.md` steering file with Molty-specific instructions.

---

## Differences from WSL instance

| | WSL (main) | Mac (Molty) |
|--|--|--|
| Bot | @AgenticAksBot | @AksMoltyBot |
| Kiro tier | Enterprise | Free |
| Memory DB | `~/.agentbridge/memory/memory.db` | Separate, independent |
| Working dir | `/home/qakosal/workspace` | `/Users/akos/workspace` |
| Embeddings | Enabled (ollama) | Optional |

---

## Rollback

If something goes wrong, restart OpenClaw:
```bash
cd ~/workspace/openclaw
./scripts/start.sh
```

The `@AksMoltyBot` token works with either bridge — just stop one before starting the other.

---

## Notes for the deploying agent

- The `feat/multi-cli` branch has the latest code (Phase 1 of #48). Use `main` for stable.
- `WORKING_DIR` should point to a real directory on the Mac — the agent will operate there.
- If kiro-cli free tier has different model names, update `AGENT_MODEL` accordingly.
- The `~/.agentbridge/` directory is fully independent — no shared state with WSL.
- Run `~/.agentbridge/scripts/doctor.sh` after startup to verify health.
