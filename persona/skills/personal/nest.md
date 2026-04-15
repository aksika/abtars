---
name: nest
description: Text-to-speech on Google Nest Mini via Home Assistant.
user-invocable: true
---

# Nest

Speak text on the living room Nest Mini via Home Assistant Edge TTS.

## Commands

- `/nest <message>` — Speak the message on the Nest Mini.
- `/nest status` — Check speaker state.

## Speak

Pick voice by message language:

| Language | Voice |
|----------|-------|
| English (default) | `en-US-AndrewMultilingualNeural` |
| Spanish | `es-ES-AlvaroNeural` |
| Hungarian | `hu-HU-TamasNeural` |

If unsure or mixed language, use `en-US-AndrewMultilingualNeural`.

Use `exec`:

```bash
curl -s -m 10 -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "tts.edge_tts", "media_player_entity_id": "media_player.living_room_speaker", "message": "<message>", "options": {"voice": "<voice>"}}' \
  http://192.168.1.4:8123/api/services/tts/speak
```

## Status

```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" http://192.168.1.4:8123/api/states/media_player.living_room_speaker
```

## Rules

- Escape quotes in message for valid JSON.
- Keep messages under 500 chars. Summarize long replies.
- Strip code blocks, URLs, markdown, emoji from spoken text.
- `$HA_TOKEN` is already in the environment.
- If curl fails, tell the user HA or the speaker may be unreachable.
