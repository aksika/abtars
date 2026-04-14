# #140 Migrate All Callers to SubagentRuntime

**Date:** 2026-04-14
**Status:** Planned
**Priority:** LOW
**Depends on:** #133 (done)

## Goal

Zero `createSubagentTransport()` calls outside SubagentRuntime. Every LLM interaction goes through the runtime.

## Current State

| Caller | Pattern | Transport |
|---|---|---|
| Sleep | `runtime.complete("dreamy")` | ✅ through runtime |
| Self-healer | `runtime.complete("professor")` | ✅ through runtime |
| Cron | `runtime.complete("cron")` | ✅ through runtime |
| **Coding-mode** | `createSubagentTransport("coding")` | ❌ direct |
| **Agent-api-server** | `createSubagentTransport("browse")` | ❌ direct |
| **Browsie** | Raw `spawn("kiro-cli", ["acp"])` | ❌ raw child process |

## Design

### AgentSession interface

```typescript
interface AgentSession {
  sendPrompt(sessionKey: string, prompt: string): Promise<string>;
  destroy(): Promise<void>;
  readonly isReady: boolean;
}
```

### runtime.session(agent)

Returns an `AgentSession` — a persistent transport handle for multi-turn callers. Runtime manages creation, caching, and cleanup.

```typescript
// Coding-mode
const session = await runtime.session("coding");
await session.sendPrompt(key, "system prompt");
// ... later ...
await session.sendPrompt(key, userMessage);
await session.destroy();
```

### Browsie — fire-and-forget

Browsie is different: it spawns a detached process that survives bridge restarts. Two options:

**Option A (simple):** Keep detached spawn, already uses transport.json for model. Not through runtime but model resolution is correct. Accept the inconsistency.

**Option B (clean):** `runtime.complete("browsie", prompt)` wrapped in fire-and-forget. Loses detached survival but gains consistency. Browse tasks take 1-10 min — if bridge restarts mid-browse, task is lost either way (no resume).

**Recommendation:** Option B. The detached spawn is complexity for a benefit that doesn't matter in practice.

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Add `AgentSession` interface + `runtime.session(agent)` | 30 min |
| 2 | Migrate coding-mode to `runtime.session("coding")` | 20 min |
| 3 | Migrate agent-api-server to `runtime.session("browsie")` | 30 min |
| 4 | Migrate browsie to `runtime.complete("browsie")` | 30 min |
| 5 | Verify zero `createSubagentTransport` outside runtime | 10 min |
| 6 | Tests | 20 min |
| **Total** | | **~2.5 hr** |

## Verification

```bash
grep -rn "createSubagentTransport" src/ --include="*.ts" | grep -v node_modules | grep -v test | grep -v subagent-runtime
# Should return: nothing
```
