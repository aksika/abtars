# Report Pipeline E2E — e2e-1785193497335-afeb0da5

| ID | Milestone | Status | Scenario |
|----|-----------|--------|----------|
| M01 | Build identity is present | PASS | deployment |
| M02 | checkCron runs without throwing | PASS | scheduler |
| M03 | checkCron returns reserved task for due entry | FAIL | scheduler |
| M04 | reserveRun creates exclusive reservation | PASS | scheduler |
| M05 | settleActiveRun clears reservation | PASS | scheduler |
| M05b | Active run blocks stale advancement | PASS | scheduler |
| M06 | Structured report contract parses successfully | PASS | normalize |
| M07 | Invalid contract terminates before model execution | PASS | normalize |
| M07b | Non-report task rejects report contract | PASS | normalize |
| M07c | Legacy report task accepted without contract | PASS | normalize |
| M08 | Required file missing → preflight fails | FAIL | preflight |
| M08b | Required file present → preflight passes | FAIL | preflight |
| M09 | Missing executable → preflight fails | FAIL | preflight |
| M09b | Preflight rejects path escaping workspace | PASS | preflight |
| M10 | Task context directory exists | PASS | runner |
| M11 | Execution scope is scoped to task ID | PASS | runner |
| M12 | Run identity allocated before execution | PASS | scheduler |
| M13 | Execution control can be registered and removed | PASS | runner |
| M13b | requestCancel propagates cancellation | PASS | runner |
| M13c | markTerminal prevents duplicate settlement | PASS | runner |
| M14 | Kanban card created and started | PASS | runner |
| M15 | Pi host initializes | NOT_RUN | execution |
| M16 | Provider/model selection succeeds | NOT_RUN | execution |
| M17 | Provider receives deterministic response events | NOT_RUN | execution |
| M18 | Tool calls dispatch through Pi | NOT_RUN | execution |
| M19 | Tools read inputs and write inside scoped workspace | NOT_RUN | execution |
| M20 | No-progress detection classifies repeated failure | NOT_RUN | execution |
| M21 | Sole-candidate corrective recovery admitted once | NOT_RUN | execution |
| M22 | Candidate-round threshold does not stop sole candidate | NOT_RUN | execution |
| M23 | Prompt-wide limit yields structured diagnostic | NOT_RUN | execution |
| M24 | Kanban fail closes card | PASS | settlement |
| M25 | Failed execution writes one history event | PASS | settlement |
| M26 | appendRunOnce deduplicates by runId | PASS | settlement |
| M27 | Retry scheduled via setRetrying | PASS | retry |
| M28 | Prior failure context preserved for retry | PASS | retry |
| M29 | Retry reaches terminal state | PASS | retry |
| M30 | Deadline cancellation via exec control | PASS | timeout |
| M31 | History written for cancellation | PASS | settlement |
| M32 | Retry and active fields clear after terminal | PASS | settlement |
| M33 | Timestamps coherent after run | PASS | state |
| M34 | reconcileActiveTaskRuns clears stale active runs | PASS | state |
| M34b | Active run increments consecutiveFailures correctly | PASS | state |
| M35 | Rejects nonexistent artifact | PASS | artifact |
| M36 | Accepts valid fresh artifact | PASS | artifact |
| M37 | Rejects artifact with missing required heading | PASS | artifact |
| M38 | Rejects unchanged stale artifact | PASS | artifact |
| M38b | Rejects artifact with mtime before reservation | FAIL | artifact |
| M39 | kanbanComplete marks card done | PASS | settlement |
| M40 | Delivery claim succeeds on done card | PASS | delivery |
| M41 | Duplicate delivery claim rejected | PASS | delivery |
| M42 | Delivery preserves result_path | PASS | delivery |
| M43 | removeState clears all state for task | PASS | cleanup |
| M44 | Task phase changes loggable | PASS | observability |
| M45 | getTaskView has coherent definition+state+history | PASS | operators |
| M46 | daily-ai passes manual/scheduled/retry/delivery acceptance | NOT_RUN | production |
| M47 | weekly-ai passes manual/scheduled/retry/delivery acceptance | NOT_RUN | production |
| M48 | finance-daily passes manual/scheduled/retry/delivery acceptance | NOT_RUN | production |

**40/57 PASS** (5 FAIL, 0 BLOCKED, 12 NOT_RUN)