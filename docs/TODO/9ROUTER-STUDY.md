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

### Best path: Gemini CLI free tier directly (no 9Router needed)

Gemini CLI has a built-in free tier — 180K completions/month via Google account OAuth. No MITM, no cert install, no third-party proxy:

```bash
npm install -g @google/gemini-cli
gemini auth   # OAuth with Google account — done
```

Then `gemini --experimental-acp` works with the free tier. AgentBridge sets `AGENT_CLI=gemini` and gets free Gemini 2.5 Pro legitimately.

**9Router is not needed for Gemini CLI.** Its value is for tools that don't have a free tier (Claude Code, Cursor) — it routes their traffic through free providers via MITM.

### When 9Router IS useful

- Running Claude Code or Cursor and want to route to free providers
- Want fallback across multiple providers (subscription → cheap → free)
- Multi-account round-robin to maximize free quotas

### Summary

| Approach | Free tier | Requires |
|----------|-----------|---------|
| Gemini CLI direct | ✅ 180K/month | Google account OAuth |
| 9Router + Gemini CLI | ✅ same | + MITM cert install |
| 9Router + Claude Code | ✅ via Kiro/AWS | + MITM cert + AWS Builder ID |

## Key findings

1. **Gemini CLI free tier is direct** — no 9Router needed for AgentBridge use case
2. **9Router uses MITM** — requires root CA cert install (needs sudo/admin)
3. **Works with OpenClaw** — explicitly listed as supported tool
4. **Kiro token auto-import** — reads from `~/.aws/sso/cache` automatically
5. **Next.js app** — runs as a web server with dashboard UI

## Risks (if using 9Router)

- MITM proxy requires root CA cert install — security consideration
- Free tiers can be revoked by providers
- Kiro free tier (Claude Sonnet 4.5) is via AWS Builder ID — not guaranteed
- 9Router is a third-party tool — updates may break compatibility
