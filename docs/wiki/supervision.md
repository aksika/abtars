# Process Supervision

In daemon mode, abTARS uses three layers to keep the bridge available and recover from process failures.

## Start, stop, and restart

~~~bash
abtars start
abtars stop
abtars restart
abtars restart --cold
~~~

Use abtars status to inspect the service. The --cold option starts a fresh bridge process.

## Three layers

| Layer | Role |
|------|------|
| **L1: Bridge heartbeat** | The running bridge records liveness and runs registered periodic tasks. |
| **L3: External watchdog** | The watchdog monitors the bridge process and heartbeat, then restarts the bridge when recovery is needed. |
| **L4: OS service manager** | launchd or systemd starts and supervises the watchdog. |

The heartbeat interval is configurable. L1 tasks do not replace the watchdog's process monitoring.

## Repeated failures

Repeated unplanned bridge deaths can trigger the boot circuit breaker to select the previous release. This is separate from the update health check: an update that reports an unhealthy release may require a manual rollback with abtars rollback.

See [Deploy Pipeline](/abtars/deploy) for update checks and rollback, and [Health Check](/abtars/healthcheck) for status and diagnostics.
