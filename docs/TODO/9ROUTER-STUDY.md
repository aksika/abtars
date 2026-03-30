# 9Router Study

**Repo:** https://github.com/decolua/9router
**License:** MIT
**Version:** 0.3.66 (npm: `9router`)
**Cloned to:** `~/workspace/9router`

## What it is

A Next.js app + MITM proxy that runs locally on `localhost:20128`. It intercepts AI CLI tool traffic and routes it through multiple providers with smart fallback.

## Architecture

```
CLI Tool (Claude Code, Gemini CLI, OpenClaw, Cursor...)
    │
    │ MITM proxy (intercepts HTTPS traffic via local cert)
    ↓
9Router (localhost:20128)
    │
    ├── Tier 1: Subscription (Claude Code, Codex, Gemini CLI, Antigravity)
    │   ↓ quota exhausted
    ├── Tier 2: Cheap (GLM $0.6/1M, MiniMax $0.2/1M)
    │   ↓ budget limit
    └── Tier 3: Free (iFlow, Qwen, Kiro — unlimited)
```

## How it intercepts traffic

Uses a **MITM proxy** — installs a local root CA certificate, intercepts HTTPS traffic to specific domains:

| Domain | Tool |
|--------|------|
| `q.us-east-1.amazonaws.com` | Kiro |
| `daily-cloudcode-pa.googleapis.com` | Antigravity (Gemini) |
| `api.individual.githubcopilot.com` | Copilot |
| `api2.cursor.sh` | Cursor |

This means it works by **intercepting the CLI tool's own API calls** — not by replacing the CLI binary. The CLI tool thinks it's talking to the real API.

## Free tiers

| Provider | How | Models |
|----------|-----|--------|
| Kiro/AWS | Auto-imports refresh token from `~/.aws/sso/cache` | Claude Sonnet 4.5, Haiku 4.5 |
| Antigravity | OAuth via Google | Gemini 2.5 Pro, Flash |
| iFlow | Cookie auth | Kimi K2, Qwen3 Coder, GLM-4.7, DeepSeek R1 |
| Qwen direct | API key | Qwen3 Coder Plus/Flash |

## Relevance to AgentBridge (#48)

### Option A: Use 9Router as a proxy for Kiro CLI (current setup)
- Run 9Router alongside the bridge
- Kiro CLI's API calls get intercepted and routed to free providers
- **No code changes to AgentBridge** — 9Router is transparent
- Risk: MITM cert install required, may break on updates

### Option B: Use 9Router's OpenAI-compatible endpoint directly
- 9Router exposes `http://localhost:20128/v1` (OpenAI-compatible)
- AgentBridge could call this endpoint for LLM calls (not via CLI)
- But AgentBridge uses CLI tools (kiro-cli, gemini), not direct API calls
- Not directly applicable to current architecture

### Option C: Use Gemini CLI + 9Router (best fit for #48)
- Install Gemini CLI, configure it to use 9Router's intercepted Gemini endpoint
- Set `AGENT_CLI=gemini` in AgentBridge
- Gemini CLI routes through 9Router → free Gemini 2.5 Pro
- **180K completions/month free** via Antigravity/Google auth

## Key findings

1. **Not a simple proxy** — requires MITM cert install (needs sudo/admin)
2. **Works with OpenClaw** — explicitly listed as supported tool
3. **Kiro token auto-import** — reads from `~/.aws/sso/cache` automatically
4. **No API key needed for free tiers** — uses OAuth/cookie auth
5. **Next.js app** — runs as a web server with dashboard UI

## Integration path for AgentBridge

Simplest path:
1. Install 9Router: `npm install -g 9router && 9router`
2. Connect Antigravity (Gemini) via OAuth in dashboard
3. Install Gemini CLI: `npm install -g @google/gemini-cli`
4. Configure Gemini CLI to use 9Router (via MITM — automatic)
5. Set `AGENT_CLI=gemini` in AgentBridge `.env` (after #48 is implemented)

Result: Free Gemini 2.5 Pro as the main agent, 180K completions/month.

## Risks

- MITM proxy requires root CA cert install — security consideration
- Free tiers can be revoked by providers
- Kiro free tier (Claude Sonnet 4.5) is via AWS Builder ID — not guaranteed
- 9Router is a third-party tool — updates may break compatibility
