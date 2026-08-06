# Pi Integration

abTARS integrates with [Pi](https://github.com/earendil-works/pi) — a mature coding/session/model harness. abTARS consumes Pi as a provider engine, a terminal UI, and a supervised coding subprocess; it does not load Pi into abmind or extend Pi with abtars features. No npm dependency either way.

The adoption is **additive and reversible** — each Pi package plugs in beside existing paths. If a package breaks or goes away, abTARS keeps working.

## Architecture

abTARS gains Pi superpowers: Pi's provider engine (pi-ai) becomes an optional L1 motor inside `DirectApiTransport`, unlocking ~36 providers and prompt caching. Pi's coding agent becomes a supervised subprocess for complex coding tasks.

```
                abtars
                  │
         ┌────────┼─────────┬──────────────────┐
         ▼        ▼         ▼                  ▼
     ACP path  DirectApi  TUI socket   PiExecutor
                 │         │            │
         ┌───────┴────┐    │      pi --mode rpc
         │ L0 reptile │ L1 │      Kanban-backed
         │ floor      │ pi-ai
         └────────────┘
```

- **L0 reptile floor** (always on) — the hand-rolled provider adapters. One model, one call. Never deleted.
- **L1 pi-ai motor** (flagged, opt-in) — loads Pi's provider engine at runtime. ~36 providers, prompt caching, model catalog.
- **L2 selection/fallback** — stays abTARS's own. Pi classifies, abTARS decides.

## Package adoption

| Package | What it does | Status |
|---------|-------------|--------|
| pi-ai | Provider engine (L1 motor) | `to_test` |
| pi-tui | Terminal UI rendering (client only) | `to_test` |
| pi-coding-agent | Coding delegation via RPC subprocess | `to_test` |
| pi-agent-core | In-process agent engine | Deferred |

Sub-chapters:
- [TUI (Terminal Interface)](/abtars/pi-tui) — how to use `abtars tui`
- [pi-ai Providers](/abtars/pi-providers) — enabling Pi-powered providers
- [Pi Executor](/abtars/pi-executor) — coding delegation via `/pi run`
