# #129 /models Redesign — Hot Model Switch

**Date:** 2026-04-12
**Status:** Planned
**Priority:** MEDIUM

## Commands

| Command | What |
|---|---|
| `/models` | Show current: model, provider, transport type, fallbacks |
| `/models change` | 3-step picker: [Main / Fallback 1 / Fallback 2] → provider → model |
| `/models status` | All agents (professor/dreamy/browsie/coding) with model + provider |
| `/model` | Alias for `/models` |
| `/status` | Shows `TransportManager.currentModel` (runtime truth) |

## `/models` output

```
🤖 Model: kimi-k2.5:cloud
🔌 Provider: ollama (api)
🛡️ Fallbacks: minimax-m2.5:cloud (ollama)

Use /models change to switch.
```

## `/models change` flow

**Step 1:** What to change?
```
[Main model]
[Fallback 1]
[Fallback 2]
```

**Step 2:** Pick provider (from transport.json providers):
```
✓ ollama
  kiro-free
  kiro-paid
  openrouter
```

**Step 3:** Pick model (filtered from models.json where `transports` includes selected provider). Shows rank + cost:
```
✓ kimi-k2.5:cloud     (rank 2, $0.0/M)
  minimax-m2.5:cloud   (rank 3, $0.0/M)
  qwen3.5:cloud        (rank 3, $0.0/M)
```

**Step 4:** Liveness check — probe the selected model before confirming:
- API providers: `fetch(endpoint/models)` or 1-token completion
- ACP providers: check CLI exists in PATH
- Pass → "✅ Switched to kimi-k2.5:cloud"
- Fail → "⚠️ Model unreachable, try another?"

## After selection

| Scenario | Action |
|---|---|
| Same provider, different model (main) | `transport.setModel(model)` — hot-switch, keep session |
| Different provider (main) | Write transport.json → `/reset` → reinitialize transport |
| Fallback change | Write transport.json `fallbacks` array — no reset, takes effect on next failure |

## `/models status` output

```
📋 Agent models:
  professor: kimi-k2.5:cloud (ollama, api)
  dreamy:    minimax-m2.5:cloud (ollama, api)
  browsie:   minimax-m2.5:cloud (ollama, api)
  coding:    qwen3.5:cloud (ollama, api)
```

## Existing fallback behavior (unchanged)

DirectApiTransport already handles:
1. Candidate list: primary + fallbacks in order
2. Leaky bucket per model — skip rate-limited models
3. `session.rollbackToLastUser()` — re-injects last user message to fallback model
4. `onFallback` callback — notifies user
5. Context fit check — skips models with too-small context window
6. `_userModelOverride` via `setModel()` — manual switch puts that model first

**Rule:** Provider change always resets session, even during fallback.

## Data sources

| What | Source |
|---|---|
| Current running model | `TransportManager.currentModel` (in-memory) |
| Available providers | `transport.json` providers |
| Available models per provider | `models.json` filtered by `transports` includes provider |
| Model details (rank, cost) | `models.json` |
| Configured main + fallbacks | `transport.json` agents.professor |
| All agent assignments | `transport.json` agents |

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Rewrite `handleModels` — show current from TransportManager + transport.json | 15 min |
| 2 | Rewrite `/models change` — 3-step inline keyboard (slot → provider → model with cost) | 30 min |
| 3 | Wire model switch: same provider = `setModel()`, different provider = write transport.json + `/reset` | 20 min |
| 4 | Wire fallback change: write to transport.json `fallbacks` array | 10 min |
| 5 | Rewrite `handleStatus` — model from `TransportManager.currentModel` | 10 min |
| 6 | Add `/models status` — all agents with model + provider | 10 min |
| 7 | Liveness check on model select | 15 min |
| 8 | Add `writeTransportConfig()` to transport-config.ts | 10 min |
| **Total** | | **~2 hr** |

## Files changed

- `src/components/command-handlers.ts` — main changes
- `src/components/transport-config.ts` — add `writeTransportConfig()` for persisting changes

## What gets deleted from command-handlers.ts

- `AGENT_MAIN_MODEL` env reads
- `AGENT_TRANSPORT_PROFILE` env reads
- `API_ENDPOINT` env reads
- `AGENT_AVAILABLE_MODELS` env reads
- `API_FALLBACK_*` env reads
- Old transport profile listing from `~/.agentbridge/transports/`
- Fetch from `endpoint/models` (models come from models.json now)
- `/transport` and `/transport change` handlers (replaced by `/models`)
