# #129 /models Redesign — Hot Model Switch

**Date:** 2026-04-12
**Status:** Planned
**Priority:** MEDIUM

## Commands

| Command | What |
|---|---|
| `/models` | Show current: model, provider, transport type, fallbacks |
| `/models change` | 6-slot picker → provider → model. All changes persist to transport.json |
| `/models status` | All agents with model + provider |
| `/models quick <model>` | Shortcut: instant switch if model available on current provider |
| `/model` | Alias for `/models` |

## Agent names

| Internal | Display | Role |
|---|---|---|
| professor | Professor (main) | Main conversation agent |
| dreamy | Dreamy (sleep) | Overnight maintenance |
| browsie | Browsie (browse) | Web browsing |
| coding | Cody (coding) | Coding subagent |
| cron | — | Inherits Professor, not shown in picker |

## `/models` output

```
🤖 Model: kimi-k2.5:cloud
🔌 Provider: ollama (api)
🛡️ Fallbacks: minimax-m2.5:cloud (ollama)

Use /models change to switch.
```

## `/models change` flow

**Step 1:** Which agent?
```
[Professor (main)]
[Professor fallback 1]
[Professor fallback 2]
[Dreamy (sleep)]
[Browsie (browse)]
[Cody (coding)]
```

**Step 2:** Pick provider (pre-filtered — only shows providers that work on this machine):
- API providers: shown only if `apiKeyEnv` resolves to non-empty env var, or no key needed (ollama)
- ACP providers: shown only if CLI found in PATH

```
✓ ollama
  openrouter
```

**Step 3:** Pick model (filtered from models.json where `transports` includes selected provider):
```
✓ kimi-k2.5:cloud     (★★☆☆☆, free)
  minimax-m2.5:cloud   (★★★☆☆, free)
  qwen3.5:cloud        (★★★☆☆, free)
```

Stars = 5 - rank (rank 1 = ★★★★★, rank 5 = ★☆☆☆☆). Cost from models.json.

**Step 4:** Liveness check — probe the selected model before confirming:
- API providers: `fetch(endpoint/models)` or 1-token completion
- ACP providers: check CLI exists in PATH
- Pass → "✅ Switched to kimi-k2.5:cloud"
- Fail → "⚠️ Model unreachable, try another?"

## `/models quick <model>` shortcut

Skip the 3-step flow. If model is in models.json and available on current provider → liveness check → instant switch + write transport.json. If not on current provider → "Model not available on ollama. Use /models change to switch provider."

## `/models status` output

```
📋 Agent models:
  Professor: kimi-k2.5:cloud (ollama, api)
  Dreamy:    minimax-m2.5:cloud (ollama, api)
  Browsie:   minimax-m2.5:cloud (ollama, api)
  Cody:      qwen3.5:cloud (ollama, api)
  Cron:      inherits Professor
```

## After selection

| Scenario | Action |
|---|---|
| Professor: same provider, different model | Write transport.json + `setModel()` — keep session |
| Professor: different provider | Write transport.json → `/reset` → reinitialize transport |
| Professor fallback change | Write transport.json `fallbacks` array — no reset |
| Subagent: any change | Write transport.json — no reset, takes effect on next spawn |

## Persistence

ALL changes write to transport.json. No in-memory-only switches. Survives bridge restarts, crashes, sleep cycles.

## Existing fallback behavior (unchanged)

DirectApiTransport already handles:
1. Candidate list: primary + fallbacks in order
2. Leaky bucket per model — skip rate-limited models
3. `session.rollbackToLastUser()` — re-injects last user message to fallback model
4. `onFallback` callback — notifies user
5. Context fit check — skips models with too-small context window

## Data sources

| What | Source |
|---|---|
| Current running model | `TransportManager.currentModel` (in-memory) |
| Available providers | `transport.json` providers, pre-filtered by availability |
| Available models per provider | `models.json` filtered by `transports` includes provider |
| Model details (rank, cost) | `models.json` |
| All agent assignments | `transport.json` agents |

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Rewrite `handleModels` — show current from TransportManager + transport.json | 15 min |
| 2 | Rewrite `/models change` — 6-slot → provider (pre-filtered) → model (with stars + cost) | 35 min |
| 3 | Wire all changes to write transport.json. Professor provider change = `/reset` | 20 min |
| 4 | `/models quick <model>` shortcut | 10 min |
| 5 | Rewrite `handleStatus` — model from `TransportManager.currentModel` | 10 min |
| 6 | `/models status` — all agents with model + provider | 10 min |
| 7 | Liveness check on model select | 15 min |
| 8 | Provider pre-filter (check API key / CLI in PATH) | 10 min |
| 9 | `writeTransportConfig()` in transport-config.ts | 10 min |
| **Total** | | **~2.25 hr** |

## Files changed

- `src/components/command-handlers.ts` — main changes
- `src/components/transport-config.ts` — add `writeTransportConfig()`, provider availability check

## What gets deleted from command-handlers.ts

- All `AGENT_*` env reads for models/transport
- Old transport profile listing from `~/.agentbridge/transports/`
- Fetch from `endpoint/models` (models come from models.json)
- `/transport` and `/transport change` handlers
