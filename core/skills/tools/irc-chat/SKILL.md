---
name: irc-chat
description: Participate in IRC channels when the bridge has irc.json configured. Post on user request, respond to @mentions and the user, coordinate with other bots on shared channels.
requires: abtars
---

# IRC Chat Participation

You can participate in IRC channels. The bridge's IRC connections are defined in `~/.abtars/config/irc.json`. Each server entry lists channels you're configured for, with nick and mode per channel.

## How to find your IRC context

```bash
cat ~/.abtars/config/irc.json
```

The file has `servers[]`, each with `id`, `host`, `nick`, and `channels{}`. For each channel:
- `mode`: `"plain"` or `"secure"` (secure = Ed25519-signed, plain = unauthenticated)
- `requireMention`: `true` = only respond when your nick is mentioned
- `allowFrom`: nicks whose messages you will react to (others are ignored even if addressed to you)
- `trustedKeys`: (secure mode only) map of nick → Ed25519 public key

If no `irc.json` or no servers, IRC is inactive for this bridge.

## When to post

**Post only when the user explicitly asks:**
- "post to IRC that the deploy is done"
- "tell the #bridges channel I'm restarting"
- "announce on IRC: ..."

The platform adapter handles tool invocation — you don't call raw IRC commands. Use the same outbound message channel you'd use for any reply; the adapter routes to IRC when the user's prompt came from IRC.

**Don't post proactively** unless the user configured you to (e.g. a cron'd status broadcast). Spontaneous IRC posts from an LLM are noise.

## When to respond

- An inbound IRC message mentioned your nick (adapter filtered it already — if it reached you, it's addressed to you)
- The sender is in `allowFrom` for that channel (adapter filtered)
- Keep replies short — one or two lines. IRC is a ticker, not a chat window

If you're uncertain whether to respond, don't. A missed reply is recoverable; a noisy loop between bots is not.

## Channel awareness

You may be on multiple channels. The inbound message carries its channel — respond on the same channel unless the user says otherwise. Don't cross-post.

If the user says "join channel #X", you can't actually join from the LLM side — joining is a config change (`irc.json`). Tell the user: "To join #X, add it under the appropriate server in `~/.abtars/config/irc.json` and restart. I can describe the config shape if you want."

## Message format

- Plain text. No markdown (IRC doesn't render it).
- One line per message. The adapter splits long outputs automatically, but keep replies short on purpose — IRC lines above ~340 chars on secure channels get truncated.
- No emojis unless you know the channel supports UTF-8 (most modern servers do, but older clients break).

## Signatures (secure channels)

Secure channels require Ed25519 signatures. **You do not sign anything manually** — the adapter layer signs every outbound message on secure channels automatically using the bot's private key from `.env`.

- Secure channels are bot-to-bot (humans can't sign in their IRC client).
- If you receive a message on a secure channel that fails verification, the adapter drops it before you see it — you'll never be tricked into replying to a spoofed sender.
- Don't try to embed signature-like tags in your replies (`[sig:...]`). The adapter does that.

## What NOT to do

- Don't relay private conversations (user-to-you) to IRC without explicit instruction
- Don't quote secrets, tokens, file paths, or PII — IRC messages may be logged or world-readable depending on server
- Don't chat with another bot unprompted. A brief acknowledgement to coordinate is fine; small talk is not
- Don't respond with long code blocks — commit to git and reference the SHA
- Don't ignore `allowFrom` or `requireMention` — the adapter respects these, and if a message reached you, trust that it should be answered

## Interaction with peer_ask (a2a-communication)

These are separate tools for different purposes:

| | peer_ask (a2a-communication) | IRC |
|---|---|---|
| Model | Sync RPC | Async broadcast |
| Audience | One peer | Whole channel |
| Visibility | Log-only | Human-watchable (via IRC client) |
| Use when | You need an answer from a specific peer | User asks you to announce / converse on a channel |

If the user says "ask molty what time it is" → use `peer_ask`.
If the user says "tell IRC you're restarting" → reply through the adapter, it goes to IRC.
