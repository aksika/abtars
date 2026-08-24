# Watchdog E2E Acceptance Harness (#1712 Phase 0, M/R portfolio)

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

## Public case IDs

The public identifier is `M` or `R` plus a two-digit contract number. The A/B
key (`A1-A24`, `B1-B14`) remains the durable history key for `expected.json`
and git-backed born-green evidence; RA/RB are presentation/selection IDs:

| Identifier | Meaning |
|---|---|
| `RA09` | Real acceptance of contract A9 at the OS-process boundary. |
| `MA09` | Mock projection of the same contract at the shell-owned boundary. |
| `RB12` | Real-only acceptance of B12 — no meaningful MB12 projection exists. |

**M never substitutes for R.** The 12 registered projections assert only
shell-owned sub-invariants through the watchdog's source-only test seam
(`ABTARS_WATCHDOG_SOURCE_ONLY=1`); they start no bridge, CLI, or esbuild
process. Their manifest expectations are independent of their paired R cases:
a projection may pass while the real wiring remains a known failure. Paired
M and R cases share the contract number and desired behavior — nothing else.
A real-only contract without an MB entry is intentional, never a missing test.

Legacy spellings (`--only A6`) remain accepted as compatibility aliases; they
execute and report under the canonical R ID (`RA06`). New evidence should use
canonical IDs.

## Lanes

```bash
npm run test:watchdog:fast    # 12 M projections + the 16 FAST R cases
npm run test:watchdog:slow    # the remaining 22 SLOW R cases
npm run test:watchdog:real    # all 38 R cases (manifest-gated)
npm run test:watchdog:all     # FAST then full REAL as an explicit portfolio check
```

- **FAST R:** RA01, RA02, RA10, RA11, RA13, RA14, RA15, RA16, RA18, RA19,
  RA23, RB03, RB04, RB05, RB06, RB08 — cheap real scenarios per the saved
  timing data.
- **SLOW R:** the complement within the 38-case portfolio (16+22=38),
  explicitly including RA08. Omitting RA08 would silently reduce the real
  suite to 37 contracts. A slow real case is never removed because its M
  projection exists.
- **Mock:** MA08, MA09, MA12, MA20, MA21, MA24, MB02, MB09, MB10, MB11,
  MB13, MB14 — exactly these twelve; no placeholder entries are manufactured.

All scenarios run serially inside a lane (process-table inspection, singleton
behavior).

## Commands

```bash
npm run test:watchdog:real -- --baseline                # measure outcomes, no manifest gating
npm run test:watchdog:real -- --only RA06               # one scenario, full evidence (legacy "A6" works)
npm run test:watchdog:real -- --require-all-green       # epic gate: rejects non-pass entries upfront
npm run test:watchdog:real -- --suite fast              # just the fast R subset
npm run test:watchdog-acceptance                        # compatibility alias for REAL
npm run test:watchdog-acceptance:selftests              # focused harness self-tests (vitest)
npm run check:watchdog-shape                            # separate shell-shape self-check (not an M case)
```

Exit codes: `0` all within expectation, `1` mismatch or failure, `2`
usage/manifest errors. An unexpected known-fail pass fails the run — either
production changed without updating evidence, or the scenario tests nothing.

## Scoreboard semantics (`expected.json`)

Real scenarios live under `scenarios` keyed by their stable A/B keys;
mock projections live under `mockScenarios` keyed by MA/MB ID with
`contract`, `pairedReal`, `projection`, and their own expectation fields.

- `pass` — must pass.
- `known-fail` — with owning ticket + reason; must keep FAILING its final-form
  assertion until the production defect is fixed. The commit that fixes the
  defect flips the entry to `pass`.
- `baseline-advisory` — temporarily non-gating but visibly non-green. Not
  restricted to A8: any assertion this suite structurally cannot fail on the
  CI platform may be advisory, but its reason must name the platform limit and
  the host-smoke item that actually proves it (R8.2).

**Born-green rule (R8.2):** a defect-linked scenario (one carrying an `owner`)
must never appear for the first time already marked `pass`. Either land it
`known-fail`, measure it red against the pre-fix commit, and flip it to `pass`
in the fix commit, or attach a `redBaseline {commit, evidence}` pointer to a
red run already measured (see `baseline/b13-red-baseline.md`). Only if the
defect branch is structurally unreachable in CI is `baseline-advisory` the
correct state. The runner enforces this via git history of `expected.json`. A
new passing M projection is NOT red-baseline evidence for its R pair and does
not inherit the R owner's coverage claim.

**`sourceCommit` discipline (R8.1):** `--baseline` prints the commit it
measured at; whoever commits revised expectations records that commit in
`expected.json` → `sourceCommit`. A null `sourceCommit` is a hard failure
under `--require-all-green`: release-gating against unattributable
expectations is not evidence.

Baseline mode never writes expectations automatically. Corrections to
`expected.json` require proving the scenario still expresses final-form desired
behavior and recording evidence for the difference. The committed Phase 0
baselines and their born-green history are preserved while public case IDs
migrate; relabelling alone never revises an expectation.

## Safety model

- Every harness-spawned process runs in a detached, registry-owned process
  group registered with PID + start identity. Signals are validated
  immediately before delivery; identity mismatch (PID reuse) aborts.
- Broad `pkill`/`killall`/unscoped `pgrep` cleanup is unimplementable through
  the registry API by construction.
- Cleanup escalates from bounded group SIGTERM to validated SIGKILL, sweeps
  stray bridges only inside harness-owned homes (cwd check), and fails the run
  if any registered process survives. Each M case additionally proves it left
  no descendant process behind.
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

`test:watchdog:fast` is the everyday edit loop for those same boundaries.

## Host-smoke limits

Automated Phase 0 does NOT cover: real launchd/systemd restoration after
watchdog death, deliberately unloaded-service reporting, real macOS
suspend/darkwake, macOS process-start parsing, macOS relative-argv attribution
(R2.1/B13 — `/proc/<pid>/cwd` always answers on Linux, so the suite cannot
exercise that branch; proving it on the real host is a HARD precondition for
any macOS deployment), or uncompressed stale/resume timing. Those remain
explicit host-smoke steps owned by the epic plan.

## Layout

| File | Responsibility |
|---|---|
| `run.ts` | R CLI, serial execution, suite selection, scoreboard, exit policy |
| `fast.ts` | FAST orchestrator: selected M shell cases, then fast R cases |
| `contracts.ts` | Types, public M/R IDs, lanes, runner CLI contract |
| `build.ts` | Temporary esbuild bundles + count-checked threshold adapters |
| `world.ts` | Temp-home lifecycle, controls, readers, predicate waits |
| `process-registry.ts` | Detached groups, identity validation, safe cleanup |
| `fixture-bridge.ts` | Bundled controllable bridge protocol actor |
| `proc-observers.ts` | /proc / ps observation adapters |
| `scoreboard.ts` | Manifest validation (+ mock section) + verdict classification |
| `scenarios/preserved.ts` | A1-A24 definitions |
| `scenarios/deficiencies.ts` | B1-B14 definitions |
| `expected.json` | Reviewed expectation manifest incl. M projections (hand-maintained) |
| `baseline/` | Committed baseline evidence (see discipline below) |

The M executor itself lives beside the seam it checks:
`scripts/abtars-watchdog.test.sh` (selectable MA/MB cases, one machine-readable
row each).

## Fixture fidelity note (#1719)

The `refuse-duplicate` fixture mode mirrors ONLY the production duplicate-gate
boundary: validate the current lock owner before `initBridgeLock`, exit
non-zero, never write a fresh `instanceId`. It does not reproduce the full
boot graph — assertions must keep inferring ownership from `bridge.lock`
identity fields and process evidence, never from the fixture's internals.

## Baseline update discipline

`baseline/` stores measured evidence (source commit, platform, per-scenario
outcome/duration, classification, cleanup confirmation). It documents what
current code DOES; it never generates expectations. Divergence between a fresh
measurement and `expected.json` is resolved by human review of the scenario
and product state first.
