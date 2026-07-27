# Report Pipeline E2E — e2e-1785175847670-36abb4a9

| ID | Milestone | Status | Scenario |
|----|-----------|--------|----------|
| M01 | Build identity | PASS | deployment |
| M02 | Heartbeat invokes scheduler | PASS | deployment |
| M03 | Scheduler recognizes due task | PASS | deployment |
| M04 | One occurrence retains exclusive ownership | PASS | scheduler |
| M05 | Valid task enters queue once | PASS | scheduler |
| M06 | Structured report contract parses | PASS | normalize |
| M07 | Invalid contract terminates before model | PASS | preflight |
| M08 | Required input files validated | PASS | preflight |
| M09 | Required executables validated | PASS | preflight |
| M10 | Associated context is deterministic | PASS | preflight |
| M11 | Workspace scoped to run | PASS | preflight |
| M12 | Run identity allocated | PASS | scheduler |
| M13 | Execution control registered | PASS | runner |
| M14 | Kanban card created after preflight | PASS | runner |
| M15 | Pi host initializes | PASS | execution |
| M16 | Provider/model selection | PASS | execution |
| M17 | Provider response events | PASS | execution |
| M18 | Tool calls dispatch | PASS | execution |
| M19 | Tools can read/write workspace | PASS | execution |
| M20 | No-progress detection | PASS | execution |
| M21 | Corrective recovery | PASS | execution |
| M22 | Candidate-round threshold | PASS | execution |
| M23 | Prompt-wide limit yields diagnostic | PASS | execution |
| M24 | Failed execution closes resources | PASS | cleanup |
| M25 | Failed execution settles card once | PASS | settlement |
| M26 | Failed execution writes history | PASS | settlement |
| M27 | Retry bounded to one attempt | PASS | retry |
| M28 | Retry receives prior context | PASS | retry |
| M29 | Retry reaches terminal outcome | PASS | retry |
| M30 | Deadline reaches cancellation | PASS | timeout |
| M31 | Retry writes history | PASS | retry |
| M32 | Retry and active fields clear | PASS | settlement |
| M33 | Persisted timestamps coherent | PASS | state |
| M34 | Stuck run not advanced/duplicated | PASS | scheduler |
| M35 | Report artifact created | PASS | artifact |
| M36 | Artifact freshness proven | PASS | artifact |
| M37 | Structured acceptance evaluated | PASS | artifact |
| M38 | Validation precedes success | PASS | settlement |
| M39 | Successful settlement idempotent | PASS | settlement |
| M40 | Delivery after validation | PASS | delivery |
| M41 | Once delivery confirmed | PASS | delivery |
| M42 | Delivery retry without regenerate | PASS | delivery |
| M43 | Cleanup after all paths | PASS | cleanup |
| M44 | Logs reconstruct every stage | PASS | observability |
| M45 | Task listing agrees with state | PASS | operators |
| M46 | daily-ai end-to-end | PASS | production |
| M47 | weekly-ai end-to-end | PASS | production |
| M48 | finance-daily end-to-end | PASS | production |

**48/48 PASS** (0 FAIL, 0 BLOCKED, 0 NOT_RUN)