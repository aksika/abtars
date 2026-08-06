---
name: create-task
description: How to create a scheduled task — common rules plus type-specific sections (agent oneshot, script, reporting, interactive)
tags: [tasks, workflow]
related: [task, create-skill]
---

# Create-Task

Author a new scheduled task: decide the type, then follow the common rules plus the section for that type. Tasks live in `~/.abtars/tasks/` — definitions only. A task fires on a schedule; a skill is loaded on demand.

## Decide the type first

| Type | Use when | Key marker |
|------|----------|------------|
| **Agent oneshot** (Section 1) | The agent runs a prompt or TASK.md once, replies to chat | `kind: agent`, no `interaction` |
| **Script** (Section 2) | A shell command runs directly, no model call | `kind: script` |
| **Reporting** (Section 3) | The agent produces a deliverable artifact delivered to chat | `delivery: report` + report contract |
| **Interactive** (Section 4) | The task launches a persistent conversational skill session (K) | `interaction: { mode: "skill" }` |
| Reminder | Simple scheduled text, no agent | `kind: reminder` |
| System | Internal bridge action (sleep-cycle, hardware-sleep) | `kind: system` |

## Common rules (every task)

### Location

```
~/.abtars/tasks/
├── tasks.json           # Registry: schedule, kind, taskFile (definitions only)
├── my-task/
│   ├── TASK.md          # Main prompt (agent kind) — {today} auto-substituted
│   ├── feeds.json       # Any sibling file auto-injected as context
│   └── report-template.md
```

All sibling files next to TASK.md are injected as context when the task runs. Runtime state (`task-state.json`, `task-history.jsonl`) is auto-managed — never edit it.

### Identifier and schedule

- `id`: lowercase kebab-case, `^[a-z][a-z0-9-]*[a-z0-9]$`. Normalized on add — duplicates rejected.
- Schedule: exactly one of `schedule` (cron: `minute hour day month weekday`) or `at` (ISO one-shot, e.g. `2026-12-25T08:00`). Both or neither is a definition error.
- Common fields: `enabled` (default true), `priority` (high|medium|low, default medium), `chatId`, `catchUpHours`, `maxRunsPerDay`.
- **Field strictness (#1569):** a key a kind does not define is a definition error, never ignored. Per-kind fields:

| Kind | Allowed fields (besides common) |
|------|---------------------------------|
| reminder | `text` (required, delivery must be `announce`) |
| agent | `prompt`, `taskFile`, `agent`, `orchestration`, `interaction`, `report`, `maxToolRounds` |
| script | `command` (required), `followUp` |
| system | `action` (sleep-cycle\|hardware-sleep, delivery must be `silent`), `options` |

### Delivery modes

| Mode | Behavior | Use for |
|------|----------|---------|
| `report` | Drop the result file to chat (no model call) | Reports, generated documents |
| `announce` | Send the agent's response text directly | Greetings, conversational tasks |
| `silent` | No output to user | Internal housekeeping, scripts |

### Creating

Via CLI:

```bash
abtars-task add \
  --id my-task \
  --schedule "0 9 * * *" \
  --message "Run my-task" \
  --kind agent \
  --agent task \
  --task-file "~/.abtars/tasks/my-task/TASK.md" \
  --chat-id <CHAT_ID>
```

Or write the JSON entry into `~/.abtars/tasks/tasks.json` directly (and for agent kind, the TASK.md). The registry is validated at load — a malformed entry quarantines loudly with an error, never degrades silently.

### Managing and verifying

```bash
abtars-task list                # Show all tasks
abtars-task remove <id>         # Delete a task
abtars-task pause <id>          # Pause
abtars-task resume <id>         # Resume
abtars-task history <id>        # Show run history
```

Telegram: `/tasks` (list), `/task run <id>` (trigger now), `/task pause <id>`, `/task resume <id>`. After adding, verify the entry appears in `abtars-task list` and, after the first run, in `history` — never claim it fired without checking.

---

## Section 1 — Agent oneshot task (default)

The agent runs the prompt or TASK.md once in a T session and the response is delivered.

```json
{
  "id": "daily-brief",
  "kind": "agent",
  "agent": "task",
  "delivery": "announce",
  "schedule": "30 8 * * *",
  "prompt": "Give the daily brief: weather, calendar, and one interesting fact. Use {today}.",
  "chatId": "7773842843",
  "enabled": true
}
```

Rules:
- `agent` must be one of: `task`, `professor`, `browsie`, `coding`, `dreamy`. It selects runtime agent/model config only — the session is always a T session.
- One of `prompt` or `taskFile` is the instruction; `taskFile` points at the TASK.md.
- `orchestration.maxAgents` (default 1, max 4, includes the Orc) for multi-agent runs; `laneDurationMs` optional per-lane budget. `maxToolRounds` optional.
- Keep TASK.md focused — one clear instruction per task.
- Persist notes between runs in `~/.abtars/workspace/<task-id>/CONTEXT.md` — it is injected as `[TASK CONTEXT]` on the next run (bounded at 30 KB).
- The DoD section in TASK.md must contain absolute paths only, one per bullet.

---

## Section 2 — Script task

A shell command runs directly on schedule. No model call.

```json
{
  "id": "nightly-backup",
  "kind": "script",
  "schedule": "30 0 * * *",
  "command": "tar -czf ~/backup.tar.gz ~/data",
  "delivery": "silent",
  "priority": "low",
  "enabled": true
}
```

Rules:
- `command` is required; `delivery` is normally `silent`.
- Optional `followUp: { "prompt": "...", "agent": "task" }` — a model prompt run after the command completes.

---

## Section 3 — Reporting task

An agent task whose deliverable is a file dropped to chat. Pair `delivery: report` with a **report contract** — both are validated strictly:

```json
{
  "id": "finance-report",
  "kind": "agent",
  "agent": "task",
  "delivery": "report",
  "schedule": "30 9 * * *",
  "prompt": "Run the finance report",
  "chatId": "7773842843",
  "report": {
    "artifact": "~/.abtars/workspace/finance-report/output.md",
    "requiredSections": ["# Summary", "# Numbers"],
    "minBytes": 500,
    "requires": { "files": [], "executables": ["sqlite3"], "tools": [] }
  },
  "enabled": true
}
```

Contract rules (violations fail preflight with a permanent definition error):
- `artifact` must be an **absolute or `~/` path** — never relative.
- `requiredSections` must be non-empty Markdown headings that must exist in the artifact.
- `minBytes` must be an integer ≥ 100.
- `requires.files` must exist; `requires.executables` must be on PATH; `requires.tools` lists agent tools.
- Write the artifact into `~/.abtars/workspace/<task-id>/` (or `reports/`) — the writable areas.
- TASK.md should structure the output with exactly the `requiredSections` headings; delivery is automatic — the task ends after the artifact is written.

---

## Section 4 — Interactive task (K skill session)

The task launches a **persistent conversational skill session** bound to one conversation target (userId + platform + chatId + threadId). The skill must exist and be interactive (has a valid `skill.json` — see the create-skill skill). Later user turns belong to the K session, not to this task's run lifecycle.

```json
{
  "id": "spanish-daily",
  "kind": "agent",
  "agent": "professor",
  "delivery": "announce",
  "schedule": "0 18 * * *",
  "prompt": "Start today's short Spanish tutoring session.",
  "chatId": "7773842843",
  "interaction": {
    "mode": "skill",
    "skill": "tutor",
    "target": {
      "userId": "ada",
      "platform": "telegram",
      "chatId": "42"
    }
  },
  "orchestration": { "maxAgents": 1 },
  "enabled": true
}
```

The target skill is a K-session skill (see the create-skill skill) — for the `tutor` skill used here: `skill.json` with `interactive: true`, `contextPath: "workspace/tutor/${userId}/CONTEXT.md"`, and a SKILL.md like `# Tutor — Teach Spanish using the Feynman method.` Its per-user memory lives in `~/.abtars/workspace/tutor/<userId>/CONTEXT.md`.

Constraints (all validated at normalize — any violation quarantines the entry):
- `delivery` must be `announce`.
- `orchestration.maxAgents` must be 1.
- No `report` contract allowed.
- `interaction.skill` must be a valid identifier (`^[a-z][a-z0-9-]*[a-z0-9]$`); `target` requires `userId`, `platform`, `chatId` (optional `threadId`).
- At least one of `prompt` or `taskFile` is required.
- A scheduled launch resumes an existing session for the same target if one is active; `maxToolRounds` and the 30-minute inactivity fallback do not apply to K-session turns.
