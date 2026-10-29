# Boot

The bridge starts through a parallel dependency graph. Subsystems declare
their dependencies and run as soon as they resolve — memory, transport,
and platforms boot in parallel after config. Each node populates one
field on the shared `BootCtx` object.

## Boot graph

Declared in `src/boot/boot-nodes.ts`:

```
            config (required)
         /    |    \       \
  heartbeat  platforms  transport  memory
      |         \        /    \       \
   dashboard  pipelineDeps  capabilities ...
                   |
                agentApi
```

Full node list: `heartbeat`, `platforms`, `transport`, `memory`,
`pipelineDeps`, `capabilities`, `sleep`, `power`, `dashboard`,
`agentApi`, `piExecutor`, `reconciler`, `sessionControl`.

Notes:

- The old `memoryIpc` node is removed — the daemon replaces the
  `MemoryIpcServer` fallback.
- The sleep node dispatches the sleep cycle; power owns the separate
  hardware-sleep action; the reconciler owns bridge-generation lifecycle;
  `piExecutor` composes the supervised Pi coding service.
- Capabilities (hotskills, sleep) register from a generated registry, not
  a runtime directory scan.

## Ordering invariant

Graph integrity is enforced by `src/boot/phase-order.test.ts`: no cycles,
every dependency names an existing node, and the phase list matches the
node names. Reordering requires updating the test in the same commit.

## Resilience

- **Dashboard is optional** — if it throws (port conflict, missing asset), the bridge logs ERROR and continues without it
- **Platforms retry in background** — if Telegram/Discord can't connect in 15s, a non-blocking retry loop spawns with exponential backoff (15s → 300s cap)
- **Essential nodes crash the bridge** — failure in memory, transport, or the pipeline crashes the bridge (correct behavior)

## BootCtx

Shared state container defined in `src/boot/context.ts`. Each node reads what it needs and writes its outputs. After all nodes settle, `syncBridgeFromCtx()` copies fields onto the Bridge instance for shutdown's use.

Test factory: `createBootCtx(overrides?)` — per-node unit tests pass a partial ctx and assert field population.
