---
name: ha
description: Query and control Home Assistant devices and TTS.
user-invocable: true
---

# Home Assistant

Home Assistant is at `http://192.168.1.4:8123`. Auth token is in env var `HA_TOKEN`.

All API calls need header: `Authorization: Bearer $HA_TOKEN`

## Check status

```bash
curl -sf -H "Authorization: Bearer $HA_TOKEN" http://192.168.1.4:8123/api/config | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'HA {d[\"state\"]} v{d[\"version\"]}')"
```

## List devices

```bash
curl -sf -H "Authorization: Bearer $HA_TOKEN" http://192.168.1.4:8123/api/states | python3 -c "
import sys,json
for s in json.load(sys.stdin):
    name=s.get('attributes',{}).get('friendly_name','')
    print(f'{s[\"entity_id\"]:40s} {s[\"state\"]:12s} {name}')
"
```

## Control a device

```bash
curl -sf -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  -d '{"entity_id": "ENTITY_ID"}' \
  http://192.168.1.4:8123/api/services/DOMAIN/ACTION
```

DOMAIN = part before the dot (light, switch, media_player). ACTION = turn_on, turn_off, or toggle.

## TTS (speak to Nest Mini)

```bash
curl -sf -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  -d '{"entity_id": "tts.edge_tts", "media_player_entity_id": "media_player.living_room_speaker", "message": "TEXT", "language": "VOICE"}' \
  http://192.168.1.4:8123/api/services/tts/speak
```

Voice map: en → en-US-GuyNeural, es → es-ES-AlvaroNeural, hu → hu-HU-TamasNeural. Default: en-US-AndrewMultilingualNeural. Strip emoji/code/URLs/markdown before TTS.

## Rules

1. List devices first to confirm entity_id before controlling.
2. Match user's device name to closest friendly name or entity_id.
3. Only actions: turn_on, turn_off, toggle.
4. Confirm what was done after controlling.
