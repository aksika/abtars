---
name: irc-chat
description: Participate in IRC channels when the bridge is connected via the --irc flag. Broadcast status, coordinate with other bridges (KP, Molty), and converse with the godfather.
requires: abtars
---

# IRC Chat Participation

Talk to sibling bridges (KP, Molty) and the godfather in shared IRC channels. Different from `peer_ask` — IRC is async broadcast, no per-call RPC.

## When IRC is active

The bridge joins IRC when started with `--irc` (or when `irc.json` has server entries). Channels it joins are listed in `~/.abtars/config/irc.json`. Check your current IRC presence:

```bash
# From the bridge's own config
cat ~/.abtars/config/irc.json | python3 -c "import json,sys; d=json.load(sys.stdin); [print(s['id'], s.get('channels',[])) for s in d.get('servers',[])]"
```

## When to post proactively

- **Deploy status:** "starting Molty deploy at version X" / "deploy complete, abtars 0.1.0-abc"
- **Health events:** "restarted after watchdog trigger" / "ollama slow, tool calls timing out"
- **Coordination with the other bridge:** "KP going to sleep for 15min, Molty takes any urgent traffic"
- **Feature announcements:** "skill catalog updated, new skill: X"

Keep posts ≤2 lines. IRC is a tickertape, not a conversation.

## When to respond

You're in a channel with other bridges and the human (aksika). Rules:

- **Respond to @mentions** (config default). If a message doesn't mention your nick, ignore it — it's not for you.
- **Respond to godfather (aksika)** when he addresses you by nick, even on #bridges.
- **Don't talk to the other bridge unless asked.** KP and Molty shouldn't chatter unprompted — that's noise for the human watching.

## Channel conventions

- `#bridges` — bridge-to-bridge coordination. aksika watches.
- `#kirocomms` — agent coordination (AG1, AG2, AG3 kiro-cli sessions). Bridges do NOT post here — it's for the developer agents.

Check `irc.json` for your channel list. Only post to channels you're configured for.

## Message format

Plain text. IRC doesn't render markdown. Split long messages at 340 bytes if on a `secure` channel (#402 signatures add ~100 bytes overhead). Plain channels can use full 450.

No multi-line posts from the LLM in one tool call — each newline needs to be a separate PRIVMSG. The platform adapter handles splitting.

## Security

- **Plain channels (localhost kirocomms):** trust is machine login. No signatures. Bare nick auth.
- **Secure channels (public servers, #402):** every message is Ed25519-signed. Received unsigned messages on secure channels are dropped. You don't manage this directly — the adapter handles sign/verify.

Don't try to post signed messages manually — the adapter layer signs outbound automatically on secure channels.

## Interaction with peer_ask (a2a-communication)

These are separate mechanisms:

| Mechanism | Purpose | Sync/async | Visibility |
|---|---|---|---|
| `peer_ask` (a2a-communication skill) | Structured RPC: ask a peer something, get a response back | Sync, up to 60s | Log-only |
| IRC (this skill) | Async broadcast / coordination / human-watchable | Async, fire-and-forget | Shared channel |

Use `peer_ask` when you need an answer from the other agent NOW. Use IRC when announcing status or replying to a casual question in the channel.

## What NOT to do

- Don't relay user messages to IRC without being asked ("post my conversation history" = no)
- Don't loop (respond → other bridge responds → you respond → ...). Respect silence.
- Don't post secrets, tokens, PII, or internal-only info. IRC logs may be world-readable.
- Don't reply to every message in a busy channel — mention-gating is there for a reason.
