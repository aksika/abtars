# Health Check

Use these commands to inspect the bridge and diagnose common problems.

## Status and doctor

~~~bash
abtars status
abtars doctor
abtars doctor --fix
~~~

Status reports the bridge and service state. Doctor checks the installation and can repair supported configuration or runtime issues with --fix.

## Logs

~~~bash
tail -f ~/.abtars/logs/bridge-$(date +%F).log
grep ERROR ~/.abtars/logs/bridge-$(date +%F).log | tail -20
abtars logs
~~~

## Telegram is not responding

Check whether the bridge is running, the Telegram platform is enabled, and its bot credential is configured. Then inspect the latest bridge log for Telegram polling errors.

## Memory is unavailable

abmind is optional and runs separately. If you use it, check its installation and run abmind doctor. For abTARS integration settings, see the abmind documentation.

## Model errors

Check the active route and model with abtars status. Confirm that the provider supports the selected model and that its authentication is configured. The local log includes transport startup and provider health messages.

## Bridge keeps restarting

Run abtars status and review the latest bridge and watchdog logs. Repeated unplanned bridge failures can trigger release recovery; see [Resilience](/abtars/resilience).

## Quick fixes

| Problem | Next step |
|---------|-----------|
| Bridge is stopped | Use abtars start, or check the service status in daemon mode. |
| Stale process or port conflict | Run abtars doctor --fix, then abtars restart --cold. |
| Provider is not ready | Check the provider entry, its apiKeyEnv name, and the matching local credential. Then run abtars doctor. |
| Memory unavailable | If abmind is installed, run abmind doctor and check its integration configuration. |
| Permissions issue | Run abtars doctor --fix. |

For update recovery, see [Deploy Pipeline](/abtars/deploy). For stopping or removing an installation, see [Stop & Uninstall](/abtars/stop-uninstall).
