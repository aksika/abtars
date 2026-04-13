# Model Scout

Find the best models for each provider and add them to `models.json`.

## When to use
User asks about model recommendations, best deals, or you need to evaluate if a better model is available.

## Config files

- **models.json** — `~/.agentbridge/config/models.json` (hot-reloaded, you can add models at runtime)
- **transport.json** — `~/.agentbridge/config/transport.json` (read at startup, lists providers)

## models.json schema

Every model entry must have all fields. Missing `transports` = model won't appear in `/models change` picker.

```json
{
  "model-id": {
    "contextWindow": 262144,
    "maxOutput": 16384,
    "rank": 2,
    "cost": { "input": 0.0, "output": 0.0 },
    "transports": ["ollama", "openrouter"]
  }
}
```

- **rank**: 1 = frontier, 2 = strong, 3 = good, 4 = basic, 5 = minimal
- **cost**: per million tokens in USD. `0.0` = free
- **transports**: provider names from transport.json that can serve this model

## Scripts

All scout scripts are in `scripts/`. No inline python — avoids prompt injection scanner triggers.

### OpenRouter scouting
```bash
# List free models, compare against catalog
python3 scripts/scout-openrouter.py
```
Shows all free-tier models sorted by context window, marks which are already in models.json.

### Ollama scouting
```bash
# List installed + running models, compare against catalog
python3 scripts/scout-ollama.py
```
Shows installed models with size, running status, and catalog status.

### Add a model
```bash
# Backup → add → validate → restore if broken
python3 scripts/scout-add-model.py <model-id> [contextWindow] [maxOutput] [rank] [input_cost] [output_cost] [transports...]

# Examples:
python3 scripts/scout-add-model.py 'kimi-k2.5:cloud' 262144 16384 2 0.0 0.0 ollama openrouter
python3 scripts/scout-add-model.py 'qwen/qwen3-coder:free' 131072 8192 3 0.0 0.0 openrouter
```
Automatically backs up to `.old`, validates all entries after write, restores if validation fails.

## Research

### Browse for new Ollama models
```bash
# Tool-calling models (required for agent use)
agentbridge-browser --action navigate --url "https://ollama.com/search?c=tools"
agentbridge-browser --action extract_text --max-chars 5000

# Cloud models (no RAM cost)
agentbridge-browser --action navigate --url "https://ollama.com/search?q=cloud"
agentbridge-browser --action extract_text --max-chars 5000
```

### Check quality leaderboards
```bash
agentbridge-browser --action navigate --url "https://artificialanalysis.ai/leaderboards/models"
agentbridge-browser --action extract_text --max-chars 5000
```

### Liveness test before adding
```bash
# Ollama
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

### Local model sizing (Mac Mini M4, 16GB RAM)
Rule of thumb: parameter count × 0.6 = GB in Q4 quantization.
- Up to 12B: fits comfortably (~7GB)
- 12-20B: tight, may swap
- 20B+: cloud only

## Scoring criteria
- **Intelligence Index** (from leaderboard, higher = better) → determines rank
- **Context window** (bigger = fewer compactions)
- **Tool calling** (required — model must support function calling)
- **Throughput** (tokens/sec, matters for interactive use)
- **Cost** (free preferred, low cost acceptable)
- **RAM fit** (local models only)

## After scouting

1. Run `python3 scripts/scout-add-model.py` for each new model (handles backup + validation)
2. Test with `/models quick <model>` or `/models change`
