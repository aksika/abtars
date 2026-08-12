# Pi local journey E2E

Run root: `/tmp/pi-journey-Ohg5jc`
Duration: 470s

| Check | Result | Detail |
|---|---|---|
| smoke | + | TUI pipeline exchange reached the fixture provider |
| run1-start | + | runId=0b95120d-58f card=#1 session=1786403878_C_03 gen=1 |
| run1-session-visible | + | C session listed at index #3 |
| run1-attach | + | attached to exact Pi session 1786403878_C_03 |
| run1-running | + | status=running gen=1 |
| child-env | + | pid=311417 sentinelLeak=false nodeOptionsLeak=false correlation=true isolatedHome=true |
| run1-steer | + | steer accepted |
| run1-steer-applied | + | steer-flag file appeared in the workspace |
| run1-reply | + | no UI request surfaced in the real run; reply machinery covered by focused unit suites (awaiting_input not exercised live) |
| run1-cancel-accepted | x | run reached terminal status completed before cancel could be issued |
| bridge-restart-1 | + | bridge respawned (pid 312153) |
| restart-preserves-terminal | x | status after restart=completed (expected cancelled) |
| run1-resume | x | resume reply: ❌ Failed to queue resume generation: not_resumable |
| stale-steer-rejected | + | reply: ❌ Run 0b95120d-58f is not active (status: completed) |
| stale-reply-rejected | + | reply: ❌ Run 0b95120d-58f is not active (status: completed) |
| no-orphan-session-after-complete | + | no live Code session after terminal completion |
| run2-start | + | runId=6317de8c-4d2 gen=1 |
| run3-queued | + | runId=1ef0258d-267 (capacity 1 — expected queued) |
| run3-stays-queued | + | run3 status after create=queued (capacity held by run2) |
| run2-terminal | + | run2 terminal status=completed |
| run3-auto-start-on-release | x | run3 did NOT start within 75s after capacity release (contract violation candidate) |
| bridge-restart-2 | + | bridge respawned (pid 313379) |
| restart-run2-state | + | run2 status after restart=completed (terminal stays terminal; active becomes interrupted) |
| run2-interrupt-on-restart | x | run2 was already terminal before restart — interrupt path not exercised |
| run3-preserved-queued | + | run3 status after restart=queued (preserved queued) |
| lane-setup | x | Timed out waiting for run 1ef0258d-267 status starting/running/completed/failed after 240000ms
 |