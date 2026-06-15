# Budget

Daily cost control per agent type. Prevents runaway model usage from sleep cycles, self-healing loops, or excessive task dispatching.

## How it works

Each agent (professor, dreamy, coding, healer, browsie) has two daily limits:
- **Tokens** — total input + output tokens (configured in thousands)
- **Calls** — number of LLM invocations

Both limits enforced simultaneously — whichever hits first blocks the agent until midnight.

## Configuration

File: `~/.abtars/config/budget.json`

```json
{
  "_comment": "tokens are in K (1000 = 1M actual tokens). Both limits enforced.",
  "daily": {
    "professor": { "tokens": 2000, "calls": 200 },
    "dreamy":    { "tokens": 100,  "calls": 20 },
    "coding":    { "tokens": 2000, "calls": 50 },
    "healer":    { "tokens": 50,   "calls": 10 },
    "browsie":   { "tokens": 100,  "calls": 100 }
  }
}
```

- `tokens: 2000` = 2,000,000 actual tokens per day
- `calls: 200` = 200 LLM invocations per day
- Remove an agent's entry to make it unlimited
- Delete the file entirely to disable all enforcement

## What happens when a limit is hit

1. The agent's next LLM call is rejected with a clear error
2. You get a Telegram notification: `x Budget: dreamy hit daily call limit (20/20). Paused until midnight.`
3. No more notifications for that agent for 1 hour (avoids spam)
4. At midnight (local time), counters reset automatically

## Checking usage

```
/usage
```

Shows per-agent budget consumption:
```
Token usage (today):
  professor: 142K / 2000K tokens (7%),  45 / 200 calls (22%)
  dreamy:     0K /  100K tokens,          0 / 20 calls
  healer:    12K /   50K tokens (24%),    3 / 10 calls (30%)
```

## Which calls are tracked

| Agent | What counts | Transport |
|-------|-------------|-----------|
| professor | Interactive chat, task execution, Orc orchestration | Direct-API (tokens + calls), ACP (best-effort tokens + calls) |
| dreamy | Sleep pipeline steps | Direct-API |
| coding | Code sessions | Direct-API / ACP |
| healer | Self-healing dispatches | Direct-API |
| browsie | Browse tasks, worker execution | Direct-API |

## Relationship to other limits

| System | What it controls | Coexists with budget? |
|--------|-----------------|----------------------|
| `SLEEP_MAX_LLM_CALLS` | Max LLM calls per sleep cycle (default 18) | Yes — safety cap per cycle, budget is daily total |
| `max_tokens` on kanban cards | Token budget per project | Yes — project-level cap, budget is global |
| `maxRunsPerDay` on tasks | Execution count per task | Yes — per-task count, budget is per-agent |

## Tips

- Start with generous limits, observe `/usage` for a week, then tighten
- Professor at 2000K handles ~100 conversations/day comfortably
- Dreamy at 100K is ~5 full sleep cycles (normal quality uses ~20K)
- If you hit budget regularly, consider switching to a cheaper model for that agent rather than raising the limit
