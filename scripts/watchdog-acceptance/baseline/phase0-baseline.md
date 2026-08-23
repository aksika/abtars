# Phase 0 baseline measurement (#1712)

- source commit: `e5d5831b86813c9e96a41a26fe91257d839e9305` (abtars `dev`)
- measured: 2026-08-23T22:03:29Z UTC
- platform: linux/x64, Node v22.22.0
- result: **22 pass / 10 known-fail / 1 advisory(A8, counted among the 22 passes)** — matches the reviewed expectation exactly
- cleanup confirmation: every scenario ended with zero registered processes and zero stray bridges in its homes (runner exit 0; cleanup failures would have failed the run)
- note: durations are compressed-profile timings, not production timing

| scenario | measured | classification | duration |
|---|---|---|---|
| A1 | pass | ok | 1.1s |
| A2 | pass | ok | 2.0s |
| A3 | pass | ok | 5.4s |
| A4 | pass | ok | 10.7s |
| A5 | pass | ok | 5.5s |
| A6 | pass | ok | 5.7s |
| A7 | pass | ok | 5.3s |
| A8 | pass | advisory | 9.0s |
| A9 | pass | ok | 1.7s |
| A10 | pass | ok | 0.9s |
| A11 | pass | ok | 0.9s |
| A12 | pass | ok | 2.5s |
| A13 | pass | ok | 0.9s |
| A14 | pass | ok | 3.5s |
| A15 | pass | ok | 1.9s |
| A16 | pass | ok | 0.9s |
| A17 | pass | ok | 7.2s |
| A18 | pass | ok | 2.1s |
| A19 | pass | ok | 1.2s |
| A20 | pass | ok | 1.9s |
| A21 | pass | ok | 4.7s |
| A22 | pass | ok | 6.1s |
| B1 | fail | ok-known-fail | 16.2s |
| B2 | fail | ok-known-fail | 6.9s |
| B3 | fail | ok-known-fail | 32.8s |
| B4 | fail | ok-known-fail | 26.1s |
| B5 | fail | ok-known-fail | 4.5s |
| B6 | fail | ok-known-fail | 30.8s |
| B7 | fail | ok-known-fail | 33.8s |
| B8 | fail | ok-known-fail | 25.5s |
| B9 | fail | ok-known-fail | 7.2s |
| B10 | fail | ok-known-fail | 22.6s |

## Falsification check

The draft's 22-pass/10-known-fail estimate is CONFIRMED by this first authoritative run:
no scenario flipped class in either direction. All B-scenarios failed for their declared
final-form reasons (bounded-decision absent B1; duplicate-on-corrupt-startup B2;
non-owner masking B3; forged exit codes B4; cross-home doctor scope B5; uncontained extras
B6/B7; outage-survivor adoption B8; unthrottled fault logging B9; metadata-induced defer B10).

A8 passed mechanically but stays `baseline-advisory`: SIGSTOP freezes the watchdog without
freezing the wall clock, so it cannot stand in for real suspend/darkwake (host smoke owns that).

Reproduce with: `npm run test:watchdog-acceptance`
