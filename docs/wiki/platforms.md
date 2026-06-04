# Platforms

abTARS connects to messaging platforms and routes messages through the AI model pipeline.

## Supported Platforms

| Platform | Features | Setup |
|----------|----------|-------|
| **Telegram** | Voice, reactions, inline keyboards, streaming edits, threads | Bot token from @BotFather |
| **Discord** | Reactions, slash commands, threads, streaming edits | Bot token + App ID |
| **IRC** | Text-only, multi-channel | Server + channel config |

## Telegram

Full-featured: voice messages (STT/TTS), emoji reactions for memory scoring, inline keyboard pickers for model switching, edit-in-place streaming.

**Config:** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS` in `.env`.

## Discord

Supports @mention filtering, role-based mentions, slash commands, DMs, guild channels. Streaming via message edits.

**Config:** `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_ALLOWED_USER_IDS` in `.env`. Optional: `DISCORD_ALLOWED_CHANNELS` for channels where the bot responds without @mention.

## IRC

Text-only adapter. Connects to any IRC server (tested with ngircd). No streaming (messages sent complete). Digital signatures for sender verification.

**Config:** `~/.abtars/config/irc.json` with server, channels, nick, and optional TLS settings.

## Multi-platform

All platforms run simultaneously. Each user gets a session key (`userId:platform`) — conversations are isolated per platform. Memory is shared across platforms (same user, different channels = same memory).
