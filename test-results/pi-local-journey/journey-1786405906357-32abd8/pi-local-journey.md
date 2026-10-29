# Pi local journey E2E

Run root: `/tmp/pi-journey-0ZPMJJ`
Duration: 371s

| Check | Result | Detail |
|---|---|---|
| smoke | + | TUI pipeline exchange reached the fixture provider |
| run1-start | + | runId=c22d22ce-739 card=#1 session=1786405562_C_03 gen=1 |
| run1-session-visible | + | C session listed at index #3 |
| run1-attach | + | attached to exact Pi session 1786405562_C_03 |
| run1-running | + | status=running gen=1 |
| child-env | + | pid=326008 sentinelLeak=false nodeOptionsLeak=false correlation=true isolatedHome=true |
| run1-steer | + | steer accepted |
| run1-steer-applied | + | steer-flag file appeared in the workspace |
| run1-reply | + | no UI request surfaced in the real run; reply machinery covered by focused unit suites (awaiting_input not exercised live) |
| run1-cancel-accepted | x | run reached terminal status completed before cancel could be issued |
| bridge-restart-1 | + | bridge respawned (pid 326469) |
| restart-preserves-terminal | + | status after restart=completed (terminal stays terminal) |
| stale-steer-rejected | + | reply: ❌ Run c22d22ce-739 is not active (status: completed) |
| stale-reply-rejected | + | reply: ❌ Run c22d22ce-739 is not active (status: completed) |
| run2-start | + | runId=39b366a1-4af gen=1 |
| run2-first-turn-settled | + | first output file present — pi session flushed |
| run2-running | + | run2 active before restart |
| bridge-restart-2 | + | bridge respawned (pid 326753) |
| run2-interrupt-on-restart | + | run2 status after restart=interrupted (expected interrupted) |
| run2-resume | + | generation=2 new session=1786405666_C_03 |
| lane-setup | x | Timed out waiting for run 39b366a1-4af status running/awaiting_input/completed/failed after 240000ms
 |