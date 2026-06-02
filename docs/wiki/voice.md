# Voice (STT/TTS)

abTARS transcribes voice messages and can respond with synthesized speech.

## Speech-to-Text (STT)

Provider: Groq Whisper (`whisper-large-v3-turbo`).

### Setup

```bash
# ~/.abtars/config/.env
STT_ENABLED=true
GROQ_API_KEY=<secret>
```

### Flow

1. User sends a voice note on Telegram
2. Bridge downloads the audio file
3. Sends to Groq Whisper API for transcription
4. Injects transcript as: `[🎤 voice, EN] Hello, how are you?`
5. Agent responds normally (text or TTS)

### Language handling

- `LANGUAGE_HINT_PROMPT` guides Whisper (e.g. `"ez egy magyar szöveg. or English"`)
- Whisper returns detected language code (`hu`, `en`, `ja`, etc.)
- `users.json` defines expected languages per user: `"languages": ["hu", "en"]`
- If detected language isn't in the user's list → agent asks back (likely hallucination on short audio)
- Soft check via prompt — no hard rejection

## Text-to-Speech (TTS)

When enabled, the agent can respond with voice messages on Telegram.

### Setup

```bash
TTS_ENABLED=true
TTS_PROVIDER=openai    # or other supported provider
```

## Platform support

| Platform | STT | TTS |
|----------|-----|-----|
| Telegram | ✓ | ✓ |
| Discord | — | — |
| IRC | — | — |

Voice is Telegram-only — it's the only platform that sends voice note file IDs the bridge can download.
