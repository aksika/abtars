# Pi local journey E2E

Run root: `/tmp/pi-journey-yFmFe3`
Duration: 484s

| Check | Result | Detail |
|---|---|---|
| smoke | + | TUI pipeline exchange reached the fixture provider |
| run1-start | + | runId=86fed999-0d4 card=#1 session=1786404815_C_03 gen=1 |
| run1-session-visible | + | C session listed at index #3 |
| run1-attach | + | attached to exact Pi session 1786404815_C_03 |
| run1-running | + | status=running gen=1 |
| child-env | + | pid=320203 sentinelLeak=false nodeOptionsLeak=false correlation=true isolatedHome=true |
| run1-steer | + | steer accepted |
| run1-steer-applied | + | steer-flag file appeared in the workspace |
| run1-reply | + | no UI request surfaced in the real run; reply machinery covered by focused unit suites (awaiting_input not exercised live) |
| run1-cancel-accepted | x | run reached terminal status completed before cancel could be issued |
| bridge-restart-1 | + | bridge respawned (pid 320707) |
| restart-preserves-terminal | x | status after restart=completed (expected cancelled) |
| stale-steer-rejected | + | reply: ❌ Run 86fed999-0d4 is not active (status: completed) |
| stale-reply-rejected | + | reply: ❌ Run 86fed999-0d4 is not active (status: completed) |
| run2-start | + | runId=3ba8f3c5-e41 gen=1 |
| run2-running | + | run2 active before restart |
| bridge-restart-2 | + | bridge respawned (pid 320931) |
| run2-interrupt-on-restart | + | run2 status after restart=interrupted (expected interrupted) |
| run2-resume | x | resume reply: ❌ Pi session file not found at /tmp/pi-journey-yFmFe3/home/.pi/agent/sessions/--tmp-pi-journey-yFmFe3-workspace--/2026-08-10T23-34-41-766Z_019fee07-4566-7231-bcc9-733bc2de5161.jsonl |
| run4-start | + | runId=bc2394cc-7b4 gen=1 |
| run5-queued | + | runId=e7af57a7-7b1 (capacity 1 — expected queued) |
| run5-stays-queued | + | run5 status after create=queued (capacity held by run4) |
| run4-terminal | + | run4 terminal status=completed |
| run5-auto-start-on-release | x | run5 did NOT start within 75s after capacity release (contract violation candidate) |
| bridge-restart-3 | + | bridge respawned (pid 321862) |
| run5-preserved-queued | + | run5 status after restart=queued (preserved queued) |
| run5-woken-after-restart | x | run5 never started after restart (boot wake did not start the preserved queued run) |
| final-no-live-code-sessions | + | no live Code sessions remain |
| final-pi-children | + | pi children in run root: 0 |
| shutdown-no-orphan-process | + | pi --mode rpc children after shutdown: 0 |
| db-runs-terminal | x | 3ba8f3c5-e41:interrupted, 86fed999-0d4:completed, bc2394cc-7b4:completed, e7af57a7-7b1:queued |
| db-cards-terminal | x | #1:delivered, #2:running, #3:delivered, #4:failed |