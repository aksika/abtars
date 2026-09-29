# Backup & Restore

abtars provides automated backups and restore for disaster recovery and machine migration.

## Creating a backup

```bash
abtars backup
```

Output (in `~/.backup-abtars/`):
- `abtars-YYYY-MM-DD.zip` — full system backup (config + data + abmind tree)
- `abmind-YYYY-MM-DD.abm` — encrypted memory backup

### Modes

| Command | What's backed up |
|---------|-----------------|
| `abtars backup` | Everything minus binaries + encrypted memory (.abm) |
| `abtars backup --config` | Config dirs only (lightweight, no memory) |

### Flags

| Flag | Description |
|------|-------------|
| `--config` | Config-only mode (fast, small) |
| `--encrypt` | Encrypt the zip archive for safer storage or transfer |
| `--output <dir>` | Custom output directory (default: `~/.backup-abtars/`) |
| `--prune-days N` | Retention period in days (default: 7, 0 = no prune) |

### Full backup includes

Everything in `~/.abtars/` **except** binaries and runtime:
- `config/` — transport.json, models.json, users.json, peers.json
- `secret/` — API keys and tokens
- `skills/` — core, custom, self-created, downloaded
- `core/` — prompts, personality, skills catalog
- `agents/` — sub-agent definitions
- `tasks/` — task definitions and scheduled entries
- `state/` — runtime state
- `workspace/` — agent working directory
- `scripts/` — deploy scripts

Plus `~/.abmind/` tree (excluding raw DB) and a WAL-safe copy of `memory.db`.

### Full backup excludes

- `releases/`, `current/`, `bin/`, `app/` — rebuilt by `abtars update`
- `logs/` — ephemeral
- `node_modules/` — dependency cache
- Runtime files: `*.sock`, `*.db-wal`, `*.db-shm`, `bridge.lock`, `watchdog.lock`

### Config-only backup includes

- `config/`, `secret/`, `tasks/`, `skills/`, `core/`, `agents/`

No memory, no abmind, no workspace. Filename: `abtars-config-YYYY-MM-DD.zip`.

### Encryption

The memory archive is created by abmind; see its documentation for its storage and restore format. The abTARS zip is plaintext by default. It contains configuration and may include credentials, so protect it or use `--encrypt` before moving it off the machine:

```bash
abtars backup --encrypt
```

The `--encrypt` option requires abmind to be installed and configured.

## Restoring from backup

```bash
abtars restore <file>
```

Auto-detects file type and does the right thing:

| Input file | Behavior |
|------------|----------|
| `.zip` / `.7z` | Extract to `~/.abtars/` + find sibling `.abm` → restore memory too |
| `.abm` | Delegate to `abmind restore --mode merge` |
| `.enc` | Restore sibling `.abm` first (creates key) → decrypt → extract |

### Flags

| Flag | Description |
|------|-------------|
| `--config` | Restore zip only, skip abmind memory |
| `--passphrase <value>` | Passphrase supplied to abmind when restoring memory, if required |

### Sibling detection

Backup produces paired files: `abtars-2026-06-05.zip` + `abmind-2026-06-05.abm`. On restore, abtars finds the matching `.abm` by date in the same directory and restores both automatically.

### Examples

```bash
# Restore everything when abmind is already set up
abtars restore ~/.backup-abtars/abtars-2026-06-05.zip

# Config only (skip memory)
abtars restore ~/.backup-abtars/abtars-config-2026-06-05.zip --config

# Restore encrypted backup on fresh machine
abtars restore ~/abtars-2026-06-05.zip.enc --passphrase "$ABMIND_RESTORE_PASSPHRASE"

# Restore just memory
abtars restore ~/.backup-abtars/abmind-2026-06-05.abm
```

## Disaster recovery (fresh machine)

```bash
# 1. Install
npm install -g abtars abmind
abmind install --non-interactive --passphrase "$ABMIND_PASSPHRASE"
abtars install
abtars update

# 2. Restore
abtars restore ~/path/to/abtars-2026-06-05.zip
# The matching abmind archive is restored alongside the abTARS archive when present.

# 3. Start
abtars restart --cold
```

## Same machine recovery (wiped data)

```bash
abtars install --force
abtars update
abtars restore ~/.backup-abtars/abtars-2026-06-05.zip
abtars restart --cold
```

## Retention

Old backups are auto-pruned after 7 days (configurable with `--prune-days`). For long-term retention, copy backups off-machine or to cloud storage.
