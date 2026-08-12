# Pi local journey E2E

Run root: `/tmp/pi-journey-ewdLJm`
Duration: 314s

| Check | Result | Detail |
|---|---|---|
| smoke | + | TUI pipeline exchange reached the fixture provider |
| run1-start | + | runId=d21e0f47-282 card=#1 session=1786403262_C_03 gen=1 |
| run1-session-visible | + | C session listed at index #3 |
| run1-attach | + | attached to exact Pi session 1786403262_C_03 |
| run1-running | + | status=running gen=1 |
| child-env | + | pid=303305 sentinelLeak=false nodeOptionsLeak=false correlation=true isolatedHome=true |
| run1-steer | + | steer accepted |
| run1-steer-applied | + | steer-flag file appeared in the workspace |
| run1-reply | + | no UI request surfaced in the real run; reply machinery covered by focused unit suites (awaiting_input not exercised live) |
| lane-setup | x | Timed out waiting for run d21e0f47-282 status running/awaiting_input after 120000ms
 |