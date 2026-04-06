# OpenRouter Free Tier Scout

Find the best free-tier models on OpenRouter for the agent's tasks.

## When to use
User asks about free models, best deals, model recommendations, or you need to evaluate if a better free model is available.

## How to check

### 1. List free models
```bash
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $API_KEY" | python3 -c "
import json,sys
models = json.load(sys.stdin)['data']
free = [m for m in models if ':free' in m['id']]
free.sort(key=lambda m: m.get('context_length',0), reverse=True)
for m in free:
    print(f\"{m['id']} | ctx:{m.get('context_length',0)} | {m.get('description','')[:60]}\")
"
```
The API key is in `~/.agentbridge/transports/openrouter.env` (field: `API_KEY`).

### 2. Check quality rankings
Browse https://artificialanalysis.ai/leaderboards/models using `agentbridge-browser`:
```bash
agentbridge-browser --action navigate --url "https://artificialanalysis.ai/leaderboards/models"
agentbridge-browser --action extract_text --max-chars 5000
```
Look for the Intelligence Index score for each free model.

### 3. Evaluate
Score each free model by:
- **Intelligence Index** (from leaderboard, higher = better)
- **Context window** (bigger = fewer compactions)
- **Throughput** (tokens/sec from leaderboard)

### 4. Recommend
Suggest top 3 models for:
- **Main conversation** — highest intelligence + largest context
- **Coding** — code-specialized models preferred
- **Browse/sleep** — reliable tool calling, proven stability

## Current best picks (2026-04-06)
| Model | Intelligence | Context | Use |
|-------|-------------|---------|-----|
| `qwen/qwen3.6-plus:free` | ~45 | 1M | Main conversation |
| `minimax/minimax-m2.5:free` | 42 | 196K | Browse/sleep |
| `qwen/qwen3-coder:free` | n/a | 262K | Coding |

Update this table when you find better options.
