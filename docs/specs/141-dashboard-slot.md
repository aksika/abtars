# #141 Slot the Dashboard — IDashboardSlot

**Date:** 2026-04-14
**Status:** Planned
**Priority:** LOW

## Goal

Make the dashboard swappable via config. Users can replace the built-in web UI with their own implementation (React SPA, Grafana exporter, mobile push, headless metrics).

## Design

### Interface

```typescript
interface IDashboardSlot {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### DashboardSlotOpts — what ANY dashboard gets

```typescript
interface DashboardSlotOpts {
  getStatus: () => StatusSnapshot;
  port: number;
  host: string;
  authToken: string;
}
```

Minimal contract. The built-in `DashboardServer` gets extra deps (authGate, registry, memorySearchController, dashboardHtml) through its own constructor — those are internal, not part of the slot contract.

### Config-driven swap

```env
# Default — built-in dashboard (unset or empty)
DASHBOARD_MODULE=

# Custom — any module exporting a class implementing IDashboardSlot
DASHBOARD_MODULE=./my-react-dashboard/index.js
```

Bridge loads the selected module at startup via dynamic import. If unset, uses built-in `DashboardServer`. If set, built-in code never loads.

Custom module must export:
```typescript
export class Dashboard implements IDashboardSlot {
  constructor(opts: DashboardSlotOpts) { ... }
  async start(): Promise<void> { ... }
  async stop(): Promise<void> { ... }
}
```

### StatusSnapshot — re-export from types

Move `StatusSnapshot` (and its sub-types) from `dashboard-config.ts` to `src/types/status.ts`. Re-export from `src/types/index.ts`. Custom dashboard authors import from `agentbridge/types` instead of digging into internal files.

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Extract `StatusSnapshot` + sub-types to `src/types/status.ts` | 10 min |
| 2 | Add `IDashboardSlot` + `DashboardSlotOpts` to `skeleton.ts` | 5 min |
| 3 | `DashboardServer implements IDashboardSlot` | 5 min |
| 4 | `DASHBOARD_MODULE` env var in `initDashboard()` — dynamic import with duck-type validation | 10 min |
| 5 | Bridge field typed as `IDashboardSlot \| null` | 5 min |
| 6 | Conformance test + duck-type validation test | 10 min |
| **Total** | | **~45 min** |

## Duck-type validation

On load, check the module actually implements the interface:
```typescript
if (typeof mod.Dashboard?.prototype?.start !== "function" ||
    typeof mod.Dashboard?.prototype?.stop !== "function") {
  throw new Error(`DASHBOARD_MODULE does not implement IDashboardSlot`);
}
```

## Template for full modularity

Same pattern for all swappable slots:

| Slot | Env var | Default | Swap for |
|---|---|---|---|
| Dashboard | `DASHBOARD_MODULE` | DashboardServer | React SPA, Grafana, mobile |
| Tasks | `TASK_MODULE` | HeartbeatSystem | BullMQ, SQLite jobs |
| Skills | `SKILL_MODULE` | SkillWatcher | MCP-backed skill server |
| Platforms | `PLATFORM_MODULES` | Telegram, Discord | Slack, WhatsApp, Matrix |
| Memory | `MEMORY_MODULE` | abmind (MemoryManager) | Postgres, Redis |

## Nice-to-haves (included)

- [x] Duck-type validation on load
- [x] StatusSnapshot exported from shared types
- [ ] `--web <module>` CLI flag as shorthand for `DASHBOARD_MODULE` (deferred — CLI parsing is in main.ts, low value)
- [ ] Example minimal dashboard in `examples/dashboard-minimal/` (deferred — do when someone actually wants to swap)
