---
name: alexa-cli
description: Control the Echo Akos speaker via `alexacli` CLI — play Spotify music, make TTS announcements, and ask Alexa questions.
homepage: https://github.com/buddyh/alexa-cli
metadata:
  {
    "openclaw":
      {
        "emoji": "🔊",
        "requires": { "bins": ["alexacli"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "buddyh/tap/alexacli",
              "bins": ["alexacli"],
              "label": "Install alexacli (brew)",
            },
          ],
      },
  }
---

# Alexa CLI — Echo Akos

Control the Echo Akos via `alexacli`. The only device is **Echo Akos** — always use `-d "Echo Akos"`.

## Authentication

Config: `~/.alexa-cli/config.json` (domain: amazon.de).

```bash
alexacli auth status          # check token — BUT see caveat below
alexacli auth                 # browser login to re-authenticate (amazon.de)
```

If expired, re-authenticate with `alexacli auth` (needs browser on Mac screen).

### ⚠️ Auth Status Caveat (discovered 2026-03-01)

`alexacli auth status` can report `InvalidToken` even when the refresh token
is still valid and commands work fine. The status check does a stricter token
exchange/validation that fails before the actual refresh token expires.

**Always test with an actual command before assuming auth is broken:**
```bash
alexacli command "what time is it" -d "Echo Akos"
```
If that works → token is fine, ignore the auth status error.

## Spotify / Music

Primary use case. Spotify is the default music service.

```bash
# Play music
alexacli command "play jazz" -d "Echo Akos"
alexacli command "play Daft Punk" -d "Echo Akos"
alexacli command "play my Discover Weekly playlist" -d "Echo Akos"
alexacli command "play chill vibes playlist on Spotify" -d "Echo Akos"

# Playback control
alexacli command "pause" -d "Echo Akos"
alexacli command "resume" -d "Echo Akos"
alexacli command "next" -d "Echo Akos"
alexacli command "previous" -d "Echo Akos"
alexacli command "stop" -d "Echo Akos"

# Volume
alexacli command "volume 5" -d "Echo Akos"
alexacli command "louder" -d "Echo Akos"
alexacli command "quieter" -d "Echo Akos"

# What's playing
alexacli command "what song is this" -d "Echo Akos"
alexacli command "shuffle on" -d "Echo Akos"
alexacli command "repeat" -d "Echo Akos"
```

## Text-to-Speech

```bash
# Speak on Echo Akos
alexacli speak "Build finished" -d "Echo Akos"

# Announce (same effect with one device, but uses announcement voice)
alexacli speak "Dinner is ready" --announce
```

## Ask (Get Text Response)

```bash
alexacli ask "what time is it" -d "Echo Akos"
alexacli ask "what's the weather" -d "Echo Akos"
```

## History

```bash
alexacli history --limit 5
```

## Command Reference

| Command | Description |
|---------|-------------|
| `alexacli devices` | List all Echo devices |
| `alexacli speak <text> -d <device>` | Text-to-speech on device |
| `alexacli speak <text> --announce` | Announce to all devices |
| `alexacli command <text> -d <device>` | Voice command (smart home, music, etc.) |
| `alexacli ask <text> -d <device>` | Send command, get response back |
| `alexacli conversations` | List Alexa+ conversation IDs |
| `alexacli fragments <id>` | View Alexa+ conversation history |
| `alexacli askplus -d <device> <text>` | Alexa+ LLM conversation |
| `alexacli play --url <url> -d <device>` | Play MP3 via SSML |
| `alexacli auth` | Browser login or manual token |
| `alexacli auth status [--verify]` | Show auth status |
| `alexacli auth logout` | Remove credentials |
| `alexacli history` | View recent voice activity |

## Notes

- Domain is `amazon.de` — configured in `~/.alexa-cli/config.json`
- No smart home devices on this Echo (handled via Google Home / Home Assistant)
- Uses Amazon's unofficial API — may break if Amazon changes their API
- `alexacli command` sends natural language, same as speaking to Alexa
