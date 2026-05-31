# How to Add a New Service

This guide walks through integrating a new external service with abTARS, using Home Assistant as the example.

## Overview

Adding a service requires three things:
1. **Configuration** — settings in `.env.skills`, secrets in `secret/`
2. **A skill** — instructions the agent follows when using the service
3. **Optionally a tool** — a script the agent can execute

## Step 1: Configuration

### Settings (non-secret)

Add service settings to `~/.abtars/config/.env.skills`:

```bash
# Home Assistant
HA_URL=http://192.168.1.4:8123
```

These are non-secret values — URLs, model names, feature flags, voices.

### Secrets (API keys, tokens)

Drop the secret as a plain file in `~/.abtars/secret/`:

```bash
echo "your-long-lived-access-token" > ~/.abtars/secret/HA_TOKEN
```

On next bridge start:
1. The file is auto-encrypted at rest (AES-256-GCM)
2. The value is loaded into `process.env.HA_TOKEN`
3. The agent and skills can reference it as `$HA_TOKEN`

**Shortcut:** If you put `HA_TOKEN=your-token` directly in `.env.skills`, the boot process auto-migrates it to `secret/` and removes it from the file. Either path works.

### How the bridge picks it up

```
Boot sequence:
  1. Load ~/.abtars/config/.env         (core config)
  2. Load ~/.abtars/config/.env.skills  (service settings)
  3. Auto-migrate any *_KEY/*_TOKEN/*_SECRET/*_PASSWORD → secret/
  4. Load ~/.abtars/secret/*            (decrypt + inject into process.env)

After boot: process.env.HA_URL and process.env.HA_TOKEN are available.
```

No restart needed after adding a secret file — but the bridge must be restarted to pick up new env vars.

## Step 2: Write a Skill

Skills tell the agent HOW to use the service. Create a markdown file:

```bash
~/.abtars/skills/self/home-assistant.md
```

```markdown
# Home Assistant

Control smart home devices via the Home Assistant REST API.

## Configuration
- URL: $HA_URL
- Token: $HA_TOKEN (long-lived access token)

## Usage

Call the HA REST API using execute_bash with curl:

### List entities
```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" $HA_URL/api/states | python3 -c "import json,sys; [print(e['entity_id'], e['state']) for e in json.load(sys.stdin)[:20]]"
```

### Toggle a device
```bash
curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" $HA_URL/api/services/light/toggle -d '{"entity_id": "light.living_room"}'
```

### Get device state
```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" $HA_URL/api/states/sensor.temperature | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"attributes\"].get(\"friendly_name\")}: {d[\"state\"]} {d[\"attributes\"].get(\"unit_of_measurement\",\"\")}')"
```

## Rules
- Always confirm destructive actions (lock doors, turn off heating) before executing
- Report device state after toggling
- If $HA_URL is unreachable, tell the user HA is offline
```

### Where skills go

| Path | Purpose |
|------|---------|
| `~/.abtars/skills/self/` | Your custom skills (read-write, agent can update) |
| `~/.abtars/skills/core/` | Built-in skills (read-only, shipped with updates) |

Put your service skill in `self/`. The agent loads all `.md` files from both directories on boot.

### Downloading community skills

If a skill is published in the abTARS repo:

```bash
# Skills ship with the release — they're in core/ after abtars update
abtars update --from-local
```

For custom skills shared between instances, just copy the `.md` file to `~/.abtars/skills/self/`.

## Step 3: Optional — Add a Script Tool

For complex integrations, add a script the agent can call:

```bash
~/.abtars/skills/self/scripts/ha-control.sh
```

```bash
#!/bin/bash
# Usage: ha-control.sh <action> <entity_id> [value]
ACTION=$1
ENTITY=$2
VALUE=${3:-}

case "$ACTION" in
  state)
    curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states/$ENTITY"
    ;;
  toggle)
    DOMAIN=$(echo "$ENTITY" | cut -d. -f1)
    curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
      "$HA_URL/api/services/$DOMAIN/toggle" -d "{\"entity_id\": \"$ENTITY\"}"
    ;;
  set)
    DOMAIN=$(echo "$ENTITY" | cut -d. -f1)
    curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
      "$HA_URL/api/services/$DOMAIN/turn_on" -d "{\"entity_id\": \"$ENTITY\", \"brightness\": $VALUE}"
    ;;
esac
```

```bash
chmod +x ~/.abtars/skills/self/scripts/ha-control.sh
```

The agent calls it via `execute_bash`:
```bash
~/.abtars/skills/self/scripts/ha-control.sh toggle light.living_room
```

## Summary

| What | Where | Example |
|------|-------|---------|
| Non-secret settings | `~/.abtars/config/.env.skills` | `HA_URL=http://192.168.1.4:8123` |
| API keys / tokens | `~/.abtars/secret/<NAME>` | `echo "token" > ~/.abtars/secret/HA_TOKEN` |
| Skill (instructions) | `~/.abtars/skills/self/<name>.md` | `home-assistant.md` |
| Script (optional) | `~/.abtars/skills/self/scripts/<name>.sh` | `ha-control.sh` |

After adding all files: `abtars restart` — the agent now knows about the service and has credentials to use it.
