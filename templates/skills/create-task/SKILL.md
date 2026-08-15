---
name: create-task
description: Create and verify recurring or one-shot reminders, scripts, agent jobs, reports, and interactive skill launches.
tags: [tasks, workflow]
related: [task, skill-authoring]
---

# Create a Scheduled Task

Choose the task kind, register the definition, and verify it. Tasks are scheduler definitions under `~/.abtars/tasks/`; skills are reusable procedures loaded on demand.

## Choose the task shape

| Need | Definition |
|------|------------|
| Send fixed text | `kind: reminder`, `delivery: announce` |
| Run a shell command without a model | `kind: script` |
| Run one agent session and return text | `kind: agent`, `interaction.mode: oneshot`, `delivery: announce` |
| Generate and deliver a file | `kind: agent`, `interaction.mode: oneshot`, `delivery: report` plus a report contract |
| Start or resume a conversation | `kind: agent`, `interaction.mode: skill`, `delivery: announce` |
| Run an internal bridge action | `kind: system`, `delivery: silent` |

Use the CLI for simple reminders, scripts, system actions, and announce-mode agent oneshots. Advanced definitions such as reports, interactive launches, orchestration, follow-ups, or policy limits require a careful read/modify/write of `~/.abtars/tasks/tasks.json`.

## Common contract

- Use a lowercase kebab-case `id`. The CLI normalizes input and rejects duplicates.
- Set exactly one of `schedule` (five-field cron: `minute hour day month weekday`) or `at` (a parseable one-shot date/time). Include an explicit timezone offset in `at` when the intended timezone matters.
- Set `delivery` explicitly in hand-written JSON.
- Optional common fields are `enabled`, `priority` (`high`, `medium`, or `low`), `chatId`, `catchUpHours`, and `maxRunsPerDay`.
- Preserve every unrelated entry when editing `tasks.json`. It must remain a JSON array.
- Do not edit `task-state.json` or `task-history.jsonl`; the runtime owns them.
- Unknown top-level fields quarantine the affected definition. Use only these kind-specific fields:

| Kind | Kind-specific fields |
|------|----------------------|
| `reminder` | `text` |
| `agent` | `prompt`, `taskFile`, `agent`, `orchestration`, `interaction`, `report`, `maxToolRounds` |
| `script` | `command`, `followUp` |
| `system` | `action`, `options` |

## Create a simple task with the CLI

```bash
abtars-task add \
  --id daily-brief \
  --schedule "30 8 * * *" \
  --message "Give the daily brief for {today}." \
  --kind agent \
  --agent task \
  --chat-id <CHAT_ID>
```

Use `--at "2026-12-25T08:00:00+01:00"` instead of `--schedule` for a one-shot. For a packaged agent prompt, add `--task-file "~/.abtars/tasks/daily-brief/TASK.md"`.

The CLI supports `reminder`, `agent`, `script`, and `system`; for a system task, pass `--action sleep-cycle` or `--action hardware-sleep`. The CLI creates announce-mode agent oneshots only. Edit JSON for the advanced shapes below.

For a reminder, `--message` becomes its required `text`. For a script, `--message` becomes its required `command`; hand-written script definitions may also include `followUp: { "prompt": "...", "agent": "task" }`. Give every agent task a non-empty `prompt`, a valid `taskFile`, or both even though legacy oneshots may normalize without one. Hardware-sleep options are `idleMinutes` (1-240), `retryMinutes` (1-60), `latestLocalTime` (`HH:mm`), and `expectedWakeTime` (`HH:mm`); the latest time must precede the expected wake time.

## Package an agent task

```text
~/.abtars/tasks/daily-brief/
├── TASK.md
├── feeds.json
└── report-template.md
```

`TASK.md` is the main prompt and supports `{today}` substitution. Regular, non-hidden sibling files are injected as bounded context; directories, symlinks, backups, and temporary files are excluded. Keep the prompt focused and use absolute paths, one per bullet, in any definition-of-done file list.

Persistent notes between runs belong in `~/.abtars/workspace/<task-id>/CONTEXT.md`; up to 30,000 characters are injected on the next run.

## Agent oneshot

```json
{
  "id": "daily-brief",
  "kind": "agent",
  "agent": "task",
  "delivery": "announce",
  "schedule": "30 8 * * *",
  "prompt": "Give the daily brief for {today}.",
  "chatId": "<CHAT_ID>",
  "interaction": { "mode": "oneshot" },
  "orchestration": { "maxAgents": 1 },
  "enabled": true,
  "priority": "medium"
}
```

`agent` must be `task`, `professor`, `browsie`, `coding`, or `dreamy`. `orchestration.maxAgents` is 1-4 and includes the orchestrator; optional `laneDurationMs` is a positive integer. Use optional `maxToolRounds` only when a bounded tool budget is required.

## Reporting task

```json
{
  "id": "finance-report",
  "kind": "agent",
  "agent": "task",
  "delivery": "report",
  "schedule": "30 9 * * *",
  "prompt": "Write today's finance report to the contracted artifact path.",
  "chatId": "<CHAT_ID>",
  "interaction": { "mode": "oneshot" },
  "orchestration": { "maxAgents": 1 },
  "report": {
    "artifact": "~/.abtars/workspace/finance-report/output.md",
    "requiredSections": ["# Summary", "# Numbers"],
    "minBytes": 500,
    "requires": { "files": [], "executables": ["sqlite3"], "tools": [] }
  },
  "enabled": true,
  "priority": "medium"
}
```

The report artifact must use an absolute or `~/` path. `requiredSections` must contain at least one Markdown heading and `minBytes` must be an integer of at least 100. Preflight checks every required file, executable, and agent tool. Make TASK.md produce the exact headings and write into `~/.abtars/workspace/<task-id>/`; successful delivery is automatic.

## Interactive skill launch

First create and validate the persistent skill using `skill-authoring`. Then register its scheduled launch:

```json
{
  "id": "spanish-daily",
  "kind": "agent",
  "agent": "professor",
  "delivery": "announce",
  "schedule": "0 18 * * *",
  "prompt": "Start today's short Spanish tutoring session.",
  "chatId": "<CHAT_ID>",
  "interaction": {
    "mode": "skill",
    "skill": "tutor",
    "target": {
      "userId": "<USER_ID>",
      "platform": "telegram",
      "chatId": "<CHAT_ID>"
    }
  },
  "orchestration": { "maxAgents": 1 },
  "enabled": true,
  "priority": "medium"
}
```

Interactive launches require a valid skill identifier, an exact target with `userId`, `platform`, and `chatId` (plus optional `threadId`), at least one of `prompt` or `taskFile`, `delivery: announce`, and `orchestration.maxAgents: 1`. They forbid report contracts. A scheduled launch resumes the active session for the same target when one exists.

## Verify and manage

```bash
abtars-task validate                    # dry-run check before a whole-file edit goes live
abtars-task list
abtars-task history <id>
abtars-task pause <id>
abtars-task resume <id>
abtars-task remove <id>
```

After a read/modify/write of `tasks.json`, run `abtars-task validate` before
considering the file live. It checks every entry through the same parser the
scheduler uses, rejects duplicate IDs, verifies `taskFile` and
`report.requires.files` paths exist on disk, and reports orphaned task package
directories under `~/.abtars/tasks/` — all in one machine-readable JSON result
with exit code `0` only when clean. It never modifies files or task state. For
a staged tree, set `HOME` and `ABTARS_HOME` to match that tree before running.

After creation, confirm the normalized entry appears in `abtars-task list`. Trigger it with `/task run <id>` when an immediate run is appropriate, then inspect `abtars-task history <id>`. Never claim a task fired or delivered successfully without history or artifact evidence. Use `/tasks`, `/task pause <id>`, and `/task resume <id>` from chat for the corresponding operations.
