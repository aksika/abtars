# Upgrading & Deploying

## Telegram commands

| Command | What it does |
|---------|-------------|
| `/update` | Update from npm (stable/alpha) |
| `/update pull` | Git pull latest code (no build) |
| `/update deploy` | Build + deploy from local git checkout |
| `/software` | Show versions, source, rollback slots |

Remote deploy flow: `/update pull` → `/update deploy`

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
/update deploy       ← builds + deploys + restarts
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

## If `abtars update` itself is broken (no release staged)

When the deployed CLI is so broken that `abtars update` cannot run — for example
`abtars: no release staged. Run 'abtars install' first.` because the wrapper
can't locate the bundle, or the bridge is dead and the watchdog can't respawn
it — use the emergency script. It does the full deploy (build, stage, swap
symlinks, restart, health-probe) with plain `npm` + `esbuild` and direct
launchctl/systemd calls. No working deployed binary required.

```bash
bash ~/.abtars-releases/src/abtars/scripts/emergency-update.sh
```

The script reads `HEAD` from `~/.abtars-releases/src/abtars` to determine the
version, so make sure that checkout is on the commit you want first
(`cd ~/.abtars-releases/src/abtars && git checkout <sha>` or `git pull`).

This is a manual mirror of the `deploy.ts` activation flow. If you change one,
update the other. See `scripts/emergency-update.sh` header for the full mirror
contract.
