# Upgrading & Deploying

## Telegram commands

| Command | What it does |
|---------|-------------|
| `/update` | Update from npm (stable/alpha) |
| `/update pull` | Git pull latest code (no build) |
| `/update build` | Build + deploy from local git checkout |
| `/software` | Show versions, source, rollback slots |

Remote deploy flow: `/update pull` → `/update build`

## Linux / WSL (KP)

```bash
cd ~/workspace/ab/abtars
abtars update
```

`abtars update` builds from source, stages into `app.staging/`, atomically swaps to `app/`, restarts, and health-verifies. Auto-rolls back if the bridge fails to start.

## macOS (Molty)

From Telegram (remote):
```
/update pull        ← fetches latest code
/update build       ← builds + deploys + restarts
```

Or via SSH:
```bash
cd ~/abmind && git pull --ff-only origin dev && npm run build
cd ~/abtars && git pull --ff-only origin dev && abtars update --from-local
```

## abmind-only changes

`abtars update` always copies fresh abmind dist into `app/node_modules/abmind/`. Just rebuild abmind and re-run update:

```bash
cd ~/workspace/ab/abmind && npm run build
cd ~/workspace/ab/abtars && abtars update --from-local
```

## Verify after deploy

```bash
abtars status
```

Or via Telegram: `/status`, `/software`

Shows: version, commit, bridge PID + health, source (npm or local + repo path). Also check:

1. `✓ Bridge healthy` in update output
2. Telegram polling started (check logs)
3. No EADDRINUSE errors

## Rollback

```bash
abtars rollback
```

Swaps `app/` ↔ `app.prev/`, restarts, health-verifies. Always works — `app.prev/` is a full copy.

## Dry run

```bash
abtars update --dry-run
```

Shows what would happen without building or mutating anything.

## If deploy fails

Auto-rollback handles most cases. If both new and rolled-back versions fail:

1. Check logs: `tail -50 ~/.abtars/logs/bridge.log`
2. Restore config: `cp ~/.abtars/config/.pre-update/* ~/.abtars/config/`
3. Manual start: `node ~/.abtars/app/bundle/abtars.js`
4. Nuclear: `abtars stop --force && abtars update --from-local`
