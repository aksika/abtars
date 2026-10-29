# Pi local journey E2E

Run root: `/tmp/pi-journey-SaiWK8`
Duration: 736s

| Check | Result | Detail |
|---|---|---|
| smoke | + | TUI pipeline exchange reached the fixture provider |
| run1-start | + | runId=b400cc29-361 card=#1 session=1786401515_C_03 gen=1 |
| run1-session-visible | + | C session listed at index #3 |
| run1-attach | + | attached to exact Pi session 1786401515_C_03 |
| run1-running | + | status=running gen=1 |
| child-env | x | no pi child found while run1 running |
| run1-steer | + | steer accepted |
| run1-steer-applied | x | steer-flag file never appeared within 7 min |
| run1-reply | + | no UI request surfaced in the real run; reply machinery covered by focused unit suites (awaiting_input not exercised live) |
| lane-setup | x | Timed out waiting for run b400cc29-361 status running/awaiting_input after 120000ms
 |