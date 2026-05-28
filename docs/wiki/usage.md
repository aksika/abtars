# Token Usage

Track how many tokens the agent consumes and what it costs.

## /usage command

```
/usage
```

Shows token consumption and estimated cost for the current session and totals.

## What's tracked

Every API call records:
- **Input tokens** — prompt + context sent to the model
- **Output tokens** — model's response
- **Model used** — which model handled the request
- **Cost** — calculated from pricing in `models.json`

## Pricing data

Cost is derived from the `pricing` field in `~/.abtars/config/models.json`:

```json
{
  "name": "openrouter/anthropic/claude-sonnet-4",
  "pricing": {
    "input": 3.0,
    "output": 15.0
  }
}
```

Prices are per million tokens. abTARS multiplies token counts by these rates to estimate cost.
