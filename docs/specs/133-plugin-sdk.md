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

## Sequencing (staged)

| Stage | What | Backlog | Priority |
|---|---|---|---|
| 1 | Extract abmind core + publish npm. ab-slot + cli (already exist). IMemoryCore refactor. | #131 | MEDIUM |
| 2 | Decouple sleep into ISleepSlot. Formalize ISkillSlot, ITaskSlot. Config-driven loading. userId threading. | #132, #133 | HIGH |
| 3 | MCP server adapter — any MCP client gets abmind | #125 | MEDIUM |
| 4 | Ecosystem adapters: OpenClaw, OpenCode, Claude Code | #136 | LOW |

Each stage ships independently. Stage 1 changes nothing for the running system. Stage 2 is internal refactoring. Stage 3+ is reach.

## Multi-host adapter pattern

abmind core is host-agnostic (`IMemoryCore`). Thin adapters map to each host's plugin API:

```
abmind (core library — IMemoryCore)
├── @abmind/ab-slot          → implements IMemorySlot for AB skeleton
├── @abmind/openclaw-plugin  → maps to OC register(api) — registerTool, registerContextEngine
├── @abmind/opencode-plugin  → maps to OpenCode plugin API — hooks, transforms, tools
├── @abmind/claude-plugin    → maps to Claude Code plugin API — skills, hooks, MCP servers
├── @abmind/mcp-server       → MCP server exposing recall/store/edit as MCP tools (universal)
├── @abmind/cli              → standalone CLI (abmind recall/store/edit/status)
```

One brain, multiple bodies. Each adapter is ~50-100 lines. The core never imports host-specific code.

### Integration levels (deepest → shallowest)

| Adapter | Integration | Features | Overhead |
|---|---|---|---|
| `@abmind/ab-slot` | Direct in-process import | Full: sleep, emotion, contradiction, wake-up context, context injection, lifecycle hooks | Zero — native function calls |
| `@abmind/openclaw-plugin` | `register(api)` + hooks | Most: tools, context engine, lifecycle hooks, CLI. No emotion/sleep unless host supports it | Small — adapter mapping |
| `@abmind/opencode-plugin` | Hooks + transforms | Good: tools, dreamer integration, transforms. Different lifecycle model | Small — adapter mapping |
| `@abmind/claude-plugin` | Skills + hooks + MCP | Medium: tools via MCP, skills for agent guidance. Constrained by CC's plugin API | Medium — MCP serialization for tools |
| `@abmind/mcp-server` | MCP protocol (JSON-RPC) | Basic: recall/store/edit/search as MCP tools. No lifecycle hooks, no context injection, no sleep | High — full JSON-RPC serialization |
| `@abmind/cli` | stdin/stdout | Minimal: manual/scripted recall/store/edit. No runtime integration | Highest — process spawn per call |

Deeper = more features (sleep, emotion, context injection, contradiction checking).
Shallower = more portable but just basic recall/store — loses the "brain" features.

### Host plugin systems studied (2026-04-13)

| Host | Plugin contract | Memory approach |
|---|---|---|
| OpenClaw | `register(api)` — registerTool, registerContextEngine, hooks | memory-core + memory-lancedb plugins |
| OpenCode | Plugin hooks, transforms, tools, hidden agents | Magic Context: dreamer, historian, compartments |
| Claude Code | `BuiltinPluginDefinition` — skills, hooks, mcpServers | memdir: markdown files, 4 types (user/feedback/project/reference), team memory |
| Any MCP client | MCP protocol — tools, resources, prompts | MCP server exposes tools |
| CLI | stdin/stdout | Direct CLI invocation |

### Claude Code memory taxonomy (reference for #135)

Claude Code separates memories into 4 types:
- **user** — role, preferences, expertise (always private)
- **feedback** — corrections + confirmations on approach (private or team)
- **project** — ongoing work, goals, deadlines (bias toward team)
- **reference** — pointers to external systems (usually team)

Plus: private vs team scope, CLAUDE.md (project conventions), CLAUDE.local.md (personal).
Relevant for #135 (user vs project memory separation).

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
