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

The heartbeat interval is configurable (`HEARTBEAT_INTERVAL_SEC`, default
60). L1 tasks do not replace the watchdog's process monitoring.

## Resume policy (`INSTALL_TYPE`)

After a suspend/wake cycle, `INSTALL_TYPE` decides whether the bridge exits
for a supervised restart or continues in place:

| `INSTALL_TYPE` | Behavior |
|---|---|
| `server` (default) | Daemon-mode bridge with an attached supervisor exits so the supervisor respawns it fresh |
| `notebook` | Always continues in place (laptops that sleep with no supervisor to respawn) |

Any other combination (simple mode, unsupervised process) continues in
place — the bridge never exits without someone to restart it. Unrecognized
values fall back to `server` with a warning.

## Repeated failures

Repeated unplanned bridge deaths can trigger the boot circuit breaker to select the previous release. This is separate from the update health check: an update that reports an unhealthy release may require a manual rollback with abtars rollback.

See [Deploy Pipeline](/abtars/deploy) for update checks and rollback, and [Health Check](/abtars/healthcheck) for status and diagnostics.
