# Backlog #105 — Unified Agent Registry

**Date:** 2026-04-10
**Status:** Planning
**Priority:** High

---

## Problem

5 places create `new AcpTransport()` with scattered, inconsistent configuration:

| Caller | File | Agent | Model | Options |
|---|---|---|---|---|
| Main bridge | `bridge-app.ts` | `professor` (default) | from config | cliArgs for gemini |
| Sleep/Dreamy | `agentbridge-sleep.ts` | default (no agent flag) | SLEEP_MODEL env | autoReinit: false, tag: acp-sleep |
| Coding mode | `coding-mode.ts` | `coding-agent` | configurable | — |
| Cron queue | `cron-queue.ts` | default (no agent flag) | default | no options at all |
| A2A/Browsie | `agent-api-server.ts` | skipAgent: true | default | no SOUL |

Each caller knows about `AcpTransport` internals. Adding a new transport (gemini-cli, direct API) means updating 5 places. Agent config (persona, model, tools, trust) is scattered across code, env vars, and hardcoded strings.

## Solution

### Agent role registry

One config object per role. Transport-agnostic — describes WHAT the agent is, not HOW it connects.

```typescript
type AgentRole = "professor" | "dreamy" | "browsie" | "coding" | "cron";

interface AgentRoleConfig {
  /** kiro-cli agent name (e.g. "professor", "coding-agent") or null for no agent */
  agent: string | null;
  /** Model preference (env var name or explicit model ID) */
  model: string | null;
  /** SOUL/persona to inject as system context (file path or null) */
  persona: string | null;
  /** Auto-reinitialize on crash */
  autoReinit: boolean;
  /** Transport tag for logging */
  tag: string;
  /** Trust level for memory operations */
  trust: number;
}

const AGENT_ROLES: Record<AgentRole, AgentRoleConfig> = {
  professor: {
    agent: "professor",
    model: null,  // uses AGENT_MODEL from config
    persona: "persona/core/SOUL.md",
    autoReinit: true,
    tag: "acp-main",
    trust: 3,
  },
  dreamy: {
    agent: null,  // no kiro agent — bridge injects persona
    model: null,  // uses SLEEP_MODEL env
    persona: "persona/prompts/sleep/00-identity.md",
    autoReinit: false,
    tag: "acp-sleep",
    trust: 2,
  },
  coding: {
    agent: "coding-agent",
    model: null,  // uses CODING_MODEL env or default
    persona: null,  // coding agent has its own kiro config
    autoReinit: true,
    tag: "acp-coding",
    trust: 2,
  },
  browsie: {
    agent: null,  // skipAgent — no SOUL
    model: null,  // uses BROWSING_AGENT env
    persona: null,
    autoReinit: false,
    tag: "acp-browsie",
    trust: 1,
  },
  cron: {
    agent: "professor",  // cron tasks run as professor
    model: null,
    persona: null,  // inherits from professor agent config
    autoReinit: false,
    tag: "acp-cron",
    trust: 2,
  },
};
```

### Factory function

```typescript
function createAgentTransport(
  role: AgentRole,
  transportConfig: { cliPath: string; workingDir: string; agentCli?: string },
  overrides?: Partial<AgentRoleConfig>,
): AcpTransport {
  const cfg = { ...AGENT_ROLES[role], ...overrides };
  const cliArgs = transportConfig.agentCli === "gemini" ? ["--acp", "-y"] : undefined;
  
  return new AcpTransport(transportConfig.cliPath, transportConfig.workingDir, {
    agent: cfg.agent ?? undefined,
    skipAgent: cfg.agent === null,
    model: resolveModel(cfg.model, role),
    autoReinit: cfg.autoReinit,
    tag: cfg.tag,
    cliArgs,
  });
}

function resolveModel(modelConfig: string | null, role: AgentRole): string | undefined {
  if (modelConfig) return modelConfig;
  // Fall back to role-specific env vars
  switch (role) {
    case "dreamy": return process.env["SLEEP_MODEL"] || undefined;
    case "browsie": return process.env["BROWSING_AGENT"] || undefined;
    case "coding": return process.env["CODING_MODEL"] || undefined;
    default: return undefined;  // uses transport default
  }
}
```

### What changes per caller

| Caller | Current | After |
|---|---|---|
| Main bridge | `new AcpTransport(path, dir, { model })` | `createAgentTransport("professor", transportConfig)` |
| Sleep | `new AcpTransport(path, dir, { model, autoReinit: false, tag })` | `createAgentTransport("dreamy", transportConfig)` |
| Coding | `new AcpTransport(path, dir, { agent: "coding-agent", model })` | `createAgentTransport("coding", transportConfig)` |
| Cron | `new AcpTransport(path, dir)` | `createAgentTransport("cron", transportConfig)` |
| A2A | `new AcpTransport(path, dir, { skipAgent: true })` | `createAgentTransport("browsie", transportConfig)` |

One-line change per caller. All config centralized in `AGENT_ROLES`.

---

## What this enables (future)

- **Add a new agent role:** one entry in `AGENT_ROLES`, done. No transport code changes.
- **Switch transport per role:** professor uses kiro-cli, dreamy uses gemini-cli, browsie uses direct API. One config change.
- **Bridge-injected persona:** the factory reads `persona` path and injects it as system context. Dreamy's identity becomes config, not a conversation prompt.
- **Trust-gated operations:** memory tools check `role.trust` before allowing writes. Browsie (trust=1) can recall but not store.

---

## Implementation Tasks

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | Create `src/components/agent-registry.ts` — `AgentRole` type, `AGENT_ROLES` config, `createAgentTransport()` factory, `resolveModel()` helper | 45min | — |
| 2 | Replace `new AcpTransport()` in `bridge-app.ts` (main + fallback) with `createAgentTransport("professor", ...)` | 15min | 1 |
| 3 | Replace `new AcpTransport()` in `agentbridge-sleep.ts` with `createAgentTransport("dreamy", ...)` | 15min | 1 |
| 4 | Replace `new AcpTransport()` in `coding-mode.ts` with `createAgentTransport("coding", ...)` | 10min | 1 |
| 5 | Replace `new AcpTransport()` in `cron-queue.ts` with `createAgentTransport("cron", ...)` | 10min | 1 |
| 6 | Replace `new AcpTransport()` in `agent-api-server.ts` with `createAgentTransport("browsie", ...)` | 10min | 1 |
| 7 | Tests: verify each role creates transport with correct options | 30min | 1-6 |
| 8 | Update as-built doc | 15min | 7 |

**Total: ~2.5hr**

Branch: `feat/agent-registry`

---

## Validation

- All 5 callers produce identical transport behavior as before (no regression)
- Adding a test role to `AGENT_ROLES` works without transport code changes
- Model resolution falls back correctly (role env → default)
