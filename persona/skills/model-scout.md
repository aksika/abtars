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

## OpenRouter scouting

### 1. Get API key from transport.json
```bash
# Read apiKeyEnv from transport.json, then resolve it
KEY=$(python3 -c "
import json,os
tc = json.load(open(os.path.expanduser('~/.agentbridge/config/transport.json')))
env = tc['providers'].get('openrouter',{}).get('apiKeyEnv','OPENROUTER_API_KEY')
print(os.environ.get(env,''))
")
```

### 2. List free models
```bash
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $KEY" | python3 -c "
import json,sys
models = json.load(sys.stdin)['data']
free = [m for m in models if ':free' in m['id']]
free.sort(key=lambda m: m.get('context_length',0), reverse=True)
for m in free[:20]:
    ctx = m.get('context_length',0)
    out = m.get('top_provider',{}).get('max_completion_tokens',0)
    print(f\"{m['id']} | ctx:{ctx} | maxOut:{out} | {m.get('description','')[:50]}\")
"
```

### 3. Compare against models.json
```bash
python3 -c "
import json,os
current = json.load(open(os.path.expanduser('~/.agentbridge/config/models.json')))
or_models = [k for k in current if 'openrouter' in current[k].get('transports',[])]
print('Already cataloged:', ', '.join(or_models))
"
```

### 4. Add new model to models.json
```bash
python3 -c "
import json,os
path = os.path.expanduser('~/.agentbridge/config/models.json')
models = json.load(open(path))
models['new-model-id:free'] = {
    'contextWindow': 131072,
    'maxOutput': 8192,
    'rank': 3,
    'cost': {'input': 0.0, 'output': 0.0},
    'transports': ['openrouter']
}
json.dump(models, open(path,'w'), indent=2)
print('Added new-model-id:free')
"
```

## Ollama scouting

### 1. List installed models
```bash
ollama list
```

### 2. Search for new models

**Tool-calling models (required for agent use):**
```bash
agentbridge-browser --action navigate --url "https://ollama.com/search?c=tools"
agentbridge-browser --action extract_text --max-chars 5000
```

**Cloud models (no RAM cost):**
```bash
# Cloud models run on Ollama's infrastructure, tagged with :cloud
agentbridge-browser --action navigate --url "https://ollama.com/search?q=cloud"
agentbridge-browser --action extract_text --max-chars 5000
```

### 3. Check what's available via API
```bash
curl -s http://localhost:11434/api/tags | python3 -c "
import json,sys
models = json.load(sys.stdin).get('models',[])
for m in models:
    size_gb = m.get('size',0) / 1e9
    print(f\"{m['name']} | {size_gb:.1f}GB\")
"
```

### 4. Test a model before adding
```bash
# Quick liveness + tool-calling check
curl -s http://localhost:11434/v1/chat/completions -d '{
  "model": "model-name",
  "messages": [{"role":"user","content":"Say hi"}],
  "max_tokens": 5
}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('choices',[{}])[0].get('message',{}).get('content','FAILED'))"
```

### 5. Add to models.json
```bash
python3 -c "
import json,os
path = os.path.expanduser('~/.agentbridge/config/models.json')
models = json.load(open(path))
models['new-model:cloud'] = {
    'contextWindow': 131072,
    'maxOutput': 8192,
    'rank': 3,
    'cost': {'input': 0.0, 'output': 0.0},
    'transports': ['ollama']
}
json.dump(models, open(path,'w'), indent=2)
print('Added new-model:cloud')
"
```

### 6. Local model sizing (Mac Mini M4, 16GB RAM)
Rule of thumb: parameter count × 0.6 = GB in Q4 quantization.
- Up to 12B: fits comfortably (~7GB)
- 12-20B: tight, may swap
- 20B+: cloud only

## Quality research

### Check leaderboards
```bash
agentbridge-browser --action navigate --url "https://artificialanalysis.ai/leaderboards/models"
agentbridge-browser --action extract_text --max-chars 5000
```

### Scoring criteria
- **Intelligence Index** (from leaderboard, higher = better) → determines rank
- **Context window** (bigger = fewer compactions)
- **Tool calling** (required — model must support function calling)
- **Throughput** (tokens/sec, matters for interactive use)
- **Cost** (free preferred, low cost acceptable)
- **RAM fit** (local models only)

## After scouting

1. Add discovered models to `~/.agentbridge/config/models.json` (hot-reloaded)
2. Set `transports` correctly — model must list every provider that can serve it
3. Test with `/models quick <model>` or `/models change`
4. Update rank if leaderboard data available
