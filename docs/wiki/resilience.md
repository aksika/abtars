# Resilience

abTARS combines process supervision, provider availability memory, and release recovery. These mechanisms address different failure types.

## Process recovery

The bridge heartbeat, external watchdog, and operating-system service manager form the three-layer supervision system. The watchdog handles bridge process failure and stale heartbeats; the operating-system service manager supervises the watchdog.

See [Process Supervision](/abtars/supervision) for the layer responsibilities and lifecycle commands.

## Provider availability

Each Pi conversation dispatches exactly its configured model — there is no in-turn fallback chain, rotation, or health-scored candidate switching. When a provider fails, the failure is classified once, recorded in a durable availability memo, and surfaced as a typed terminal error. While every configured selection cools down, new turns are suppressed with a bounded reason and the memo's retry time; `/models health reset` clears all cooldowns immediately. Provider support and authentication must be configured for the candidate. The ACP route keeps its own try-next-model loop, and boot-time model selection still walks the configured list to find a working primary.

## Update and rollback behavior

abtars update stages and activates a release, then checks whether the bridge returns to a healthy state. An unhealthy result is reported for operator review; the health check itself does not immediately roll back the release. Use abtars rollback to choose a previous release when needed.

Repeated unplanned bridge deaths can separately trigger the boot circuit breaker to restore the previous release. See [Deploy Pipeline](/abtars/deploy) for update and manual rollback details.

## Health checks

Use abtars status, abtars doctor, and the bridge logs to investigate problems. See the [Health Check](/abtars/healthcheck) guide for common diagnostics.
