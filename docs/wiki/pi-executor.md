# Pi Executor — Coding Delegation

abTARS can run supervised coding tasks in a Pi RPC subprocess. The executor uses a configured workspace alias and reports the run status through abTARS.

## Requirements

- Pi installed and available to the abTARS service.
- pi-executor.json configured at ~/.abtars/config/pi-executor.json.
- Executor enabled in that file.

Pi is pinned to the tested 0.85.x line; see [Pi Integration](/abtars/pi).

## Enable a workspace

The installer seeds pi-executor.json with execution disabled. Add an alias for a workspace and enable the executor:

~~~json
{
  "enabled": true,
  "command": "pi",
  "maxConcurrent": 1,
  "maxWallClockMs": 1800000,
  "projectTrust": "never",
  "workspaceAliases": {
    "work": { "path": "/path/to/workspace" }
  }
}
~~~

Replace /path/to/workspace with an absolute path to a project directory. Only configured aliases can be used by a run. Review the project and its access before enabling execution.

## Commands

~~~text
/pi run --work work "review the error handling in this project"
/pi status 1
/pi list
/pi steer 1 "check the tests for edge cases"
/pi cancel 1
/pi resume 1
~~~

A run can be queued, running, awaiting input, completed, failed, or cancelled. Use /pi reply when a run requests input.

## Run history

abTARS records run state and progress so that an interrupted run can be inspected and explicitly resumed. A resume creates a new execution generation; it does not replay a goal automatically.
