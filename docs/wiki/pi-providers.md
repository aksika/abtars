# pi-ai Providers

Pi's provider engine (pi-ai) is the L1 motor for API providers. When `activeRoute` is `"pi-ai"`, providers with `transport: "api"` run through Pi's maintained catalog (~36 providers), including prompt caching and up-to-date model metadata.

## Enabling pi-ai

The route is selected in `~/.abtars/config/transport.json`. Any provider with `transport: "api"` is served by the pi-ai engine on the `pi-ai` route:

```json
{
  "schemaVersion": 3,
  "activeRoute": "pi-ai",
  "providers": {
    "openrouter": {
      "transport": "api",
      "endpoint": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    "anthropic": {
      "transport": "api",
      "endpoint": "https://api.anthropic.com/v1",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "apiFormat": "anthropic"
    }
  }
}
```

The `apiKeyEnv` field references the key in `~/.abtars/secret/` by environment-variable name. Raw credential fields (`apiKey`, `token`, `secret`, ...) are rejected — credentials never live in `transport.json`.

The `acp` route runs agent CLIs (kiro-cli, gemini) and is independent of pi-ai.

## What pi-ai provides

| Feature | Hand-rolled (L0) | pi-ai (L1) |
|---------|------------------|------------|
| Supported providers | ~3 (Anthropic, OpenAI, OpenRouter) | ~36 |
| Prompt caching | No | Yes (reported in `/usage`) |
| Model catalog | `models.json` | Pi's catalog (live at boot) |
| Auth | API keys only | API key + OAuth (Anthropic/Copilot/Codex) |
| Token accounting | Hand-rolled | Pi maintained |
| Fallback provider? | No — single provider | No — Pi classifies, abTARS decides |

## Prompt Caching

Pi-ai surfaces `cacheRead` and `cacheWrite` fields. These are visible in `/usage` when using an L1 provider. The L0 reptile floor does not report cache (the hand-rolled adapters don't see provider cache fields).

## Model Picker

The `/model` Telegram command uses Pi's catalog to populate the picker with cost data. The `/usage` command shows cache savings where applicable.

## Fallback and Emergency

- Fallback/rotation stays abTARS's own — Pi classifies errors, abTARS decides which model to retry with
- `/emergency` (hailMary) is a dedicated ACP fast path — it never enters pi-ai or the normal message pipeline
- ACP transport is untouched (Pi has no ACP path)

## What stays the same

- `/model change` works identically
- Fallback chains in `transport.json` work identically
- All `/commands` work identically
- Everything still works with pi absent — the L0 floor is always available

## Requirements

- Node.js >= 22.19.0
- `@earendil-works/pi-ai` installed (`abtars deps install`)
