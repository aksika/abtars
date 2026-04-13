# #133 AB Plugin SDK — Skeleton Architecture

**Date:** 2026-04-14
**Status:** Planned
**Priority:** HIGH
**Depends on:** #131 (done)

## Goal

AgentBridge gets a skeleton with a subagent runtime. Any component can request LLM completions without managing transports. Slot interfaces formalized. bridge-app.ts wiring simplified.

## Three parts

### Part 1: SubagentRuntime (core deliverable)

```typescript
interface SubagentRuntime {
  complete(agent: string, prompt: string): Promise<string>;
  // agent = "professor" | "dreamy" | "browsie" | "coding"
  // Reads model+provider from transport.json
  // Creates/reuses transport, handles session, retries
}
```

Replaces:
- `createSubagentTransport()` scattered calls
- Manual transport creation in sleep, browse, coding
- 1000-line sleep orchestrator's transport management

Implementation: wrap `createSubagentTransport()` with cache + session manager. One transport per agent, reused across calls, lazy-created on first use.

### Part 2: Slot interfaces

```typescript
interface ABSkeleton {
  memory:    IMemorySystem;       // exists
  transport: IKiroTransport;      // exists (professor's main transport)
  platforms: PlatformAdapter[];   // exists
  runtime:   SubagentRuntime;     // NEW
  skills:    ISkillSlot;          // formalize skill-watcher
  tasks:     ITaskSlot;           // formalize heartbeat
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

ISkillSlot and ITaskSlot extracted from existing skill-watcher.ts and heartbeat-system.ts.

### Part 3: Config-driven wiring

```typescript
const skeleton = await createSkeleton({
  memory: createAbmindMemory(memoryConfig),
  transport: await initTransport(transportConfig),
  platforms: [telegramAdapter, discordAdapter],
  runtime: new SubagentRuntime(transportConfig),
  skills: new SkillWatcher(skillsDir),
  tasks: heartbeat,
});
```

bridge-app.ts becomes: create skeleton → start platforms → start heartbeat. Glue code shrinks from 700+ lines to ~100.

## What this enables

Sleep:
```typescript
const resp = await skeleton.runtime.complete("dreamy", prompt);
```

Browse:
```typescript
const result = await skeleton.runtime.complete("browsie", browsePrompt);
```

Any future component:
```typescript
await skeleton.runtime.complete(agentName, prompt);
```

After #132 + #133, sleep orchestrator collapses from ~1000 lines to ~30.

## What exists today vs what changes

| Component | Today | After #133 |
|---|---|---|
| Subagent creation | Manual per component | `runtime.complete(agent, prompt)` |
| Slot interfaces | Informal (IKiroTransport, IMemorySystem) | Formal ABSkeleton |
| bridge-app.ts | 700+ lines of manual wiring | ~100 lines via createSkeleton() |
| Sleep transport | Creates own ACP session | `runtime.complete("dreamy", ...)` |
| Browse transport | Creates own transport | `runtime.complete("browsie", ...)` |
| Coding transport | Creates own transport | `runtime.complete("coding", ...)` |

## Design constraint: userId

`runtime.complete()` is agent-to-agent — no userId needed. `skeleton.memory` methods need userId for #67. Skeleton passes userId through context when platform adapter receives a message. Not implemented in #133, but interface accommodates it.

## Risk

Refactoring bridge-app.ts (step 6) is the biggest risk — most complex file, 700+ lines of wiring. Needs incremental refactoring, not a rewrite. Extract one component at a time, test after each.

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | `SubagentRuntime` class — wraps transport creation, caches per agent | 1.5 hr |
| 2 | Extract `ISkillSlot` from skill-watcher | 30 min |
| 3 | Extract `ITaskSlot` from heartbeat-system | 30 min |
| 4 | Define `ABSkeleton` interface | 15 min |
| 5 | `createSkeleton()` factory — config-driven wiring | 1 hr |
| 6 | Refactor bridge-app.ts to use skeleton | 1.5 hr |
| 7 | Refactor sleep/browse/coding to use `runtime.complete()` | 1 hr |
| 8 | Verify all 568 bridge tests pass | 30 min |
| **Total** | | **~7 hr** |
