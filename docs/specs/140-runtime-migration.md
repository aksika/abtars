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

### runtime.spawn(agent, prompt, opts?) — fire-and-forget

```typescript
interface SpawnResult {
  taskId: string;
}

interface SpawnOpts {
  onComplete?: (taskId: string, result: string) => void;
  onError?: (taskId: string, error: Error) => void;
  timeoutMs?: number;  // default: 600_000 (10 min)
}

runtime.spawn(agent, prompt, opts?): Promise<SpawnResult>
```

Runs `complete()` internally but returns immediately. Result delivered via callback. Runtime tracks active spawns for shutdown cleanup.

**Use cases:**
- Browsie browse tasks (1-10 min, result → file + notification)
- Parallel cron tasks (don't block the queue)
- Background research ("go research X, write report to ~/reports/")
- Any long-running task where caller doesn't need inline response

### Browsie migration

Current: raw `spawn("kiro-cli", ["acp"])` via wrapper script + detached child.
New: `runtime.spawn("browsie", prompt, { onComplete: deliverResult })`.

Loses detached survival but if bridge dies mid-browse, the task is lost anyway (no resume). Gains: consistency, logging, model resolution, shutdown cleanup.

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Add `AgentSession` interface + `runtime.session(agent)` | 30 min |
| 2 | Add `SpawnResult` interface + `runtime.spawn(agent, prompt, opts?)` | 20 min |
| 3 | Migrate coding-mode to `runtime.session("coding")` | 20 min |
| 4 | Migrate agent-api-server to `runtime.session("browsie")` | 30 min |
| 5 | Migrate browsie to `runtime.spawn("browsie")` | 30 min |
| 6 | Verify zero `createSubagentTransport` outside runtime | 10 min |
| 7 | Tests | 20 min |
| **Total** | | **~2.5 hr** |

## Verification

```bash
grep -rn "createSubagentTransport" src/ --include="*.ts" | grep -v node_modules | grep -v test | grep -v subagent-runtime
# Should return: nothing
```
