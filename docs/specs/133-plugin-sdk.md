# #133 AB Plugin SDK — Skeleton Architecture

**Date:** 2026-04-14
**Status:** Planned
**Priority:** HIGH
**Depends on:** #131 (done)

## Goal

AgentBridge gets a subagent runtime. Any component can request LLM completions without managing transports. Ship incrementally — runtime first, skeleton later.

## Phase 1: SubagentRuntime (ship first, immediate value)

```typescript
interface SubagentRuntime {
  complete(agent: string, prompt: string, opts?: AgentOpts): Promise<string>;
}

interface AgentOpts {
  tools?: ToolDef[];          // override default tools for this call
  session?: "fresh" | "reuse"; // fresh = clean context, reuse = continue
  context?: Record<string, unknown>; // userId, metadata — flows to memory
}
```

### Tool access per agent

Each agent has a default tool set, read from config or hardcoded:

```typescript
const AGENT_TOOLS: Record<string, string[]> = {
  professor: ["memory_recall", "memory_store", "memory_edit", "web_browse", "execute_bash"],
  dreamy:    ["memory_store", "memory_edit", "memory_recall"],
  browsie:   ["web_browse", "execute_bash"],
  coding:    ["execute_bash", "memory_recall"],
};
```

`runtime.complete("browsie", prompt)` wires browse+bash automatically. Caller can override via `opts.tools`.

### Context injection

SubagentRuntime injects context per agent automatically:
- Professor: SOUL bundle + skills + persona
- Dreamy: sleep persona + memory context
- Browsie: browse instructions
- Coding: coding instructions + project context

The caller sends the *task prompt*. The runtime prepends the agent's context. This is what makes "sleep collapses to 30 lines" true — the context assembly moves into the runtime, not the caller.

### Session lifecycle

| Agent | Session strategy | Why |
|---|---|---|
| dreamy | `fresh` every sleep cycle | Clean context each night |
| browsie | `fresh` per browse task | One-shot, no history needed |
| coding | `reuse` across prompts | Multi-turn coding session |
| professor | `reuse` (main session) | Continuous conversation |

Default per agent, overridable via `opts.session`.

### Error handling / fallback

SubagentRuntime preserves existing fallback: on failure, falls back to professor's model+provider (from transport.json). `complete()` retries with fallback before throwing. Caller gets either a response or an error — never needs to handle fallback logic.

### userId flow

`opts.context.userId` flows through the runtime to memory operations. When a tool call hits `memory_store`, the runtime passes userId so the memory system can set scope correctly (#135). Sketch:

```typescript
const resp = await skeleton.runtime.complete("dreamy", prompt, {
  context: { userId: "master" }
});
// → runtime passes userId to tool executor
// → memory_store sets user_id + scope on the memory
```

## Phase 2: Slot interfaces (incremental, after Phase 1)

```typescript
interface ABSkeleton {
  memory:    IMemorySystem;
  transport: IKiroTransport;      // professor's main transport
  platforms: PlatformAdapter[];
  runtime:   SubagentRuntime;     // from Phase 1
  skills:    ISkillSlot;
  tasks:     ITaskSlot;
}

interface ISkillSlot {
  loadSkills(): Skill[];
  watchForChanges(): void;
  stop(): void;
}

interface ITaskSlot {
  registerTask(task: { name: string; execute: () => Promise<void> }): void;
  tick(): Promise<void>;
  stop(): void;
  getTaskNames(): string[];
  getTaskStatuses(): ReadonlyMap<string, string>;
}
```

Extract from existing skill-watcher.ts and heartbeat-system.ts. Thin interfaces over existing code.

## Phase 3: Skeleton wiring (incremental, after Phase 2)

Refactor bridge-app.ts to use `createSkeleton()`. Realistic expectation: 700 → ~300 lines. Complexity redistributes into skeleton components, not eliminated. Still valuable — better organization, testability, clear boundaries.

## What this enables

After Phase 1, every subagent caller simplifies:

```typescript
// Before: 50+ lines per subagent (create transport, wire tools, manage session)
const transport = await createSubagentTransport("browsie");
const session = transport.createSession();
// ... wire tools, handle errors, cleanup

// After: 1 line
const result = await runtime.complete("browsie", browsePrompt);
```

After Phase 1 + #132, sleep orchestrator:
```typescript
const candidates = abmind.buildSleepCandidates();
for (const step of sleepSteps) {
  const prompt = abmind.buildSleepPrompt(step, candidates);
  const response = await runtime.complete("dreamy", prompt, { session: "reuse" });
  const result = abmind.parseSleepResponse(step, response);
  abmind.applyResults(result);
}
```

## Implementation

### Phase 1: SubagentRuntime (~6hr)

| Step | What | Time |
|---|---|---|
| 1 | `SubagentRuntime` class — transport cache, lazy creation | 1 hr |
| 2 | Tool wiring per agent — default tool sets, tool executor | 2 hr |
| 3 | Context injection per agent — persona/instructions prepend | 1 hr |
| 4 | Session lifecycle (fresh/reuse) + fallback on failure | 1 hr |
| 5 | Refactor one subagent caller (browsie) as proof | 30 min |
| 6 | Tests | 30 min |

### Phase 2: Slot interfaces (~1.5hr)

| Step | What | Time |
|---|---|---|
| 7 | Extract ISkillSlot from skill-watcher | 30 min |
| 8 | Extract ITaskSlot from heartbeat-system | 30 min |
| 9 | Define ABSkeleton interface | 30 min |

### Phase 3: Skeleton wiring (~4hr)

| Step | What | Time |
|---|---|---|
| 10 | `createSkeleton()` factory | 1 hr |
| 11 | Refactor bridge-app.ts incrementally | 2.5 hr |
| 12 | Verify all tests pass | 30 min |

| **Total** | | **~11.5 hr** |

### Ship order

Phase 1 alone delivers value. Phases 2-3 are incremental improvements. No need to ship all three together.

## Ecosystem research reference

See previous version of this spec for full ecosystem research (OpenClaw, Magic Context, Mastra, eigent, gitagent, axar) and multi-host adapter pattern (AB-slot, OC plugin, OpenCode plugin, Claude Code plugin, MCP server, CLI).
