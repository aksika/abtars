# Pi Integration

abTARS integrates with [Pi](https://github.com/earendil-works/pi) — a mature coding/session/model harness. Rather than compete, abTARS and Pi work as **symbiotic peers**: each runs standalone, runtime discovery bridges them. No master/slave, no npm dependency either way.

The adoption is **additive and reversible** — each Pi package plugs in beside existing paths. If a package breaks or goes away, abTARS keeps working.

## Architecture

Two value flows drive the integration:

**Flow A — Pi gains abTARS superpowers.** Pi loads abmind as a plugin for memory/soul/sleep in its TUI. Pi can also reach abTARS over A2A for messaging presence and task queueing.

**Flow B — abTARS gains Pi superpowers.** Pi's provider engine (pi-ai) becomes an optional L1 motor inside `DirectApiTransport`, unlocking ~36 providers and prompt caching. Pi's coding agent becomes a supervised subprocess for complex coding tasks.

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
