---
name: speak
description: Speak text aloud through the Mac Mini's speaker using macOS say.
user-invocable: true
---

# Speak

Speak text through the Mac Mini's built-in speaker.

## Commands

- `/speak <message>` — One-shot: speak the given message.
- `/speak on` — Enable auto-speak for every reply. **WebUI only.** If the user is on Telegram, WhatsApp, or any other channel, reply: "Auto-speak only works in WebUI. Use `/speak <message>` for one-shot."
- `/speak off` — Disable auto-speak.

## How to speak

FIRST send your text reply, THEN use `exec`:

```bash
say -v Samantha "<message>"
```

## CRITICAL RULES

- **`/speak on` auto-mode is WebUI ONLY.** Never auto-speak on Telegram, WhatsApp, or other channels — it causes loops.
- **Send your text reply FIRST**, then call `say` as the LAST thing you do.
- **ALWAYS use Samantha voice. ALWAYS speak in English.** Translate if needed.
- **Run `say` exactly ONCE.** After exec returns, STOP. No more tool calls. No more text. Turn is over.
- Keep spoken text to 2-3 sentences max. Summarize long replies.
- Remove code blocks, URLs, markdown, and emoji from spoken text.
- Escape single quotes in text.
