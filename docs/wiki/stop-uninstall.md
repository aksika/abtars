# Stop and Uninstall

## Stop the bridge

~~~bash
abtars stop
~~~

Use abtars status to confirm the bridge and watchdog have stopped. In daemon mode, the CLI coordinates with the service so it does not immediately restart the bridge.

## Uninstall abTARS

Back up configuration or task data you want to keep, then run:

~~~bash
abtars uninstall
~~~

The command asks you to confirm before deleting the abTARS runtime directory. It also removes the abTARS CLI symlinks. It leaves the source checkout untouched.

To skip the interactive confirmation in an automated uninstall, pass --yes:

~~~bash
abtars uninstall --yes
~~~

## Remove the CLI package

If you also want to remove the globally installed npm package, run:

~~~bash
npm uninstall -g abtars
~~~

abmind is independent. If it is installed, follow its documentation to back it up or uninstall it separately.
