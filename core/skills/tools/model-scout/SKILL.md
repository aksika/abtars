# Model Scout

Find the best free cloud models and propose the top 3 candidates.

## When to use
User asks about model recommendations, best deals, or you need to evaluate if a better model is available.

## Config files

- **models.json** — `~/.abtars/config/models.json` (hot-reloaded)
- **transport.json** — `~/.abtars/config/transport.json` (lists providers, defaults, fallbackChain)

## transport.json provider fields (relevant to scouting)

Each provider in `transport.json` may have:
- **`defaults`** — `Record<agent, { model, fallbacks? }>` — preset models loaded on `/model change → provider`. Professor is required; missing subagents inherit professor's model.
- **`fallbackChain`** — `string[]` — ordered list of always-available models tried when the configured model fails. Used by subagent runtime (not professor).

When proposing new models, consider whether they should be added to a provider's `defaults` or `fallbackChain`.

## models.json schema

```json
{
  "model-id": {
    "contextWindow": 262144,
    "maxOutput": 16384,
    "rank": 2,
    "cost": { "input": 0.0, "output": 0.0 },
    "transports": ["ollama", "openrouter"],
    "description": "High IQ free model, top Intelligence Index score",
    "validatedAt": "2026-04-13"
  }
}
```

- **rank**: 1 = frontier, 2 = strong, 3 = good, 4 = basic, 5 = minimal
- **cost**: per million tokens in USD. `0.0` = free
- **transports**: provider names from transport.json that can serve this model
- **description**: why this model was added (scout writes this)
- **validatedAt**: date when last verified alive (auto-set by script)

## Scouting workflow

### 1. Scan available free models

```bash
# OpenRouter free tier
python3 ~/.abtars/scripts/scout-openrouter.py

# Ollama cloud models (no local, cloud only)
python3 ~/.abtars/scripts/scout-ollama.py
```

### 2. Research quality

Browse leaderboards to get Intelligence Index scores:
```bash
abtars-browser --action navigate --url "https://artificialanalysis.ai/leaderboards/models"
abtars-browser --action extract_text --max-chars 5000
```

Search for new cloud models on Ollama:
```bash
abtars-browser --action navigate --url "https://ollama.com/search?q=cloud"
abtars-browser --action extract_text --max-chars 5000
```

### 3. Propose top 3

After scanning and researching, propose exactly 3 candidates ranked by:

1. **Intelligence Index** (higher = better) → determines rank
2. **Context window** (bigger = fewer compactions)
3. **Tool calling** (required — model must support function calling)
4. **Throughput** (tokens/sec, matters for interactive use)

Format:
```
🏆 Top 3 free cloud models:

1. model-name (provider) — Intelligence: XX, Context: XXK
   Why: [one sentence reason]

2. model-name (provider) — Intelligence: XX, Context: XXK
   Why: [one sentence reason]

3. model-name (provider) — Intelligence: XX, Context: XXK
   Why: [one sentence reason]
```

### 4. Add approved models

After user approves, add with description explaining why:

```bash
python3 ~/.abtars/scripts/scout-add-model.py \
  "model-id" contextWindow maxOutput rank input_cost output_cost \
  "Why this model: Intelligence XX, free, large context" \
  ollama openrouter
```

The script automatically:
- Backs up models.json to `.old`
- Sets `validatedAt` to today's date
- Validates all entries after write
- Restores from backup if validation fails

### 5. Test

```
/model change → pick provider → verify defaults loaded
/model (check fallback chain displayed)
```

## Liveness test

Before proposing, verify the model actually responds:

```bash
# Ollama cloud
curl -s http://localhost:11434/v1/chat/completions -d '{
  "model": "model-name",
  "messages": [{"role":"user","content":"Say hi"}],
  "max_tokens": 5
}'

# OpenRouter
curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{"model":"model-id","messages":[{"role":"user","content":"Say hi"}],"max_tokens":5}'
```
