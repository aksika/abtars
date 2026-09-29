# Resilience

abTARS combines process supervision, provider fallback, and release recovery. These mechanisms address different failure types.

## Process recovery

The bridge heartbeat, external watchdog, and operating-system service manager form the three-layer supervision system. The watchdog handles bridge process failure and stale heartbeats; the operating-system service manager supervises the watchdog.

See [Process Supervision](/abtars/supervision) for the layer responsibilities and lifecycle commands.

## Provider fallback

Each route can have an ordered list of fallback candidates in transport.json. When a model request fails, abTARS evaluates the next configured candidate using its provider health policy. Provider support and authentication must be configured for each candidate.

## Update and rollback behavior

abtars update stages and activates a release, then checks whether the bridge returns to a healthy state. An unhealthy result is reported for operator review; the health check itself does not immediately roll back the release. Use abtars rollback to choose a previous release when needed.

Repeated unplanned bridge deaths can separately trigger the boot circuit breaker to restore the previous release. See [Deploy Pipeline](/abtars/deploy) for update and manual rollback details.

## Health checks

Use abtars status, abtars doctor, and the bridge logs to investigate problems. See the [Health Check](/abtars/healthcheck) guide for common diagnostics.
