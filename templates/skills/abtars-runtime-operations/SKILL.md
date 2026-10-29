---
name: abtars-runtime-operations
description: Inspect and maintain the abTARS runtime, routing, skills, tasks, backups, and deployment state.
---

# abTARS Runtime Operations

Use this skill for questions or changes involving the running abTARS instance:
health, configuration, models, providers, skills, scheduled tasks, logs, backups,
updates, restarts, or deployment state.

## Safety rules

- Inspect first. Do not mutate runtime state because a problem is merely suspected.
- Runtime configuration changes, restarts, updates, restores, and deletions require
  an explicit operator request.
- Never print, copy, or paste secrets, tokens, cookies, private keys, or peer tokens.
- Use redacted commands and status/doctor output whenever possible.
- Never edit files under `~/.abtars-releases/`, `~/.abtars/app`, or deployed bundles.
- `skills/core/` and `prompts/` are deployment-managed and may be overwritten.
- Never use raw `pkill`, `kill -9`, or `launchctl bootout`; use the abTARS CLI.
- Do not modify watchdog thresholds, heartbeat behavior, or watchdog files.

## Runtime roots

Use the configured roots when present:

- `ABTARS_HOME` — writable runtime state; normally `~/.abtars/`
- `~/.abtars-releases/current` — active read-only release
- `~/.abtars-releases/src/` — deployment source checkout; do not edit on the host
- `~/.local/bin/` — CLI wrappers

If the root is uncertain, begin with:

```bash
abtars status
abtars doctor
abtars config
```

`abtars config` redacts values that look like credentials. Do not replace it with
`cat ~/.abtars/config/.env`.

## Runtime layout

| Path | Ownership and purpose |
|---|---|
| `config/.env` | Main environment configuration |
| `config/.env.skills` | Non-secret integration and skill settings |
| `config/transport.json` | Active route, providers, agent assignments, and fallbacks |
| `config/transport.old.json` | Previous transport configuration |
| `config/transport.default.json` | Factory/default transport configuration |
| `config/models.json` | Model metadata catalog, not active routing |
| `config/users.json` | User registry and platform identities |
| `config/peers.json` | Peer/API identities and access control |
| `config/abmind.json` | Optional abmind endpoint configuration |
| `config/budget.json` | Budget and usage limits |
| `config/pi-executor.json` | Pi executor settings |
| `config/sha-policy*.json` | Self-healer policy |
| `config/irc.json` | Optional IRC configuration |
| `secret/` | Encrypted or protected credentials; never expose contents |
| `skills/core/` | Shipped skills; overwritten during deployment |
| `skills/self/` | Agent-created skills |
| `skills/custom/` | Operator-provided skills |
| `skills/downloaded/` | Marketplace/downloaded skills |
| `skills/skills_catalog.md` | Generated skill index |
| `prompts/` | Deployment-managed prompt files |
| `tasks/tasks.json` | Scheduled task registry |
| `logs/` | Bridge, watchdog, and agent logs |
| `state/`, `kanban/`, `workspace/` | Runtime state and work data |
| `bridge.lock` | Process and heartbeat state |
| `deploy.state` | Deployment/restart state |
| `manifest.json` | Active deployment metadata |

## Models and transport

`models.json` is a catalog keyed by model ID. Entries may contain:

- `contextWindow`
- `maxOutput`
- `rank`
- `cost.input` and `cost.output`
- `transports`
- optional description, validation timestamps, and health status

`models.json` does not select the active model.

`transport.json` selects the active route and assigns models to roles such as
`main`, `dreamy`, `browsie`, and `cody`. It also defines providers, fallbacks,
transport defaults, model limits, and health policy.

Prefer the existing command surface:

```text
/models list
/models list <provider>
/models quick <model>
/models doctor
/models restore
/models default
```

`/models doctor` probes configured models and updates health metadata in
`models.json`.

If direct editing of `transport.json` is explicitly requested:

1. Back up the configuration.
2. Preserve the route, provider, and assignment structure.
3. Ensure every assigned model is compatible with its provider and route.
4. Do not place raw API keys in JSON.
5. Verify with `abtars doctor` and `abtars status`.
6. Restart only when requested or required by the changed setting.

## Common maintenance workflows

### Health check

```bash
abtars status
abtars doctor
abtars logs
```

Inspect recent logs only after the health commands identify a relevant subsystem.
Report unexpected failures separately from warnings that are known or inactive.

### Skills

- Source-controlled skills belong in the repository under `templates/skills/`.
- Runtime `skills/core/` is refreshed by deployment.
- Agent-created skills belong in `skills/self/`.
- Operator skills belong in `skills/custom/`.
- After changing a runtime skill, reload the catalog with `/skill reload`.
- Do not edit a core skill as a permanent runtime fix.

### Environment configuration

For an explicitly requested `.env` or `.env.skills` change:

1. Read only the relevant non-secret setting.
2. Preserve comments and unrelated values.
3. Never echo secret values.
4. Restart the affected service if the setting is read only at boot.
5. Verify with `abtars status`, `abtars doctor`, or a focused command.

### Tasks

Treat `tasks/tasks.json` as user-owned state. Inspect before editing. Preserve
existing task IDs, schedules, executors, and task-file paths. After a requested
change, verify that the JSON parses and that the task appears in the task status
view.

### Update and restart

Use the supported commands:

```bash
abtars update
abtars restart
abtars restart --cold
abtars stop
abtars start
```

Do not edit the active release directly. After an update, verify the active
version, heartbeat, bridge health, and dependency health.

### Backup

Before risky configuration, restore, or migration work, use the supported backup
command:

```bash
abtars backup --config
```

For a full or encrypted backup, follow the operator's explicit request. Never put
backup archives or secret contents into a public repository.

## Failure handling

When something is unhealthy:

1. Capture `abtars status`.
2. Run `abtars doctor` without `--fix`.
3. Inspect the relevant recent log.
4. Check the relevant configuration without exposing secrets.
5. Identify the root cause.
6. Propose or perform a targeted fix only when explicitly authorized.
7. Verify the same health checks after the change.

Do not hide errors, delete lock files, reset configuration, or disable watchdogs
just to make the status look healthy.
