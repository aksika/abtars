# Transport Configuration

Transport config lives at `~/.abtars/config/transport.json`. It defines which AI providers are available and which models each agent uses.

## Terminology

| Term | Definition |
|------|-----------|
| **Provider** | A named service entry — identifies how to reach a model | 
| **Route** | Normal execution route: `pi-ai` for API providers or `acp` for CLI providers |
| **Transport** | Provider communication method: `acp` (CLI via JSON-RPC) or `api` (HTTP endpoint) |

## Example

```json
{
  "schemaVersion": 3,
  "activeRoute": "pi-ai",
  "routes": {
    "pi-ai": {
      "agents": {
        "main": { "model": "deepseek/deepseek-v4-flash", "provider": "openrouter" },
        "dreamy": { "model": "deepseek/deepseek-v4-flash", "provider": "openrouter" },
        "browsie": { "model": "deepseek/deepseek-v4-flash", "provider": "openrouter" },
        "cody": { "model": "deepseek/deepseek-v4-flash", "provider": "openrouter" }
      },
      "fallbacks": [
        { "model": "deepseek/deepseek-v4-flash", "provider": "openrouter" }
      ]
    },
    "acp": {
      "agents": {
        "main": { "model": "claude-sonnet-4.6", "provider": "kiro" }
      },
      "fallbacks": []
    }
  },
  "providers": {
    "kiro": { "transport": "acp", "cli": "kiro-cli" },
    "gemini": { "transport": "acp", "cli": "gemini" },
    "ollama": { "transport": "api", "endpoint": "http://localhost:11434/v1" },
    "openrouter": { "transport": "api", "endpoint": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }
  },
  "maxTurns": 50,
  "hailMary": {
    "route": "acp",
    "model": "claude-sonnet-4.6",
    "provider": "kiro"
  },
  "healthPolicy": {
    "skipThreshold": 0.7,
    "leakPerMinute": 0.03,
    "rateLimitFill": 0.5,
    "transientProgressive": [0.1, 0.2, 0.4, 0.8],
    "transientCooldownAfter": 3,
    "transientMaxCooldownSec": 300
  }
}
```

## Route-local assignments

| Agent | Role |
|-------|------|
| `main` | Main conversation agent |
| `dreamy` | Sleep cycle / dream processing |
| `browsie` | Web browsing tasks |
| `cody` | Coding mode |

Each route has its own `agents` and `fallbacks` assignments. Switching with `/route pi-ai` or `/route acp` changes only `activeRoute`; the other route's selections are preserved.

## Fallback Chain

Each active route supports an ordered `fallbacks` array. When the primary model fails:

1. Try fallback 1, 2, 3, ... N (in order)
2. Skip models with full health buckets (rate-limited, auth failed)
3. If all exhausted → error. The global ACP-only `hailMary` descriptor is reserved for the #1468 emergency path.

Fallbacks must use providers compatible with their route. ACP assignments use one ACP provider; `pi-ai` assignments use API providers.

Add fallbacks to the selected route's array in `transport.json`.

## Health Policy

The bridge tracks model health using a leaky-bucket algorithm. Errors fill the bucket, time drains it. Full bucket = model skipped.

All values in `healthPolicy` are optional (defaults shown above):

| Field | Default | Description |
|-------|---------|-------------|
| `skipThreshold` | 0.7 | Bucket level (0-1) above which model is skipped |
| `leakPerMinute` | 0.03 | How fast a penalized model recovers |
| `rateLimitFill` | 0.5 | Penalty per rate-limit hit (429) |
| `weakFill` | 0.05 | Mild penalty for weak responses |
| `transientProgressive` | [0.1, 0.2, 0.4, 0.8] | Escalating penalty per consecutive error |
| `transientCooldownAfter` | 3 | Errors before hard cooldown |
| `transientMaxCooldownSec` | 300 | Maximum cooldown duration |

## Adding a Provider

Add an entry to `providers` and restart:

```json
"my-provider": {
  "transport": "api",
  "endpoint": "https://api.example.com/v1",
  "apiKeyEnv": "MY_PROVIDER_KEY"
}
```

Then assign an agent to it or use `/model change` to switch interactively.

## Model Switching

| Action | What happens |
|--------|-------------|
| `/model restore` | Undo last switch (swaps transport.json with .old backup) |
| `/model default` | Factory reset from transport.default.json |
| Model change, same transport | New session (conversation reset) |
| Provider change (different transport) | Full reset (transport rebuilt) |
