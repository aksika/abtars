# Backup & Restore

abtars provides daily automated backups and manual restore for disaster recovery and machine migration.

## Creating a backup

```bash
abtars backup
```

Output: `~/.backup-abtars/abtars-YYYYMMDD.zip`

The daily backup script (`scripts/daily-backup.sh`) runs automatically via cron. Manual backups use the same format.

### What's included

- `config/` — .env, transport.json, models.json, users.json, hooks.json, tasks/
- `secret/` — encrypted API keys and tokens
- `core/` — SOUL.md, user_profile.md, agent_notes.md
- `skills/` — core, custom, self-created, downloaded
- `agents/` — sub-agent rules
- `prompts/` — prompt templates
- `memory/` — daily summaries, retrospectives, sleep logs, topics
- `workspace/` — agent working directory

### What's NOT included

- `releases/` / `app/` — the runtime bundle (rebuilt on `abtars update`)
- `logs/` — ephemeral
- `memory.db` — backed up separately via `abmind backup`

## Restoring from backup

```bash
abtars restore <file.zip>
```

Extracts the backup zip into `~/.abtars/`, restoring all config, secrets, skills, and memory files. Does not touch the release bundle — run `abtars update` after restore if needed.

### Typical recovery flow (new machine)

```bash
npm install -g abtars abmind
abmind install --non-interactive --passphrase "your-passphrase" --username "your-name"
abtars install
abtars update
abtars restore ~/path/to/abtars-backup.zip
abmind restore --input ~/path/to/abmind-backup.abm --passphrase "your-passphrase" --username "your-name"
abtars restart --cold
```

### Typical recovery flow (same machine, wiped)

```bash
abtars install --force
abtars update
abtars restore ~/.backup-abtars/abtars-YYYYMMDD.zip
abtars restart --cold
```

## Memory backup (abmind)

Memory lives in `abmind`, not `abtars`. Back up separately:

```bash
abmind backup --output ~/my-memory-backup.abm
```

Restore:

```bash
abmind restore --input ~/my-memory-backup.abm --passphrase "your-passphrase" --username "your-name"
```

See [abmind Backup & Restore](https://aksika.github.io/abmind/backup) for full docs.

## Retention

The daily backup script keeps 7 days of zip files and auto-deletes older ones. For long-term retention, copy backups off-machine.

## Encryption

Secrets in the backup zip remain encrypted at rest (AES-256-GCM, encrypted by `abmind install`). The zip itself is not encrypted — store it securely.
<!-- rebuilt -->
<!-- 1780584420 -->
<!-- 1780585898 -->
