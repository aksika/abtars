# Pi local journey E2E

Run root: `/tmp/pi-journey-xxNQQU`
Duration: 802s

| Check | Result | Detail |
|---|---|---|
| smoke | + | TUI pipeline exchange reached the fixture provider |
| run1-start | + | runId=d03e1562-385 card=#1 session=1786523920_C_03 gen=1 |
| run1-session-visible | + | C session listed at index #3 |
| run1-attach | + | attached to exact Pi session 1786523920_C_03 |
| run1-running | + | status=running gen=1 |
| child-env | + | pid=1473614 sentinelLeak=false nodeOptionsLeak=false correlation=true isolatedHome=true |
| run1-steer | + | steer accepted |
| run1-reply | + | no UI request surfaced in the real run; reply machinery covered by focused unit suites (awaiting_input not exercised live) |
| run1-cancel-accepted | x | run reached terminal status completed before cancel could be issued |
| no-orphan-session-after-complete | x | STILL LISTED: #3 Code (pi, ready) ← attached |
| run1-steer-applied | + | steer-flag file in workspace (steer applied during run) |
| bridge-restart-1 | + | bridge respawned (pid 1501963) |
| restart-preserves-terminal | + | status after restart=completed (terminal stays terminal) |
| stale-steer-rejected | + | reply: ❌ Run d03e1562-385 is not active (status: completed) |
| stale-reply-rejected | + | reply: ❌ Run d03e1562-385 is not active (status: completed) |
| run2-start | + | runId=7e2aa89a-87c gen=1 |
| run2-first-turn-settled | + | first output file present — pi session flushed |
| run2-running | + | run2 active before crash |
| bridge-crash | + | bridge pid 1501963 SIGKILLed |
| crash-orphan-pi-child | + | no orphan pi child after crash |
| bridge-reboot-after-crash | + | bridge respawned (pid 1527268) |
| run2-recovery-on-boot | + | run2 status after crash+reboot=interrupted (expected interrupted) |
| run2-resume | + | generation=2 new session=1786524022_C_03 |
| run2-resume-running | + | post-resume status=running |
| lane-setup | x | Timed out waiting for run 7e2aa89a-87c status completed/failed after 600000ms
 |