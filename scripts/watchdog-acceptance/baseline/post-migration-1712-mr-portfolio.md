# Post-migration evidence — #1712 M/R portfolio split

The migration run was recorded with HEAD at **9cb5c3106ad414b52c354fec888a04652ab40744**
and with the then-working-tree watchdog script changes that were subsequently
included in **6686e0da20f5178341b0dc0c2cd36235f180ea84**. The M/R migration
itself changes test/package/docs files, but the final landing tree also carries
a 239-line `scripts/abtars-watchdog.sh` change from the parallel #1711
implementation session. Therefore this artifact must not claim that #1712 is
production-source-clean; that #1711 change requires separate attribution and
review. The measured content is reproducible at 6686e0da.

- Platform: linux x64 (WSL), Node v22 (see run-results artifact for exact)
- M suite: 12/12 projections pass, 0.84–1.25s (median ~0.9s; final FAST phase
  0.99s) — saved starting observation was 13.4s; post-review M-only recheck
  remained 12/12 with `leak_scan=ok` in 1.98s
- FAST lane: M 0.99s + 16 fast R cases 43.8s, combined exit 0
- REAL: all 38 R cases executed serially under canonical RA01-RA24/RB01-RB14

## REAL outcomes (single complete run)

| ID | Verdict | Dur | ID | Verdict | Dur | ID | Verdict | Dur | ID | Verdict | Dur |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RA01 | ok | 2.2s | RA11 | ok | 2.2s | RA21 | ok | 4.7s | RB05 | ok-known-fail | 4.3s |
| RA02 | ok | 3.3s | RA12 | ok | 4.9s | RA22 | ok | 9.8s | RB06 | ok | 2.7s |
| RA03 | ok | 8.1s | RA13 | ok | 1.6s | RA23 | ok | 3.6s | RB07 | ok-known-fail | 33.8s |
| RA04 | ok | 12.9s | RA14 | ok | 3.9s | RA24 | unexpected-fail | 31.0s | RB08 | ok | 3.3s |
| RA05 | ok | 7.6s | RA15 | ok | 2.1s | RB01 | ok | 3.5s | RB09 | ok-known-fail | 7.4s |
| RA06 | ok | 7.8s | RA16 | ok | 1.8s | RB02 | ok | 21.8s | RB10 | ok-known-fail | 22.4s |
| RA07 | ok | 6.8s | RA17 | ok | 8.3s | RB03 | ok-known-fail | 3.4s | RB11 | ok-known-fail | 33.7s |
| RA08 | advisory | 10.0s | RA18 | ok | 2.9s | RB04 | ok-known-fail | 3.2s | RB12 | ok-known-fail | 15.1s |
| RA09 | ok | 4.2s | RA19 | ok | 1.8s | | | | RB13 | ok | 10.3s |
| RA10 | ok | 1.9s | RA20 | ok | 4.8s | | | | RB14 | ok | 19.7s |

37/38 verdicts match the reviewed manifest (A/B expectations unchanged;
B1-B14 known-fail entries still fail for their declared reasons).

## RA24 note — pre-existing flake, not migration-induced

RA24 red twice (full run + one focused) then green 3/3 focused at the same
committed tree. Root cause: the production exit-report freshness gate compares
epoch seconds (`lastExitAt / 1000 > SPAWNED_AT`); the fixture's scheduled exit
(delayMs 150) frequently lands in the same second as its spawn, so the report
is rejected and the death reads `exit=unknown`. Real bridges live far longer
and are unaffected. Product sources are identical before/after the migration,
and the same flake reproduces at the pre-migration measurement tree, so this is
a pre-existing harness/product-boundary race. Tracked separately in backlog
(see ticket filed with #1712's migration work); the manifest was NOT revised
to hide it.

## Cleanup confirmation

- Every REAL scenario cleanup ran in `finally`; zero registered processes
  survived any world; the run completed all 38 scenarios with no cleanup or
  harness failure.
- M suite post-run descendant scan: `leak_scan=ok` (no child process left
  behind; the scan is a read-only pgrep -P subtree walk, never a signal
  authority).

## Attribution and history preservation

- `expected.json.scenarios` stays keyed by A1-A24/B1-B14; `sourceCommit`
  unchanged; B13's red-baseline pointer and every owned entry's history are
  untouched (validated by the scoreboard self-tests).
- New output uses canonical RA/RB/MA/MB IDs; legacy `--only A9` spellings
  remain accepted aliases.
- The 12 M projections carry independent `mockScenarios` expectations; M never
  substitutes for its paired R contract, and no historical baseline file was
  rewritten.

## Extended-suite status

`npm run test:extended` could not complete on the shared dev box: its vitest
integration phase fails on pre-existing dev breakage unrelated to the watchdog
suite — `scheduled-project.integration.test.ts` (tracked in backlog #1714) and
`recall-quality.integration.test.ts` timeouts (tracked with the migration
work). The single complete REAL portfolio above is the required watchdog
evidence for this change.
