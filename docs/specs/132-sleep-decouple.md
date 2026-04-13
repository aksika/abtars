# #132 Decouple Sleep Pipeline into abmind

**Date:** 2026-04-14
**Status:** Planned
**Priority:** MEDIUM
**Depends on:** #131 (done)

## Execution order

**Ship #133 Phase 1 (SubagentRuntime) BEFORE #132.** Then #132's orchestrator uses `runtime.complete("dreamy", ...)` from the start. Avoids double refactor.

With SubagentRuntime available:
- No structured JSON prompt rewrite needed for AB (runtime handles tool loop)
- `buildDailySummary(complete)` callback becomes `runtime.complete("dreamy", summarizePrompt)`
- Structured JSON mode only needed for CLI standalone (#137)
- Estimated effort drops from ~9hr to ~5hr

## Persona injection rule

**Runtime owns persona, templates are pure data.** Sleep prompt templates contain only data variables (`{candidates}`, `{stats}`, `{date}`). No Dreamy personality in templates. SubagentRuntime (#133) prepends agent persona automatically. Avoids double injection.

## Dual mode (tools vs JSON)

```typescript
buildSleepPrompt(step, vars, mode: "tools" | "json")
// "tools" → prompt expects tool calls (AB via runtime, OC via subagent)
// "json"  → prompt expects JSON response (CLI standalone)
```

`parseSleepResponse()` only needed in "json" mode. In "tools" mode, the runtime handles tool calls and abmind's `applyResults()` is called by the tool executor directly.

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

## Implementation (assumes #133 Phase 1 done)

| Step | What | Time |
|---|---|---|
| 1 | Move prompt loader + templates to abmind (personality-neutral) | 30 min |
| 2 | Move daily summary + extract to abmind | 30 min |
| 3 | Create `buildDreamReport()` in abmind | 30 min |
| 4 | Add JSON mode for CLI: `buildSleepPrompt(step, vars, "json")` | 1 hr |
| 5 | Create `parseSleepResponse()` — defensive JSON parser (JSON mode only) | 1 hr |
| 6 | Refactor bridge orchestrator to use `runtime.complete("dreamy", ...)` | 45 min |
| 7 | Add `abmind sleep-state/sleep-prompt/sleep-apply/sleep-report` CLI commands | 45 min |
| 8 | `sleep-apply --dry-run` mode | 15 min |
| 9 | Test: bridge sleep cycle + CLI standalone | 30 min |
| **Total** | | **~5.5 hr** |

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
