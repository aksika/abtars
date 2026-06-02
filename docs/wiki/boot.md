# Boot Phases

The bridge starts via 13 ordered phases. Each phase initializes one subsystem, logs its duration, and populates a shared `BootCtx` object.

## Phase sequence

| # | Phase | What it does |
|---|-------|-------------|
| 1 | config | Loads `.env`, builds Config + MemoryConfig, configures logger |
| 2 | memory | Creates and initializes MemoryManager |
| 3 | transport | Selects transport (ACP/API/tmux), builds FallbackPolicy + ModelHealthRegistry |
| 4 | memory-ipc | Wires LLM callback for memory, starts MemoryIpcServer |
| 5 | pipeline-deps | Creates CronQueue, PipelineDeps, CodingMode, IdleSave |
| 6 | platforms | Registers and starts Telegram + Discord (with background retry) |
| 7 | capabilities | Auto-discovers capabilities from manifests, starts MCP daemon |
| 8 | startup-notification | Sends "Back online" message, fires startup greeting |
| 9 | heartbeat | Writes bridge.lock, starts HeartbeatSystem (11 tasks), arms in-proc watchdog |
| 10 | sleep | Creates sleep handle for Dreamy |
| 11 | dashboard | Starts web UI (optional, failure non-fatal) |
| 12 | agent-api | Starts A2A HTTP server |
| 13 | shutdown | Registers SIGINT/SIGTERM handlers |

## Ordering invariant

Phase order is enforced by `src/boot/phase-order.test.ts`. Reordering requires updating the test in the same commit.

## Resilience

- **Dashboard is optional** — if phase 11 throws (port conflict, missing asset), bridge logs ERROR and continues without it
- **Platforms retry in background** — if Telegram/Discord can't connect in 15s, a non-blocking retry loop spawns with exponential backoff (15s → 300s cap)
- **All other phases are essential** — failure in memory, transport, or platforms crashes the bridge (correct behavior)

## BootCtx

Shared state container defined in `src/boot/context.ts`. Each phase reads what it needs and writes its outputs. After all phases, `syncBridgeFromCtx()` copies fields onto the Bridge instance for shutdown's use.

Test factory: `createBootCtx(overrides?)` — per-phase unit tests pass a partial ctx and assert field population.

## Startup log

On successful boot you'll see:

```
✓ config (12ms)
✓ memory (45ms)
✓ transport (230ms)
✓ memory-ipc (3ms)
✓ pipeline-deps (8ms)
✓ platforms (1200ms)
✓ capabilities (15ms)
✓ startup-notification (50ms)
✓ heartbeat (5ms)
✓ sleep (2ms)
✓ dashboard (18ms)
✓ agent-api (4ms)
✓ shutdown (1ms)
```
