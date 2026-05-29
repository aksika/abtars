# Upgrading & Deploying

## KP (WSL)

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

Always verify after deploy:

```bash
cat ~/.abtars/manifest.json | python3 -c "import json,sys;print(json.load(sys.stdin).get('version','?'))"
```

Should match the latest git commit short SHA.

## Molty (Mac)

All commands via tmux (never bare SSH):

```bash
# Full deploy (abmind + abtars)
tmux send-keys -t remote 'export PATH=/opt/homebrew/bin:$HOME/.local/bin:$HOME/.abtars/bin:$PATH && cd ~/abmind && git pull --ff-only origin dev && npm run build && cd ~/abtars && git fetch origin dev && git checkout <commit> && node esbuild.config.js && rm -rf bundle/public && cp -r src/components/dashboard/public bundle/public && cp -r agents bundle/agents && abtars update --from-local' Enter
```

**Important:** Use `git checkout <commit>` (moves HEAD) — NOT `git checkout <commit> -- .` (files only). The release version is derived from `git rev-parse --short HEAD`.

Wait ~30s then verify:

```bash
sleep 30 && tmux capture-pane -t remote -p -S -6
```

Expected: `✓ staged 0.1.0-<commit>`, all ✅ in dependency health.

**If Molty won't stop** (launchd supervision):

```bash
tmux send-keys -t remote 'abtars stop --force' Enter
```

`--force` is required on Molty — it kills watchdog first, then bridge. Without it, launchd respawns immediately.

## abmind-only changes

If only abmind changed (no abtars changes):

**KP:**
```bash
cd ~/workspace/ab/abmind && npm run build
cd ~/workspace/ab/abtars && abtars update
```

**Molty:**
```bash
tmux send-keys -t remote 'cd ~/abmind && git pull --ff-only origin dev && npm run build && abtars update --from-local' Enter
```

## Post-deploy checklist

1. Verify version: `manifest.json` matches expected commit
2. Check health: all ✅ in dependency health output
3. Telegram polling started (check logs)
4. No EADDRINUSE errors (old process lingering)
5. Secrets still encrypted: `head -c 4 ~/.abtars/secret/TELEGRAM_BOT_TOKEN` → `ENC:`
