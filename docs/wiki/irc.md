# IRC Platform

abTARS can connect to IRC servers as a messaging platform alongside Telegram and Discord.

## Configuration

`~/.abtars/config/irc.json`:

```json
{
  "servers": [{
    "id": "bridges",
    "host": "192.168.1.128",
    "port": 6667,
    "nick": "KP",
    "channels": {
      "#bridges": {
        "mode": "signed",
        "requireMention": true,
        "allowFrom": ["Godfather", "Molty"],
        "trustedKeys": {
          "Molty": "<base64 Ed25519 pubkey>"
        }
      }
    }
  }]
}
```

Enable in `.env`:

```bash
IRC_ENABLED=true
```

## Channel modes

| Mode | Behavior |
|------|----------|
| `signed` | Messages must have a valid `[sig:ts:base64]` Ed25519 signature. Unsigned messages are dropped. |
| `plain` | No signature required. Sender must be in `allowFrom` list. |

## Digital signatures

IRC messages can be signed with Ed25519 for authentication between instances:

- **Outgoing:** payload `sender|channel|ts|text` is signed, tag `[sig:ts:base64]` appended
- **Incoming:** signature verified against `trustedKeys` for that sender
- Same signing module used by the A2A peer protocol

## Options

| Field | Description |
|-------|-------------|
| `requireMention` | Only process messages that mention the bot's nick |
| `allowFrom` | Whitelist of sender nicks (plain mode) |
| `trustedKeys` | Map of nick → Ed25519 public key (signed mode) |

## Anti-loop guards

- Self-echo filter (case-insensitive nick match)
- Outgoing content dedup (30s window)
- `[NO-REPLY]` tag — messages containing it are dropped before pipeline
- No streaming — full response delivered as single message

## Reconnection

Exponential backoff: 5s → 10s → 20s → ... → 300s max. Gives up after 5 consecutive failures. Auto-rejoins channels on reconnect. Successful connect resets the counter.
