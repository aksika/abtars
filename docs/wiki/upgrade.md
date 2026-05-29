# Upgrading & Deploying

## Linux / WSL

```bash
cd ~/workspace/ab/abtars
abtars update
```

`abtars update` builds from source, stages the release, stops the old instance (including watchdog), and starts the new one.

**If watchdog respawns the old instance** (race condition during deploy):

```bash
abtars stop          # kills watchdog + bridge
abtars update        # clean deploy
```

## macOS

```bash
cd ~/abmind && git pull --ff-only origin dev && npm run build
cd ~/abtars && git fetch origin dev && git checkout <commit>
node esbuild.config.js && rm -rf bundle/public && cp -r src/components/dashboard/public bundle/public && cp -r agents bundle/agents
abtars update --from-local
```

**Important:** Use `git checkout <commit>` (moves HEAD) — NOT `git checkout <commit> -- .` (files only). The release version is derived from `git rev-parse --short HEAD`.

**If the instance won't stop** (launchd supervision):

```bash
abtars stop --force
```

`--force` is required when running under launchd — it kills watchdog first, then bridge. Without it, launchd respawns immediately.

## abmind-only changes

If only abmind changed (no abtars changes):

```bash
cd ~/abmind && npm run build
cd ~/abtars && abtars update --from-local
```

Or if running from source (Linux/WSL):

```bash
cd ~/workspace/ab/abmind && npm run build
cd ~/workspace/ab/abtars && abtars update
```

## Verify after deploy

```bash
cat ~/.abtars/manifest.json | python3 -c "import json,sys;print(json.load(sys.stdin).get('version','?'))"
```

Should match the latest git commit short SHA. Also check:

1. All ✅ in dependency health output
2. Telegram polling started (check logs)
3. No EADDRINUSE errors (old process lingering)
4. Secrets still encrypted: `head -c 4 ~/.abtars/secret/TELEGRAM_BOT_TOKEN` → `ENC:`
