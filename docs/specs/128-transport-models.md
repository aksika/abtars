# #128 Transport/Model Consistency — transport.json + models.json

**Date:** 2026-04-12
**Status:** Planned
**Priority:** CRITICAL
**Merges:** #119

## Problem

Transport and model config scattered across env vars, profile .env files, per-agent env vars, and bridge.lock. Subagents get confused. Config is duplicated. Model properties repeated per profile.

## Solution

Two structured JSON files in `~/.agentbridge/config/`.

### models.json — Model catalog (hot-reloaded)

```json5
{
  "claude-opus-5":        { "contextWindow": 1000000, "maxOutput": 32768, "rank": 1, "cost": { "input": 15.0, "output": 75.0 },  "transports": ["kiro-paid"] },
  "claude-sonnet-4.6":    { "contextWindow": 1000000, "maxOutput": 16384, "rank": 2, "cost": { "input": 3.0,  "output": 15.0 },  "transports": ["kiro-free", "kiro-paid"] },
  "gemini-2.5-pro":       { "contextWindow": 1000000, "maxOutput": 65536, "rank": 2, "cost": { "input": 1.25, "output": 10.0 },  "transports": ["gemini-paid"] },
  "gemini-2.5-flash":     { "contextWindow": 1000000, "maxOutput": 65536, "rank": 3, "cost": { "input": 0.15, "output": 0.60 },  "transports": ["gemini-free", "gemini-paid"] },
  "kimi-k2.5:cloud":      { "contextWindow": 262144,  "maxOutput": 16384, "rank": 2, "cost": { "input": 0.0,  "output": 0.0 },   "transports": ["ollama", "openrouter"] },
  "minimax-m2.5:cloud":   { "contextWindow": 128000,  "maxOutput": 8192,  "rank": 3, "cost": { "input": 0.0,  "output": 0.0 },   "transports": ["ollama", "openrouter"] },
  "qwen3.5:cloud":        { "contextWindow": 131072,  "maxOutput": 8192,  "rank": 3, "cost": { "input": 0.0,  "output": 0.0 },   "transports": ["ollama", "openrouter"] }
}
```

- Hot-reloaded on each use (agent can add models via model scout at runtime)
- `transports[]` informational — validated at startup, warning log if mismatch
- Cost per 1M tokens. Rank 1=frontier, 5=basic.

### transport.json — Routing (read at startup)

```json5
{
  "agents": {
    "professor": { "model": "claude-sonnet-4.6",  "provider": "kiro-free", "fallbacks": [{ "model": "kimi-k2.5:cloud", "provider": "ollama" }] },
    "dreamy":    { "model": "minimax-m2.5:cloud", "provider": "ollama" },
    "browsie":   { "model": "minimax-m2.5:cloud", "provider": "ollama" },
    "coding":    { "model": "qwen3.5:cloud",      "provider": "ollama" }
  },
  "providers": {
    "kiro-free":   { "transport": "acp", "cli": "kiro-cli" },
    "kiro-paid":   { "transport": "acp", "cli": "kiro-cli" },
    "gemini-free": { "transport": "acp", "cli": "gemini" },
    "gemini-paid": { "transport": "acp", "cli": "gemini" },
    "ollama":      { "transport": "api", "endpoint": "http://localhost:11434/v1" },
    "openrouter":  { "transport": "api", "endpoint": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }
  },
  "transportDefaults": {
    "tmux": { "session": "kiro-bridge", "captureDelaySec": 3, "maxWaitSec": 300 },
    "acp":  { "permissionTimeoutMs": 60000 }
  },
  "maxTurns": 50
}
```

- Each agent declares its own model + provider
- `fallbacks` only on professor — format: `{ "model": "...", "provider": "..." }` object. Leaky bucket reads from this.
- Subagents have no fallbacks — they always fall back to professor's configured model+provider
- `cron` not listed — inherits professor
- `apiKeyEnv` = env var name, resolved at runtime from .env

### .env — Secrets + emergency fallback

Stays at `~/.agentbridge/.env` (not moved to config/).

```env
# Config paths (relative to ~/.agentbridge/)
TRANSPORT_CONFIG=config/transport.json
MODELS_CONFIG=config/models.json

# Emergency fallback (used when JSON parse fails)
DEFAULT_PROVIDER=openrouter
DEFAULT_TRANSPORT=api
DEFAULT_MODEL=minimax-m2.5:cloud

# Secrets (never in JSON)
API_KEY=
OPENROUTER_API_KEY=sk-or-...
GROQ_API_KEY=gsk_...
TELEGRAM_BOT_TOKEN=...
ALLOWED_USER_IDS=...
WEB_AUTH_TOKEN=...
```

### Directory structure

```
~/.agentbridge/
  .env                    ← stays here (secrets + fallback)
  .env.local              ← stays here
  .env.memory             ← moves to config/
  .env.skills             ← moves to config/
  config/                 chmod 700
    .env.memory
    .env.skills
    transport.json
    models.json
    auto-fix.json
  core/
  skills/core/ auto/ clawhub/
  agents/
  prompts/sleep/
  memory/
  logs/
  bin/
  dist/
  node_modules/
```

## Resolution flow

```
createSubagentTransport("dreamy"):
  1. transport.json → agents.dreamy = { model: "minimax-m2.5:cloud", provider: "ollama" }
  2. transport.json → providers.ollama = { transport: "api", endpoint: "http://localhost:11434/v1" }
  3. models.json["minimax-m2.5:cloud"] = { contextWindow: 128000, maxOutput: 8192 }
  4. → DirectApiTransport(endpoint, model, contextWindow, maxOutput)

createSubagentTransport("professor"):
  1. transport.json → agents.professor = { model: "claude-sonnet-4.6", provider: "kiro-free" }
  2. transport.json → providers.kiro-free = { transport: "acp", cli: "kiro-cli" }
  3. models.json["claude-sonnet-4.6"] = { contextWindow: 1000000, maxOutput: 16384 }
  4. → AcpTransport(cli, model, contextWindow)

Cron task:
  → Check TransportManager.currentModel (in-memory runtime state)
  → If set (professor fell back): use that model+provider
  → If not set: use professor's configured model+provider from transport.json

CONTEXT_WINDOW_SIZE:
  → Resolved from professor's model contextWindow in models.json
```

## Fallback

```
Professor model fails (429/timeout):
  1. TransportManager reads professor.fallbacks from transport.json
  2. Tries { "model": "kimi-k2.5:cloud", "provider": "ollama" } → resolve provider, create transport
  3. Sets TransportManager.currentModel in-memory
  4. Cron tasks spawned after this use the runtime model (in-memory, same process)

Subagent model fails:
  → Falls back to professor's CONFIGURED model+provider (from transport.json)
  → No model shopping, no provider switching

JSON broken (parse error):
  1. Log "⚠️ Config error in transport.json: <error>"
  2. Use .env: DEFAULT_PROVIDER + DEFAULT_TRANSPORT + DEFAULT_MODEL
  3. Send TG: "⚠️ Back online. Config error, using default: minimax-m2.5:cloud via openrouter"
  4. Doctor.sh --fix can repair (rewrite from example)
  5. Self-healer whitelist: "transport.json parse error" → auto-fix rule
```

## bridge.lock (unchanged from today)

```json
{ "pid": 12345, "startedAt": 1775921677402, "lastHeartbeat": 1775940861683, "lastPromptAt": 1775952594192 }
```

No transport section. Step 0's temporary transport field removed in cleanup. Runtime fallback state is in-memory on TransportManager (same process as cron). Sleep has its own model+provider from transport.json — doesn't need professor's runtime state.

## Validation

- JSON parse failure → fall back to .env defaults, bridge starts, TG warning
- Model in transport.json missing from models.json → warning log, use model name as-is (graceful)
- Model's `transports` doesn't include assigned provider → warning log at startup
- No crash on config errors — doctor.sh / self-healer can fix

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | TypeScript types + `loadModels()` + `loadTransport()` with validation + .env fallback | 30 min |
| 3 | Wire bridge startup — replace profile .env loading with JSON loading | 45 min |
| 4 | Wire `createSubagentTransport()` — read from JSON, resolve model from models.json, cron reads TransportManager.currentModel | 30 min |
| 5 | Wire professor fallbacks — TransportManager reads `fallbacks` from transport.json, sets currentModel in-memory on fallback | 20 min |
| 6 | models.json hot-reload — re-read on each use | 10 min |
| 7 | Deploy — generate JSON from existing profiles, migrate config dir, ship examples | 30 min |
| 8 | Doctor.sh — validate JSON, --fix rewrites from example. Self-healer whitelist entry. | 15 min |
| 9 | Cleanup — delete old profiles, env vars, bridge-lock transport field, update docs | 15 min |
| **Total** | | **~3.5 hr** |

## What gets deleted

- `persona/core/transports/*.env` (4 profile files)
- `AGENT_TRANSPORT_PROFILE`, `AGENT_TRANSPORT`, `AGENT_CLI`
- `AGENT_*_MODEL`, `AGENT_*_CTX_WINDOW`
- `API_ENDPOINT`, `API_MAX_CONTEXT`, `API_MAX_OUTPUT`, `API_MAX_TURNS`
- `FALLBACK_API_ENDPOINT`, `AGENT_AVAILABLE_MODELS`
- `CONTEXT_WINDOW_SIZE`, `BROWSING_AGENT`
- `AGENT_FALLBACK_MODEL_*` env vars
- `readBridgeLockTransport()` function
- `transport` field from bridge.lock write (step 0 temporary fix)
- Profile .env loading from config.ts

## What stays in .env

- `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS` — platform
- `API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY` — secrets
- `EMBEDDING_ENABLED`, `MEMORY_*` — memory (in config/.env.memory)
- `BED_TIME`, `WAKE_TIME`, `SLEEP_QUALITY` — sleep
- `WEB_AUTH_TOKEN`, `WEB_PORT` — dashboard
- `DEFAULT_PROVIDER`, `DEFAULT_TRANSPORT`, `DEFAULT_MODEL` — emergency fallback
- `TRANSPORT_CONFIG`, `MODELS_CONFIG` — paths to JSON files
