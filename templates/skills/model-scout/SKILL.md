---
name: model-scout
description: Find the best free cloud models and update models.json from OpenRouter leaderboard
user-invocable: true
---

# Model Scout

Scout OpenRouter models — free tier, leaderboard top N, single model inspection.

## Scripts

- `scout-openrouter.py` — free model scan, single model inspection, leaderboard fetch
- `scout-leaderboard.py` — dedicated leaderboard fetcher (top N by popularity)
- `scout-ollama.py` — Ollama cloud models
- `scout-add-model.py` — manual model addition

## Usage

### 1. Scan free models (original behavior)

```bash
# List free models vs catalog
python3 {baseDir}/scout-openrouter.py

# List + liveness test + write status to models.json
python3 {baseDir}/scout-openrouter.py --test
```

### 2. Fetch leaderboard top N and add to models.json

```bash
# Print top 20 (no changes)
python3 {baseDir}/scout-leaderboard.py 20

# Add/update top 20 in models.json (no liveness test)
python3 {baseDir}/scout-leaderboard.py 20 --update

# Test each model + update
python3 {baseDir}/scout-leaderboard.py 20 --test
```

Also available via `scout-openrouter.py`:
```bash
python3 {baseDir}/scout-openrouter.py --leaderboard 20
```

### 3. Inspect + test a single model

```bash
python3 {baseDir}/scout-openrouter.py --model tencent/hy3:free
```

This fetches model metadata from `/api/v1/models/{id}` and provider endpoints from `/api/v1/models/{id}/endpoints`, tests liveness, and updates models.json.

### 4. Ollama cloud models

```bash
python3 {baseDir}/scout-ollama.py
```

## What the scripts store

Each model entry in `models.json` gets:
- `contextWindow`, `maxOutput` — from API `context_length` and `top_provider.max_completion_tokens`
- `rank` — 1 (≥500K ctx), 2 (≥200K), 3 (smaller)
- `cost` — per token, raw OpenRouter pricing (from `pricing.prompt` / `pricing.completion`). Accurate for calculations; picker display converts to $/1M via the `display` field derived in transport-config.ts.
- `transports` — `["openrouter"]`
- `status` — `"alive"` or `"dead"` (from liveness test)
- `providers` — dict of provider_name → `{status, uptime_30m, latency_p50, throughput_p50, quant, max_completion_tokens}`
- `validatedAt` — ISO date

## OpenRouter API sort options

Pass `?sort=` to `/api/v1/models`:
- `most-popular` — default leaderboard order (usage-based)
- `top-weekly` — weekly usage
- `intelligence-high-to-low` — benchmark scores
- `pricing-low-to-high` — cheapest first
- `context-high-to-low` — largest context first
- `throughput-high-to-low` — fastest first
- `latency-low-to-high` — lowest latency first

## models.json schema

```json
{
  "model-id": {
    "contextWindow": 262144,
    "maxOutput": 16384,
    "rank": 2,
    "cost": { "input": 0.0, "output": 0.0 },
    "transports": ["openrouter"],
    "description": "Why this model was added",
    "validatedAt": "2026-07-10",
    "status": "alive",
    "providers": {
      "Novita": {
        "status": 0,
        "uptime_30m": 99.91,
        "latency_p50": 2756,
        "throughput_p50": 44,
        "quant": "unknown",
        "max_completion_tokens": 262144
      }
    }
  }
}
```

## Liveness test

```bash
curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"model-id","messages":[{"role":"user","content":"Say OK"}],"max_tokens":50}'
```

## Config files

- **models.json** — `~/.abtars/config/models.json` (hot-reloaded)
- **transport.json** — `~/.abtars/config/transport.json`
