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
