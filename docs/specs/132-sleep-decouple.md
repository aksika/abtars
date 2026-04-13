# #132 Decouple Sleep Pipeline into abmind

**Date:** 2026-04-14
**Status:** Planned
**Priority:** MEDIUM
**Depends on:** #131 (done)

## Design: Option D — Move pure logic, keep orchestrator in host

Don't move the orchestrator. Move the reusable sleep data pipeline. The orchestrator is inherently tied to "having an agent session" — that's a host concern, not a memory concern.

## What abmind exports (pure, no transport)

```typescript
// 1. Gather state (already in abmind via SleepDataAccess)
sleepData.buildSleepCandidates()  // → candidates, emotions, stats

// 2. Build prompts (moves to abmind)
buildSleepPrompt(step, variables)  // → prompt string with candidates substituted

// 3. Parse structured responses (moves to abmind)
parseSleepResponse(step, response) // → { promotions: number[], demotions: number[], edits: EditOp[] }

// 4. Apply results (already in abmind)
sleepData.promoteMemory(id)
sleepData.demoteMemory(id)

// 5. Build dream report (moves to abmind)
buildDreamReport(results)  // → markdown string
```

## What stays in each host

The orchestrator loop — who drives the LLM:

**AgentBridge:** Dreamy (separate ACP agent) drives the loop
**kiro-cli (#137):** Kiro itself drives the loop via steering file + CLI
**OpenClaw (#136):** Plugin hook on gateway_stop, OC subagent drives
**OpenCode:** Overnight dreamer agent drives
**Claude Code:** /remember skill triggers, Claude drives

Example host loop (~10 lines):
```typescript
const candidates = mem.buildSleepCandidates();
for (const step of sleepSteps) {
  const prompt = mem.buildSleepPrompt(step, candidates);
  const response = await llm.complete(prompt);  // host provides this
  const result = mem.parseSleepResponse(step, response);
  mem.applyResults(result);
}
const report = mem.buildDreamReport();
```

## What moves to abmind repo

- `sleep-prompt-loader.ts` — load + substitute prompt templates
- `sleep-daily-summary.ts` — build daily summary (needs simple LLM callback for summarization)
- `sleep-extract-daily.ts` — extract facts from daily files
- Sleep prompt markdown files (14 files in `persona/sleep/`)
- Candidate scoring/ranking logic (already in SleepDataAccess)
- Dream report builder

## What stays in bridge

- `agentbridge-sleep.ts` — orchestrator (creates Dreamy transport, runs steps, reports progress)
- `sleep-trigger.ts` — bedtime + quiet ticks timing
- Hardware sleep trigger (pmset)
- Telegram progress notifications

## Drawbacks + mitigations

### 1. Tool calls during sleep

**Problem:** Today Dreamy calls `abmind store`, `abmind edit` mid-conversation via native tool loop. With Option D, `parseSleepResponse()` must extract decisions from the LLM response text.

**Mitigation:** Redesign sleep prompts to produce structured output (JSON) instead of relying on tool calls:
```
Respond with JSON only:
{"promote": [42, 43], "demote": [17], "edit": [{"id": 5, "boost": true}]}
```
abmind parses this reliably. No tool loop needed.

**JSON parser must be defensive:** Models wrap JSON in markdown fences, add trailing commentary, produce invalid syntax. Parser needs: strip fences, find first `{`/`[`, try-parse, fallback to regex extraction. Budget 1 hour, not 30 min.

**Effort:** ~2-3 hours of prompt engineering to rewrite 14 sleep step prompts.

### 2. Multi-turn steps

**Problem:** Some sleep steps are multi-turn — Dreamy asks follow-ups, refines, then decides. Option D's `buildPrompt → getResponse → parseResponse` assumes single-turn per step.

**Mitigation:** Redesign the 2-3 multi-turn steps to be single-turn. Provide all context upfront so the LLM can decide in one pass. Most steps are already single-turn.

**Risk:** Collapsing multi-turn to single-turn may reduce decision quality on complex steps (darwinism, core-promotion, merge). Test single-turn versions against real data before committing. Identify which steps are currently multi-turn first.

**Effort:** ~1 hour to collapse multi-turn steps.

### 3. Persona-specific prompts

**Problem:** The 14 prompt files contain Dreamy's personality, Hungarian references, agent-specific context. Moving to abmind makes them generic. Other hosts need different prompts.

**Mitigation:** abmind ships prompt *templates* with `{variables}` for personality injection. Hosts provide personality context via variables. Default templates are neutral. AgentBridge overrides with Dreamy's personality at runtime.

### 4. LLM callback precedent

`buildDailySummary` needs a completion callback. Today it's one function. If contradiction detection or semantic dedup later need LLM access, the callback surface grows.

**Design rule:** LLM callbacks in abmind are exceptional, not the pattern. Document each one. If the count exceeds 3, reconsider Option C.

### 5. Plan B: Option C

If structured JSON prompts degrade sleep quality (gap #2), fall back to Option C:
```typescript
runSleep({ agent: (prompt, tools) => Promise<AgentResult> })
```
Preserves current tool-call behavior — no prompt rewrite needed. Tradeoff: callback complexity (host must implement tool loop). Keep as documented fallback.

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Identify which of 14 steps are multi-turn, test single-turn against real data | 1 hr |
| 2 | Redesign sleep prompts: structured JSON output, single-turn, personality variables | 3 hr |
| 3 | Create `parseSleepResponse()` — defensive JSON parser (strip fences, fallback) | 1 hr |
| 4 | Move prompt loader + daily summary + extract to abmind repo | 30 min |
| 5 | Move sleep prompt templates to abmind repo | 15 min |
| 6 | Create `buildDreamReport()` in abmind | 30 min |
| 7 | Refactor bridge orchestrator to use abmind pipeline (retry/progress/lock/audit) | 1.5 hr |
| 8 | Add `abmind sleep-state/sleep-prompt/sleep-apply/sleep-report` CLI commands | 45 min |
| 9 | `sleep-apply --dry-run` mode for debugging | 15 min |
| 10 | Test: bridge sleep cycle works with new pipeline | 30 min |
| **Total** | | **~9 hr** |

## CLI commands for standalone use (#137)

```bash
abmind sleep-state                    # → JSON: candidates, stats
abmind sleep-prompt --step 1          # → prompt text for step 1
abmind sleep-apply --promote 42,43    # → apply decisions
abmind sleep-report                   # → dream report markdown
```

These enable the kiro-cli steering file to drive sleep manually.

## Design constraint

`sleep-daily-summary.ts` needs an LLM to summarize the day's conversation. This is the one place abmind needs a completion callback:
```typescript
buildDailySummary(db, complete: (prompt: string) => Promise<string>)
```
Single-turn, no tools. The host passes a simple callback. This is acceptable — it's one function, not the whole orchestrator.
