---
name: abmind-runtime-operations
description: Inspect and maintain abmind memory, persona files, sleep, backups, encryption, and runtime health.
---

# abmind Runtime Operations

Use this skill for questions or changes involving the abmind runtime:
memory health, persona files, user profile, sleep maintenance, memory backups,
encryption, hooks, remote state, or the abmind service.

## Safety rules

- Inspect first and distinguish diagnosis from mutation.
- Never edit `memory.db` directly.
- Never run ad-hoc SQL against the live memory database.
- Database schema and migration changes require specific operator approval.
- Use the abmind CLI for memory, backup, restore, repair, and encryption work.
- Never print, copy, or paste `abmind.key`, `key.verify`, passphrases, or memory
  contents that were not requested.
- Restores, rekeying, attribution repair, bulk memory changes, and sleep application
  require an explicit operator request.
- Back up before destructive or difficult-to-reverse operations.

## Runtime roots

- `ABMIND_HOME` — abmind runtime root; normally `~/.abmind/`
- `MEMORY_DIR` — memory data directory; normally `~/.abmind/memory/`

Start with read-only checks:

```bash
abmind status
abmind doctor
abmind hook-doctor
```

If abmind is hosted by abtars, also check:

```bash
abtars status
abtars doctor
```

## Runtime layout

| Path | Ownership and purpose |
|---|---|
| `config/.env.memory` | Memory, embedding, retention, and sleep-related environment settings |
| `config/sleep.json` | Sleep step order, prompt names, budgets, and eligibility |
| `memory/core/SOUL.md` | Personalized agent identity and persona |
| `memory/core/user_profile.md` | User preferences and stable profile information |
| `memory/core/agent_notes.md` | Agent-maintained notes |
| `memory/core/core_facts.md` | Deployment and operational facts |
| `memory/core/memory-tools.md` | Memory tool instructions |
| `memory/memory.db` | SQLite memory database; never edit directly |
| `memory/memory.db-wal` | SQLite write-ahead log |
| `memory/memory.db-shm` | SQLite shared-memory file |
| `memory/daily/` | Daily consolidation files |
| `memory/weekly/` | Weekly consolidation files |
| `memory/quarterly/` | Quarterly consolidation files |
| `memory/sleep/` | Sleep locks and audit artifacts |
| `memory/working/` | Temporary consolidation work |
| `memory/garbage.json` | Pending garbage-collection information |
| `prompts/sleep/` | Source-controlled sleep prompts; refreshed by update |
| `secret/abmind.key` | Encryption key; never expose |
| `secret/key.verify` | Key verification material; never expose |
| `backups/` | Encrypted abmind backups |
| `logs/` | Runtime and sleep logs |
| `hooks/` | Hook sidecars and hook errors |
| `remote/` | Remote transport and client configuration |
| `manifest.json` | Install and identity metadata |
| `~/.local/lib/node_modules/` | Shared native dependencies outside `~/.abmind/` |

## Source versus runtime files

The live `~/.abmind/` tree is generated and maintained by abmind.

- `prompts/sleep/` is deployment-managed and may be overwritten by `abmind update`.
- `config/.env.memory` is seeded but operator-owned.
- `config/sleep.json` is seeded but operator-owned.
- Missing files under `memory/core/` may be seeded.
- `memory/core/SOUL.md` is personalized and must be preserved.
- Changes to shipped prompts belong in the abmind repository templates, not only
  in the live runtime directory.

## Configuration guidance

### `.env.memory`

Use it for memory and embedding settings such as:

- `MEMORY_DIR`
- `MEMORY_SEARCH_MODE`
- `MEMORY_MAX_DB_SIZE_MB`
- retention and aging settings
- embedding provider, model, URL, and dimensions
- ABM-L and context-tier settings
- sleep limits and quality

Before changing it:

1. Check the current value without exposing credentials.
2. Confirm the setting is supported by the current code.
3. Back up if the change affects retention, embeddings, or storage.
4. Restart the affected abmind or abtars service when required.
5. Run `abmind doctor` and verify memory status.

Never change database schema by inventing new variables.

### `sleep.json`

This file controls sleep steps. Preserve:

- `version`
- step names
- referenced prompt filenames
- timeout bounds
- `essential`
- `runOn`
- `requires`

Do not rename or remove a prompt file from the manifest without checking the
matching file under `prompts/sleep/`. Use `abmind sleep-state` and
`abmind sleep-report` to diagnose sleep behavior.

## Memory operations

Use the CLI instead of touching SQLite:

```text
abmind recall ...
abmind store ...
abmind edit ...
abmind messages ...
abmind bundle
abmind wake-up
```

For sleep maintenance:

```text
abmind sleep-state
abmind sleep-report
abmind sleep-apply --dry-run
abmind sleep --level basic|budget|normal|ultimate
```

`abmind sleep-apply` and `abmind sleep` may change memory state; run them only
when requested or when they are part of an explicitly approved maintenance task.

## Backup, restore, and encryption

Create a backup before restore, repair, rekeying, or bulk memory changes:

```bash
abmind backup
```

Use the supported commands for recovery:

```bash
abmind restore <backup>
abmind repair-attribution
abmind passwd
abmind rekey
```

Treat restore, attribution repair, passphrase changes, and rekeying as
operator-level operations. Inspect dry-run output and backup verification before
applying changes.

Never open or display key files. If encryption health is uncertain, use:

```bash
abmind doctor
abmind status
```

## Hooks and service health

For hook problems:

```bash
abmind hook-doctor
```

For runtime or service problems:

```bash
abmind status
abmind doctor
```

Inspect recent files under `~/.abmind/logs/` and `~/.abmind/hooks/` without
printing unrelated memory or secret contents.

If abmind is hosted by abtars, check both products before deciding which one is
broken. A bridge endpoint problem is not necessarily a database problem.

## Failure handling

When memory or sleep appears unhealthy:

1. Run `abmind status`.
2. Run `abmind doctor`.
3. Run `abmind hook-doctor` if hooks are involved.
4. Inspect the relevant recent log.
5. Check `config/.env.memory` and `config/sleep.json` without exposing secrets.
6. Check disk space and database/WAL presence.
7. Back up before any repair or restore.
8. Use the narrowest supported CLI operation.
9. Re-run health checks after the change.

Do not delete WAL files, sleep locks, core files, or the database to clear a
symptom.
