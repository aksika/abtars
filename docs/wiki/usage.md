# Token Usage

Track how many tokens the agent consumes and what it costs.

## /usage command

```
/usage
```

Shows token consumption and estimated cost: Today / Yesterday / Day-before /
Last-7d / Last-30d, per-model detail with cache read/write lines, OpenRouter
credits where applicable, and budget status.

## What's tracked

Every API call records:
- **Input tokens** — prompt + context sent to the model
- **Output tokens** — model's response
- **Model used** — which model handled the request
- **Cost** — calculated from the `cost` rates in `models.json`

## Pricing data

Cost is derived from the `cost` field in `~/.abtars/config/models.json`.
Rates are per million tokens:

```json
{
  "openai/gpt-5.6-luna": {
    "cost": { "input": 0.14, "output": 0.28 }
  }
}
```

abTARS multiplies token counts by these rates to estimate cost.
