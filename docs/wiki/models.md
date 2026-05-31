# Model Management

## Viewing Status

```
/model
```

Shows: current model, provider, transport mode, context usage, all agent assignments, fallback chain, hailMary config.

## Discovering Models

```
/model list              → list all providers with model counts
/model list ollama       → list models available on ollama
/model list openrouter   → list models available on openrouter
```

Works on all platforms (text output).

## Switching Models

### Interactive (Telegram)

```
/model change
```

3-step picker:
1. Pick agent slot (professor, dreamy, browsie, coding)
2. Pick provider (shows model count, current marked ✅)
3. Pick model

### Quick switch (all platforms)

```
/model quick kimi-k2.5:cloud
```

Switches professor to the specified model on the current provider.

## Undo / Reset

| Command | Effect |
|---------|--------|
| `/model restore` | Swap transport.json ↔ transport.json.old (undo last change) |
| `/model default` | Copy transport.default.json → transport.json (factory reset) |
| `/model health reset` | Clear all model health penalties |

## Emergency Mode

```
/model emergency
```

Activates the paid `hailMary` model (configured in transport.json). Never auto-triggered — manual operator decision only. Clears on `/model restore`, `/model default`, or `/reset`.

## Fallback Behavior

When a model fails, the bridge automatically tries the next fallback:

```
professor (primary)
  → fallback 1 (e.g. ollama/kimi-k2.5)
  → fallback 2 (e.g. openrouter/gemini-2.5-flash)
  → fallback N ...
  → all exhausted → error
```

The health system tracks errors per model:
- **Rate limit (429)** — model skipped, respects Retry-After header
- **Auth error (401/403)** — model permanently skipped until manual reset
- **Transient (500, timeout)** — progressive backoff, auto-recovers over time

Use `/model health reset` to clear all penalties and make all models available again.

## Adding Models via Config Files

Two files control model availability:

### `~/.abtars/config/models.json` — Model catalog

Defines all available models and their properties:

```json
{
  "models": {
    "ollama": [
      { "id": "kimi-k2.5:cloud", "contextWindow": 131072 },
      { "id": "qwen3:32b", "contextWindow": 32768 }
    ],
    "openrouter": [
      { "id": "deepseek/deepseek-v4-flash", "contextWindow": 65536 },
      { "id": "google/gemini-2.5-flash", "contextWindow": 1048576 }
    ]
  }
}
```

Add a model here to make it available in `/model list` and the interactive picker.

### `~/.abtars/config/transport.json` — Active assignments

Defines which model each agent slot uses:

```json
{
  "agents": {
    "professor": {
      "provider": "ollama",
      "model": "kimi-k2.5:cloud",
      "fallbacks": ["openrouter/deepseek/deepseek-v4-flash"]
    },
    "dreamy": {
      "provider": "openrouter",
      "model": "deepseek/deepseek-v4-flash"
    }
  },
  "providers": {
    "ollama": { "baseUrl": "http://localhost:11434" },
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }
  }
}
```

### Adding a new provider

1. Add the provider to `transport.json` → `providers`:
   ```json
   "anthropic": { "baseUrl": "https://api.anthropic.com/v1", "apiKeyEnv": "ANTHROPIC_API_KEY" }
   ```
2. Drop the API key: `echo "sk-ant-..." > ~/.abtars/secret/ANTHROPIC_API_KEY`
3. Add models to `models.json`:
   ```json
   "anthropic": [{ "id": "claude-sonnet-4.6", "contextWindow": 200000 }]
   ```
4. Restart: `/restart` or `abtars restart`

### Adding a new model to an existing provider

1. Add to `models.json` under the provider
2. Switch via `/model quick <model-id>` or `/model change`

No restart needed for switching — only for adding new providers (needs API key loaded).

### Two methods compared

| Method | When to use |
|--------|-------------|
| `/model change` or `/model quick` | Switch between already-configured models (instant, no restart) |
| Edit `transport.json` + `models.json` | Add new providers, new models, change fallback chains, modify context windows |

