# RA24 `exit=unknown` diagnosis evidence (#1722, Phase A)

**Outcome: fault NOT reproduced. No cause selectable. Fix phase remains gated.**

The bounded reproduction loop from `specs/1722/design.md` § Reproduction loop ran
to its full bound without capturing a single red. Per Task 3's stop rule, this
streak is recorded as the finding of Phase A; no fix is planned or permitted on
an unreproduced fault.

## Measured trees

| Tree | What ran |
|---|---|
| abtars `dev` @ `7851f115` + this instrumentation (3 files under `scripts/watchdog-acceptance/`) | all runs below |

Product sources (`src/**`, `scripts/abtars-watchdog.sh`) are untouched by the
diagnosis diff; the last product change to the watchdog path remains #1711/#1724
work already on `dev`.

## Red rate

- **Focused (`--only RA24`): 0 red / 25 runs** — the design loop, run to
  completion (console logs retained in `/tmp/opencode/ra24-1722/run-*.log`;
  per-run verdicts also in `.artifacts/run-results-*.json`).
- **Full REAL portfolio: 0 red / 1 run** — all 38 cases green, RA24 ok (4.8s),
  exit 0. This matches the conditions of one of the two historical reds.
- Historical comparison: 2 reds / 5 runs at the `9cb5c310`-era tree
  (`post-migration-1712-mr-portfolio.md` § RA24 note). The falsification session
  earlier on 2026-08-25 at `b4d905a3` additionally exercised the spawn/exit
  timing matrix without observing a rejection. Observed red rate today:
  **0 / 26**, against ~40% when the flake was filed.

## Instrumentation landed (durable for the next red)

1. `fixture-bridge.ts` records one synchronous JSON line per self-report attempt
   (`pid`, `generation`, `code`, `at`, `accepted`, `lockPidSeen`,
   `instanceIdSeen`) to `<home>/fixture-exit-attempts.jsonl` BEFORE
   `process.exit` — immune to the buffered-log drop identified in R2. The
   production call `writeOwnedExitFields(code, Date.now())` stays exactly where
   it was; only its previously discarded boolean return is now captured.
2. `world.ts` gains `exitAttempts(home)` and `captureDiagnostics(label,
   payload)`; `captureFailureDiagnostics(w, label)` is a free function so
   `contracts.ts` stays byte-identical.
3. A24 wraps its UNCHANGED assertions in try/catch → snapshot (lock, exit
   report, attempts, supervisor state, fixture registry, capped watchdog log,
   capped timeline) into `<world>/artifacts/RA24-1722-diagnostics.json`, then
   rethrows. Nothing is captured on green runs.

Probe validation (real bundle, real watchdog, A24 shape): the replacement's
attempt records `accepted=true` with `lockPidSeen === pid` and the fresh
`instanceIdSeen`; the watchdog then reads `process-gone:exit=3`. The write→read
chain works and is observable end-to-end.

## Discrimination readiness

No red means C1–C4 cannot be selected today. When a red occurs (any future run
of the harness), the diagnostics file lands automatically and maps onto the
design table:

| Observation in the file | Cause |
|---|---|
| last attempt `accepted=false`, `lockPidSeen !== pid` | C1 (pid gate) |
| `accepted=false`, pid matches, `instanceIdSeen` differs | C1 (instanceId gate) |
| `accepted=true`, failure lock lacks `lastExitCode`, instanceId differs from dead generation | C2 |
| `accepted=true`, failure lock HAS fresh `lastExitCode=3` but log says `exit=unknown` | C3 |
| third-pid death line or `exit=3` on `oldPid` | C4 |

One benign pattern observed in every GREEN run, so it is not mistaken for a
signal later: after the asserted `process-gone:exit=3` line, teardown kills the
settled successor and the watchdog logs a second `process-gone:exit=unknown`
line for it during cleanup. It appears in 26/26 green runs, never affects the
verdict, and is absent before the scenario's final assertion completes.

## Non-reproduction hypotheses (not conclusions)

- The original reds occurred on a loaded shared dev box; today's runs were
  effectively idle. If the trigger is scheduling pressure (e.g. the watchdog's
  death read racing the atomic lock replace under load — closest to C3), an
  idle box would suppress it.
- The instrumentation adds one synchronous append (~sub-ms) between the exit
  write and `process.exit`. By design it cannot reorder the production write,
  and death detection can only begin after exit, so it cannot close a
  write-vs-read race — but per design § Risks, "green only with instrumentation
  present" would itself be evidence for a timing-sensitive C3. That remains
  possible here and cannot be excluded without load-based reproduction.

## Verdict

Neither a product defect nor a harness defect is established. The ticket stays
gated: any fix work requires either (a) a captured red's diagnostics file
selecting a row of the table above, or (b) a new, explicitly approved
reproduction protocol (e.g. controlled load) with its own evidence.
