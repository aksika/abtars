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

### Config-driven swap

```env
# Default — built-in dashboard
DASHBOARD_MODULE=

# Custom — any module that exports a class implementing IDashboardSlot
DASHBOARD_MODULE=./my-react-dashboard/index.js
```

Bridge loads the selected module at startup via dynamic import. If `DASHBOARD_MODULE` is unset, uses the built-in `DashboardServer`. If set, the built-in code never loads.

### Constructor contract

Custom modules must export a default class with this constructor:

```typescript
export class MyDashboard implements IDashboardSlot {
  constructor(opts: DashboardSlotOpts) { ... }
  async start(): Promise<void> { ... }
  async stop(): Promise<void> { ... }
}

interface DashboardSlotOpts {
  getStatus: () => StatusSnapshot;
  config: { port: number; host: string; authToken: string };
}
```

The bridge provides a status provider callback + basic config. The implementation decides how to expose it.

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Add `IDashboardSlot` + `DashboardSlotOpts` to `skeleton.ts` | 5 min |
| 2 | `DashboardServer implements IDashboardSlot` | 5 min |
| 3 | `DASHBOARD_MODULE` env var in `initDashboard()` — dynamic import | 10 min |
| 4 | Bridge field typed as `IDashboardSlot \| null` | 5 min |
| 5 | Conformance test | 5 min |
| **Total** | | **~30 min** |

## Template for full modularity

This is the pattern for all swappable slots:

| Slot | Env var | Default | Swap for |
|---|---|---|---|
| Dashboard | `DASHBOARD_MODULE` | DashboardServer | React SPA, Grafana, mobile |
| Tasks | `TASK_MODULE` | HeartbeatSystem | BullMQ, SQLite jobs |
| Skills | `SKILL_MODULE` | SkillWatcher | MCP-backed skill server |
| Platforms | `PLATFORM_MODULES` | Telegram, Discord | Slack, WhatsApp, Matrix |
| Memory | `MEMORY_MODULE` | abmind (MemoryManager) | Postgres, Redis |

Same pattern: interface → default → env var → dynamic import.

## Nice-to-haves

- [ ] `--web <module>` CLI flag as shorthand for `DASHBOARD_MODULE`
- [ ] Validation: check that loaded module actually implements IDashboardSlot (duck-type check on start/stop)
- [ ] Example custom dashboard in `examples/dashboard-minimal/` — bare-bones implementation showing the contract
- [ ] StatusSnapshot type exported from a shared types file (not buried in dashboard-config.ts)
