# Model Scout

Find the best models for each transport provider.

## When to use
User asks about model recommendations, best deals, or you need to evaluate if a better model is available.

## OpenRouter (free tier)

### 1. List free models
```bash
KEY=$(grep API_KEY ~/.agentbridge/transports/openrouter.env | head -1 | cut -d= -f2)
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $KEY" | python3 -c "
import json,sys
models = json.load(sys.stdin)['data']
free = [m for m in models if ':free' in m['id']]
free.sort(key=lambda m: m.get('context_length',0), reverse=True)
for m in free:
    print(f\"{m['id']} | ctx:{m.get('context_length',0)} | {m.get('description','')[:60]}\")
"
```

### 2. Check quality rankings
Browse https://artificialanalysis.ai/leaderboards/models using `agentbridge-browser`:
```bash
agentbridge-browser --action navigate --url "https://artificialanalysis.ai/leaderboards/models"
agentbridge-browser --action extract_text --max-chars 5000
```
Look for the Intelligence Index score for each model.

### 3. Current best free picks (2026-04-06)
| Model | Intelligence | Context | Use |
|-------|-------------|---------|-----|
| `qwen/qwen3.6-plus:free` | ~45 | 1M | Main conversation |
| `minimax/minimax-m2.5:free` | 42 | 196K | Browse/sleep |
| `qwen/qwen3-coder:free` | n/a | 262K | Coding |

## Ollama (local + cloud)

### 1. List installed models
```bash
ollama list
```

### 2. Search for tool-calling models
Browse https://ollama.com/search?c=tools using `agentbridge-browser`.

### 3. Check what fits locally
Mac Mini M4 has 16GB RAM → ~10GB for models. Rule of thumb: parameter count × 0.6 = GB in Q4.
- Up to 12B: fits comfortably
- 12-20B: tight, may swap
- 20B+: cloud only

### 4. Current best picks (2026-04-06)

**Cloud (no RAM cost, free via Ollama):**
| Model | Intelligence | Use |
|-------|-------------|-----|
| `kimi-k2.5:cloud` | 47 | Main (highest IQ) |
| `qwen3.5:cloud` | 42-45 | Coding |
| `minimax-m2.5:cloud` | 42 | Browse/sleep (proven) |

**Local (offline, private):**
| Model | Size | Context | Use |
|-------|------|---------|-----|
| `qwen3.5:9b` | 6.6GB | 32K | General (already installed) |
| `gemma4:e4b` | ~3GB | 8K | Fast, multimodal |
| `lfm2.5-thinking:1.2b` | ~1GB | 32K | Ultra-lightweight |

## Scoring criteria
- **Intelligence Index** (from leaderboard, higher = better)
- **Context window** (bigger = fewer compactions)
- **Tool calling** (required for agent use)
- **Throughput** (tokens/sec)
- **RAM fit** (local models only)

Update the tables above when you find better options.
