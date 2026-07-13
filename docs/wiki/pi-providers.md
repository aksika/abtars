# pi-ai Providers

Pi's provider engine (pi-ai) can serve as an optional L1 motor inside `DirectApiTransport`. When enabled, it replaces the hand-rolled provider adapters with Pi's maintained catalog of ~36 providers, including prompt caching, OAuth auth, and up-to-date model metadata.

## Enabling pi-ai

Set `useProviderLib: true` on a provider entry in `~/.abtars/config/transport.json`:

```json
{
  "providers": {
    "openrouter": {
      "transport": "api",
      "endpoint": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "useProviderLib": true
    },
    "anthropic": {
      "transport": "api",
      "endpoint": "https://api.anthropic.com/v1",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "useProviderLib": true
    }
  }
}
```

The flag is **per-provider**, not global. You can mix L1 (Pi-powered) and L0 (hand-rolled) providers in the same config.

## What changes

| Feature | L0 (hand-rolled) | L1 (pi-ai) |
|---------|------------------|-------------|
| Supported providers | ~3 (Anthropic, OpenAI, OpenRouter) | ~36 |
| Prompt caching | No | Yes (reported in `/usage`) |
| Model catalog | `models.json` | Pi's catalog (live at boot) |
| Auth | API keys only | API key + OAuth (Anthropic/Copilot/Codex) |
| Token accounting | Hand-rolled | Pi maintained |
| Fallback provider? | No — single provider | No — Pi classifies, abTARS decides |

## Prompt Caching

Pi-ai surfaces `cacheRead` and `cacheWrite` fields. These are visible in `/usage` when using an L1 provider. The L0 reptile floor does not report cache (the hand-rolled adapters don't see provider cache fields).

## Model Picker

When pi-ai is on, the `/model` Telegram command uses Pi's catalog to populate the picker with cost data. The `/usage` command shows cache savings where applicable.

## Fallback and Emergency

- L2 fallback/rotation stays abTARS's own — Pi classifies errors, abTARS decides which model to retry with
- `/emergency` (hailMary) always runs on the L0 reptile floor — never through pi-ai
- ACP transport is untouched (Pi has no ACP path)

## What stays the same

- `/model change` works identically
- Fallback chains in `transport.json` work identically
- All `/commands` work identically
- Everything still works with pi absent — the L0 floor is always available

## Requirements

- Node.js >= 22.19.0
- `@earendil-works/pi-ai` installed (`abtars deps install`)
