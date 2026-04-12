# #128 Transport/Model Consistency — transport.json + models.json

**Date:** 2026-04-12
**Status:** Step 0 done, planning
**Priority:** CRITICAL
**Merges:** #119

## Problem

Transport and model config scattered across 4 places:
- `.env` transport vars (`AGENT_TRANSPORT`, `API_ENDPOINT`, etc.)
- Transport profile `.env` files (`persona/core/transports/*.env`)
- Per-agent env vars (`AGENT_SLEEP_MODEL`, `AGENT_CODING_CTX_WINDOW`, etc.)
- `bridge.lock` transport section (runtime truth, added in step 0)

Subagents get confused. Config is duplicated. Model properties (context window) are repeated per profile.

## Solution

Two structured JSON files:

### models.json — Model catalog (define once, use everywhere)

```json5
// ~/.agentbridge/models.json
{
  "kimi-k2.5:cloud":      { "contextWindow": 262144, "maxOutput": 16384, "alias": "Kimi" },
  "minimax-m2.5:cloud":   { "contextWindow": 128000, "maxOutput": 8192,  "alias": "MiniMax" },
  "qwen3.5:cloud":        { "contextWindow": 131072, "maxOutput": 8192,  "alias": "Qwen" },
  "claude-sonnet-4.6":    { "contextWindow": 1000000, "maxOutput": 16384, "alias": "Sonnet" },
  "gemini-2.5-flash":     { "contextWindow": 1000000, "maxOutput": 65536, "alias": "Flash" }
}
```

- Context window, max output are model properties — defined once
- `alias` for display/logging
- Model scout skill (#90) can append new models here
- `AGENT_AVAILABLE_MODELS` becomes the keys of this file

### transport.json — Routing (how to reach models, which agent uses what)

```json5
// ~/.agentbridge/transport.json
{
  "active": "ollama",
  "maxTurns": 50,
  "profiles": {
    "kiro": {
      "transport": "acp",
      "cli": "kiro-cli",
      "agents": {
        "professor": "claude-sonnet-4.6",
        "dreamy":    "claude-sonnet-4.6",
        "browsie":   "claude-sonnet-4.6",
        "coding":    "claude-sonnet-4.6"
      }
    },
    "gemini": {
      "transport": "acp",
      "cli": "gemini",
      "agents": {
        "professor": "gemini-2.5-flash",
        "dreamy":    "gemini-2.5-flash",
        "browsie":   "gemini-2.5-flash",
        "coding":    "gemini-2.5-flash"
      }
    },
    "ollama": {
      "transport": "api",
      "endpoint": "http://localhost:11434/v1",
      "agents": {
        "professor": "kimi-k2.5:cloud",
        "dreamy":    "minimax-m2.5:cloud",
        "browsie":   "minimax-m2.5:cloud",
        "coding":    "qwen3.5:cloud"
      }
    },
    "openrouter": {
      "transport": "api",
      "endpoint": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "agents": {
        "professor": "kimi-k2.5:cloud",
        "dreamy":    "minimax-m2.5:cloud",
        "browsie":   "minimax-m2.5:cloud",
        "coding":    "qwen3.5:cloud"
      }
    }
  }
}
```

- `active` selects the profile
- Agent assignment is a string referencing models.json
- `apiKeyEnv` points to env var name (secrets stay in `.env`)
- `maxTurns` is global (not model-specific)
- `cron` role not listed — inherits professor's model

### Resolution flow

```
Agent "dreamy" needs a transport:
  1. Read transport.json → active profile = "ollama"
  2. Profile says: transport=api, endpoint=localhost:11434, dreamy="minimax-m2.5:cloud"
  3. Read models.json → minimax-m2.5:cloud has contextWindow=128000, maxOutput=8192
  4. Create DirectApiTransport(endpoint, model, contextWindow, maxOutput)
```

### bridge.lock (runtime only)

Still written at startup for PID/heartbeat/lastPromptAt. Transport section removed — transport.json is the source of truth. If smart fallback switches profile at runtime, it updates `transport.json` `active` field (or a `runtimeOverride` field cleared on restart).

## Implementation

### Step 0: bridge.lock records transport ✅
Temporary fix — keeps things working until transport.json ships.

### Step 1: Create models.json + transport.json schemas (30 min)
- TypeScript types for both files
- `loadModels()` reads `~/.agentbridge/models.json`
- `loadTransport()` reads `~/.agentbridge/transport.json`
- Both validate with clear error messages on parse failure
- Both fall back to env vars if file missing (migration)

### Step 2: Wire into bridge startup (45 min)
- `config.ts`: `loadTransport()` replaces profile `.env` loading
- `bridge-app.ts`: reads active profile, creates main transport
- Remove `AGENT_TRANSPORT_PROFILE` env var handling
- Remove transport profile `.env` loading from config.ts

### Step 3: Wire into subagents (30 min)
- `createSubagentTransport()`: reads role's model from active profile + context window from models.json
- Remove `AGENT_*_MODEL`, `AGENT_*_CTX_WINDOW` env var reads
- Remove `readBridgeLockTransport()` — transport.json is the source
- bridge.lock transport section removed

### Step 4: Deploy + migration (30 min)
- `deploy.sh`: generates `models.json` + `transport.json` from existing `.env` profiles on first deploy
- If files already exist, don't overwrite (user may have edited)
- Ship example files: `models.json.example`, `transport.json.example`

### Step 5: Cleanup (15 min)
- Delete `persona/core/transports/*.env`
- Remove transport env vars from `.env.example`
- Remove profile loading from `config.ts`
- Remove `bridge-lock-transport.ts` transport reading (keep PID/heartbeat reads)
- Update TOOLS.md, deploy docs

## What stays in .env
- `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS` — platform config
- `API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY` — secrets
- `EMBEDDING_ENABLED`, `MEMORY_*` — memory config
- `BED_TIME`, `WAKE_TIME`, `SLEEP_QUALITY` — sleep config
- `WEB_AUTH_TOKEN`, `WEB_PORT` — dashboard config

## What moves to transport.json
- `AGENT_TRANSPORT_PROFILE` → `active`
- `AGENT_TRANSPORT` → `profiles.*.transport`
- `AGENT_CLI` → `profiles.*.cli`
- `API_ENDPOINT` → `profiles.*.endpoint`
- `AGENT_MAIN_MODEL` → `profiles.*.agents.professor`
- `AGENT_SLEEP_MODEL` → `profiles.*.agents.dreamy`
- `AGENT_BROWSE_MODEL` → `profiles.*.agents.browsie`
- `AGENT_CODING_MODEL` → `profiles.*.agents.coding`
- `API_MAX_TURNS` → `maxTurns`

## What moves to models.json
- `AGENT_MAIN_CTX_WINDOW` → `models.*.contextWindow`
- `AGENT_SLEEP_CTX_WINDOW` → `models.*.contextWindow`
- `AGENT_BROWSE_CTX_WINDOW` → `models.*.contextWindow`
- `AGENT_CODING_CTX_WINDOW` → `models.*.contextWindow`
- `API_MAX_OUTPUT` → `models.*.maxOutput`
- `API_MAX_CONTEXT` → `models.*.contextWindow`
- `AGENT_AVAILABLE_MODELS` → keys of models.json

## Effort

| Step | What | Time |
|---|---|---|
| 1 | Schemas + loaders | 30 min |
| 2 | Wire bridge startup | 45 min |
| 3 | Wire subagents | 30 min |
| 4 | Deploy + migration | 30 min |
| 5 | Cleanup | 15 min |
| **Total** | | **~2.5 hr** |
