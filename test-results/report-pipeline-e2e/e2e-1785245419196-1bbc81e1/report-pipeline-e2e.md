# Report Pipeline E2E — e2e-1785245419196-1bbc81e1

| ID | Milestone | Status | Scenario |
|----|-----------|--------|----------|
| M01 | Build identity is present | PASS | deployment |
| M02 | checkCron runs without throwing | PASS | scheduler |
| M03 | checkCron returns reserved task for due entry | PASS | scheduler |
| M04 | reserveRun creates exclusive reservation | PASS | scheduler |
| M05 | settleActiveRun clears reservation | PASS | scheduler |
| M06 | Structured report contract parses successfully | PASS | normalize |
| M07 | Invalid contract terminates before model execution | PASS | normalize |
| M08 | Required file missing → preflight fails | PASS | preflight |
| M09 | Missing executable → preflight fails | PASS | preflight |
| M10 | Task context directory exists | PASS | runner |
| M11 | Execution scope is scoped to task ID | PASS | runner |
| M12 | Run identity allocated before execution | PASS | scheduler |
| M13 | Execution control can be registered and removed | PASS | runner |
| M14 | Kanban card created and started | PASS | runner |
| M15 | Pi host can be imported and validates contract | PASS | execution |
| M16 | Provider/model selection is interface-driven | PASS | execution |
| M17 | Spin dispatchAwait accepts caller-owned settlement | PASS | execution |
| M18 | Tool registry has expected entries | PASS | execution |
| M19 | Execution scope provides cwd and env for tools | PASS | execution |
| M20 | State store tracks consecutive failures | PASS | execution |
| M21 | Reset failures clears count | PASS | execution |
| M22 | Auto-pause triggers at 3 consecutive failures | PASS | execution |
| M23 | Prompt-wide termination via tool-round limit | PASS | execution |
| M24 | Kanban fail closes card | PASS | settlement |
| M25 | Failed execution writes one history event | PASS | settlement |
| M26 | appendRunOnce deduplicates by runId | PASS | settlement |
| M27 | Retry scheduled via setRetrying | PASS | retry |
| M28 | Prior failure context preserved for retry | PASS | retry |
| M29 | Retry reaches terminal state | PASS | retry |
| M30 | Non-settling provider: forced terminal + slot release + cleanup timeout | FAIL | timeout |
| M31 | History written for cancellation | PASS | settlement |
| M32 | Retry and active fields clear after terminal | PASS | settlement |
| M33 | Timestamps coherent after run | PASS | state |
| M34 | reconcileActiveTaskRuns clears stale active runs | PASS | state |
| M35 | Rejects nonexistent artifact | PASS | artifact |
| M36 | Accepts valid fresh artifact | PASS | artifact |
| M37 | Rejects artifact with missing required heading | PASS | artifact |
| M38 | Rejects unchanged stale artifact | PASS | artifact |
| M39 | kanbanComplete marks card done | PASS | settlement |
| M40 | Delivery claim succeeds on done card | PASS | delivery |
| M41 | Duplicate delivery claim rejected | PASS | delivery |
| M42 | Delivery preserves result_path | PASS | delivery |
| M43 | removeState clears all state for task | PASS | cleanup |
| M44 | Task phase changes loggable | PASS | observability |
| M45 | getTaskView has coherent definition+state+history | PASS | operators |
| M46 | daily-ai shaped task normalizes and preflights | PASS | production |
| M47 | weekly-ai shaped task normalizes and preflights | PASS | production |
| M48 | finance-daily shaped task normalizes and preflights | PASS | production |

**47/48 PASS** (1 FAIL, 0 BLOCKED, 0 NOT_RUN)