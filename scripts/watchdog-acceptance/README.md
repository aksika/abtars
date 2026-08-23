# Watchdog E2E Acceptance Harness (#1712 Phase 0)

Black-box acceptance boundary for the abtars watchdog and its supervision
cluster. It executes the REAL `scripts/abtars-watchdog.sh` (copied into a
temporary home), a supervisor-state CLI freshly bundled from current source,
real fixture bridge processes at the exact production spawn path
(`app/bundle/abtars.js`), and real OS processes/signals/flocks — against
isolated temporary application homes.

The harness is architecture-neutral: scenarios assert only externally
observable outcomes (processes, `bridge.lock`, `supervisor.state`,
`watchdog.log` events, exit statuses). A future watchdog redesign changes at
most the timing adapter, never the scenario contract.

## Commands

```bash
npm run test:watchdog-acceptance                        # manifest-gated run (~3 min)
npm run test:watchdog-acceptance -- --only A6           # one scenario, full evidence
npm run test:watchdog-acceptance -- --baseline          # measure outcomes, no manifest gating
npm run test:watchdog-acceptance -- --require-all-green # epic gate: rejects non-pass entries upfront
npm run test:watchdog-acceptance:selftests              # focused harness self-tests (vitest)
```

Scenarios run serially (they inspect process tables and exercise singleton
behavior). Exit codes: `0` all within expectation, `1` mismatch or failure,
`2` usage/manifest errors. An unexpected known-fail pass fails the run —
either production changed without updating evidence, or the scenario tests
nothing.

## Scoreboard semantics (`expected.json`)

- `pass` — must pass.
- `known-fail` — with owning ticket + reason; must keep FAILING its final-form
  assertion until the production defect is fixed. The commit that fixes the
  defect flips the entry to `pass`.
- `baseline-advisory` — temporarily non-gating but visibly non-green; today
  only A8 (its suspend simulation is a SIGSTOP gap; wall clock does not freeze).
  Real macOS suspend/darkwake remains host-smoke territory.

Baseline mode never writes expectations automatically. Corrections to
`expected.json` require proving the scenario still expresses final-form desired
behavior and recording evidence for the difference.

## Safety model

- Every harness-spawned process runs in a detached, registry-owned process
  group registered with PID + start identity. Signals are validated
  immediately before delivery; identity mismatch (PID reuse) aborts.
- Broad `pkill`/`killall`/unscoped `pgrep` cleanup is unimplementable through
  the registry API by construction.
- Cleanup escalates from bounded group SIGTERM to validated SIGKILL, sweeps
  stray bridges only inside harness-owned homes (cwd check), and fails the run
  if any registered process survives.
- Global interrupt/termination handlers run validated cleanup.
- Timing compression transforms COPIES inside temporary artifacts only;
  every replacement declares an exact expected match count, and drift aborts
  setup before anything spawns. The repository tree is never modified.

## When to run this suite

Append-only via `test:extended`. Changes touching any of these boundaries
require it:

- watchdog scripts/service definitions (`scripts/abtars-watchdog.sh`,
  plists, systemd units),
- `src/supervisor/**` (state machine, CLI, identity validation),
- bridge-lock transport ownership (`src/components/transport/bridge-lock-transport.ts`),
- `src/main.ts` lock/exit wiring.

## Host-smoke limits

Automated Phase 0 does NOT cover: real launchd/systemd restoration after
watchdog death, deliberately unloaded-service reporting, real macOS
suspend/darkwake, macOS process-start parsing, or uncompressed stale/resume
timing. Those remain explicit host-smoke steps owned by the epic plan.

## Layout

| File | Responsibility |
|---|---|
| `run.ts` | CLI, serial execution, scoreboard, exit policy |
| `contracts.ts` | Scenario/result/manifest/timing-profile types |
| `build.ts` | Temporary esbuild bundles + count-checked threshold adapters |
| `world.ts` | Temp-home lifecycle, controls, readers, predicate waits |
| `process-registry.ts` | Detached groups, identity validation, safe cleanup |
| `fixture-bridge.ts` | Bundled controllable bridge protocol actor |
| `proc-observers.ts` | /proc / ps observation adapters |
| `scoreboard.ts` | Manifest validation + verdict classification |
| `scenarios/preserved.ts` | A1-A22 |
| `scenarios/deficiencies.ts` | B1-B10 |
| `expected.json` | Reviewed expectation manifest (hand-maintained) |
| `baseline/` | Committed baseline evidence (see discipline below) |

## Baseline update discipline

`baseline/` stores measured evidence (source commit, platform, per-scenario
outcome/duration, classification, cleanup confirmation). It documents what
current code DOES; it never generates expectations. Divergence between a fresh
measurement and `expected.json` is resolved by human review of the scenario
and product state first.
