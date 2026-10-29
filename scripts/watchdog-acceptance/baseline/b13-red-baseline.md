# B13 red baseline (R8.2 correction)

B13 was born green: its scenario and the R2.1 fix landed in the same commit
(`9f724956`), so it never recorded a red baseline. This file documents the
retroactive red run required by spec 1712 R8.2 case 1.

## Measurement

- pre-fix commit: `730525282fb324477e1e48ff832dd7a0571fa333` (`9f724956^`)
- measured: 2026-08-24T14:36Z UTC
- platform: linux/x64, Node v22.22.0
- method: `git worktree` at the pre-fix commit; current harness sources copied
  over it, so the B13 scenario ran against pre-fix production code
- result: **fail** — verdict `ok-known-fail` against a temporary known-fail
  expectation (23.4s), i.e. the scenario is RED on pre-fix code

## Failure (final-form reason)

```text
[assertion] B13 final-form failure: doctor does not report the relative blocker
by PID (status=skipped detail="no bridge running")
```

The pre-fix watchdog blocked the spawn but silently: the log line

```text
Spawn withheld: occupied 1 exact same-home process(es) — refusing to create a duplicate
```

carries no PID, no argv, and no attribution reason, and `doctor` reports
nothing about the blocker. The Linux-visible reporting assertion was therefore
provable red before `9f724956`, exactly as the requirements state.

## Scope of this evidence

This proves the CI-provable half of B13 only (loud reporting of the blocked
PID/argv/reason). The macOS relative-argv attribution branch remains
structurally unexercisable in this suite (`/proc/<pid>/cwd` always answers on
Linux); its proof stays with the host-smoke item "macOS relative-argv
attribution" and is a hard precondition for any macOS deployment.
