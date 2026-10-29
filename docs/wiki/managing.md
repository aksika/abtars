# Managing the Bridge

## Start, stop, and restart

~~~bash
abtars start
abtars stop
abtars restart
abtars restart --cold
~~~

Daemon mode runs the watchdog under an operating-system service. Simple mode is started and stopped manually. See [Installation](./install.md) for the mode details.

## Status and diagnostics

~~~bash
abtars status
abtars doctor
abtars logs
~~~

Use the status and doctor output to check the bridge and service. The logs command follows the current bridge log.

## Uninstall

Use abtars uninstall to stop the bridge and remove its runtime data. The command asks for confirmation because it deletes the abTARS runtime directory. Back up any data you want to keep first.

See [Stop & Uninstall](./stop-uninstall.md) for uninstall details.
