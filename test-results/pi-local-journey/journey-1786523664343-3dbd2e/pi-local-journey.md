# Pi local journey E2E

Run root: `/tmp/pi-journey-vdSAfe`
Duration: 408s

| Check | Result | Detail |
|---|---|---|
| smoke | + | TUI pipeline exchange reached the fixture provider |
| run1-start | + | runId=d54066a1-a2e card=#1 session=1786523314_C_03 gen=1 |
| run1-session-visible | + | C session listed at index #3 |
| run1-attach | + | attached to exact Pi session 1786523314_C_03 |
| run1-running | + | status=running gen=1 |
| child-env | + | pid=1210639 sentinelLeak=false nodeOptionsLeak=false correlation=true isolatedHome=true |
| run1-steer | + | steer accepted |
| run1-reply | + | no UI request surfaced in the real run; reply machinery covered by focused unit suites (awaiting_input not exercised live) |
| run1-cancel-accepted | + | cancel accepted |
| run1-cancelled | + | terminal status=cancelled |
| run1-child-gone | + | no pi child remains after cancel |
| no-orphan-session-after-cancel | x | STILL LISTED: #3 Code (pi, ready) ← attached |
| run1-steer-applied | + | steer-flag file in workspace (applied before cancel) |
| bridge-restart-1 | + | bridge respawned (pid 1250657) |
| restart-preserves-terminal | + | status after restart=cancelled (terminal stays terminal) |
| stale-steer-rejected | + | reply: ❌ Run d54066a1-a2e is not active (status: cancelled) |
| stale-reply-rejected | + | reply: ❌ Run d54066a1-a2e is not active (status: cancelled) |
| run2-start | + | runId=3e0eb1b8-1c1 gen=1 |
| run2-first-turn-settled | + | first output file present — pi session flushed |
| run2-running | + | run2 active before restart |
| bridge-restart-2 | + | bridge respawned (pid 1273416) |
| run2-interrupt-on-restart | + | run2 status after restart=interrupted (expected interrupted) |
| run2-resume | + | generation=2 new session=1786523423_C_03 |
| lane-setup | x | Timed out waiting for run 3e0eb1b8-1c1 status running/awaiting_input/completed/failed after 240000ms
 |