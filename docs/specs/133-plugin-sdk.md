# #133 AB Plugin SDK — Skeleton Architecture

**Date:** 2026-04-13
**Status:** Planned
**Priority:** HIGH

## Vision

AgentBridge becomes a skeleton with typed plugin slots. Everything plugs in:

```
AgentBridge Skeleton
├── Transport  (already pluggable: ACP, tmux, DirectAPI)
├── Memory     (abmind — or swap for another)
├── Sleep      (maintenance cycle)
├── Skills     (knowledge system)
├── Tasks      (cron/heartbeat)
└── Platforms  (Telegram, Discord — already pluggable)
```

## Design: Slot-based, not generic SDK

Two patterns exist in the ecosystem:
- **Heavy SDK** (OpenClaw, Mastra): general-purpose `register(api)`, lifecycle hooks, arbitrary extensions
- **Slot-based**: fixed slots with typed interfaces, swap implementations

AB uses slot-based. Reasons:
- AB has 6 slots, not unlimited extension points
- No need for third-party plugins — need swappable implementations
- Generic `register(api)` adds indirection without value when slots are known
- The slot interfaces ARE the SDK

## Slot interfaces

```typescript
interface ABSkeleton {
  memory:    IMemorySlot;      // abmind
  sleep:     ISleepSlot;       // sleep orchestrator
  skills:    ISkillSlot;       // skill loader
  tasks:     ITaskSlot;        // cron/heartbeat
  transport: ITransportSlot;   // IKiroTransport (exists)
  platforms: IPlatformSlot[];  // adapters (exist)
}
```

Each slot has a specific contract. Not a generic API — each plugin type knows exactly what it provides.

### Already formalized
- `IKiroTransport` — transport slot
- `IMemorySystem` — memory slot (needs IMemoryCore refactor for public API)
- Platform adapters — telegram/discord

### Needs formalization
- `ISleepSlot` — `runSleep(complete: LLMCallback): SleepReport`, `isActive(): boolean`
- `ISkillSlot` — `loadSkills(): Skill[]`, `watchForChanges(): void`
- `ITaskSlot` — `registerTask(task)`, `tick()`, `getStatus()`

## Config-driven loading

```json
{
  "plugins": {
    "memory": "abmind",
    "sleep": "abmind-sleep",
    "skills": "default",
    "tasks": "default",
    "transport": "from transport.json"
  }
}
```

## Design constraint: multi-user

Plugin API passes userId (not chatId) through all hooks and tool calls. userId spans platforms (TG, DC). userId→chatId mapping is a platform concern. See #67.

## Ecosystem research (2026-04-13)

| Project | Pattern | Relevance |
|---|---|---|
| OpenClaw | Heavy SDK: register(api), hooks, tools, commands, context engines | Reference for OC compat wrapper |
| lossless-claw | OC plugin: registerContextEngine, registerTool, lifecycle hooks | Reference implementation |
| Magic Context | OpenCode plugin: overnight dreamer, cross-session memory, compaction | Closest to abmind — study |
| Mastra (23k★) | Full framework, built-in memory with stores | Too heavy, everything built-in |
| eigent (13.6k★) | Desktop agent, skills = markdown + scripts | Similar skill pattern |
| gitagent (2.7k★) | Portability standard, framework-agnostic | Interesting but different goal |
| axar (157★) | Minimal TS framework, decorators | No plugin system |

## Sequencing

1. #131 — Extract abmind, define IMemoryCore (public API)
2. #132 — Decouple sleep into ISleepSlot
3. #133 — Formalize remaining slots, config-driven loading
4. Wrap abmind as first standalone plugin
5. OC compatibility wrapper (thin, maps slots → register(api))

## OC compatibility (later)

## Multi-host adapter pattern

abmind core is host-agnostic (`IMemoryCore`). Thin adapters map to each host's plugin API:

```
abmind (core library — IMemoryCore)
├── @abmind/ab-slot          → implements IMemorySlot for AB skeleton
├── @abmind/openclaw-plugin  → maps to OC register(api) — registerTool, registerContextEngine
└── @abmind/opencode-plugin  → maps to OpenCode plugin API — hooks, transforms, tools
```

One brain, multiple bodies. Each adapter is ~50-100 lines. The core never imports host-specific code.

Example OC adapter:
```typescript
// abmind-openclaw-plugin/index.ts
export default {
  id: "abmind",
  kind: "memory",
  register(api: OpenClawPluginApi) {
    const mem = createAbmind(api.pluginConfig);
    api.registerTool((ctx) => createRecallTool(mem, ctx.sessionKey));
    api.registerTool((ctx) => createStoreTool(mem, ctx.sessionKey));
    api.registerCommand(createAbmindCommand(mem));
    api.on("session_end", () => mem.flush());
  }
};
```
