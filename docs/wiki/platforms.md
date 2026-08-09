# Platforms

abTARS connects to messaging platforms and routes messages through the AI model pipeline.

## Supported Platforms

| Platform | Features | Setup |
|----------|----------|-------|
| **Telegram** | Voice, reactions, inline keyboards, streaming edits, threads | Bot token from @BotFather |
| **Discord** | Reactions, slash commands, threads, streaming edits | Bot token + App ID |

## Telegram

Full-featured: voice messages (STT/TTS), emoji reactions for memory scoring, inline keyboard pickers for model switching, edit-in-place streaming.

**Config:** `TELEGRAM_ALLOWED_USER_IDS` in `~/.abtars/config/.env`. The bot token itself is a credential — store it in the secrets vault:

```bash
echo -n "123456789:ABC..." > ~/.abtars/secret/TELEGRAM_BOT_TOKEN
chmod 600 ~/.abtars/secret/TELEGRAM_BOT_TOKEN
```

## Discord

Supports @mention filtering, role-based mentions, slash commands, DMs, guild channels. Streaming via message edits.

**Config:** `DISCORD_APP_ID` and `DISCORD_ALLOWED_USER_IDS` in `~/.abtars/config/.env`. The bot token is a credential — store it in `~/.abtars/secret/DISCORD_BOT_TOKEN` (mode 600). Optional: `DISCORD_ALLOWED_CHANNELS` for channels where the bot responds without @mention.




## Multi-platform

All platforms run simultaneously. Each user gets a session key (`userId:platform`) — conversations are isolated per platform. Memory is shared across platforms (same user, different channels = same memory).
