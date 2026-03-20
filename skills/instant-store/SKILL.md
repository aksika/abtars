---
name: instant-store
description: Immediately persist important information from user messages as memories with emotional context
user-invocable: false
---

# Instant Store Skill

You have access to a persistent memory storage tool via a shell command. Use it to immediately store important information from user messages — facts, decisions, preferences, and events — along with the user's emotional state.

## How to invoke

Run this command using your shell tool:

```bash
agentbridge-store --content-en "memory in English" --content-original "memory in original language" --memory-type <TYPE> --emotion-score <SCORE> --chat-id <CHAT_ID>
```

### Parameters

- `--content-en` (required): The memory content translated to English.
  Example: `--content-en "User prefers dark mode for all applications"`
- `--content-original` (required): The memory content in the user's original language.
  Example: `--content-original "A user minden alkalmazásban a dark mode-ot preferálja"`
- `--memory-type` (required): One of `fact`, `decision`, `preference`, `event`.
  Example: `--memory-type preference`
- `--emotion-score` (required): Integer from -5 to +5 representing the user's emotional state.
  Example: `--emotion-score 3`
- `--chat-id` (required): The Telegram chat ID. Use `7773842843` for the main chat.
  Example: `--chat-id 7773842843`
- `--keyword` (optional): A preserved keyword from the user's original message for fallback search.
  Example: `--keyword "dark mode"`
- `--classification` (optional): NATO confidentiality level 0-3. Default: 1 (RESTRICTED).
  - `0` = UNCLASSIFIED (safe to share anywhere)
  - `1` = RESTRICTED (default, operational, limited distribution)
  - `2` = CONFIDENTIAL (health, finances, relationships)
  - `3` = SECRET (tokens, credentials — never disclosed)
  See the classification skill for auto-trigger rules.

### Emotion Score Scale

| Score | Label | Examples |
|-------|-------|---------|
| -5 | angry | Profanity, aggressive tone, hostility |
| -3 | frustrated | Repeated complaints, exasperation, "I already told you" |
| -1 | slightly negative | Mild disappointment, minor annoyance |
| 0 | neutral | Factual statements, calm information sharing |
| +1 | slightly positive | Mild satisfaction, casual approval |
| +3 | pleased | Gratitude, enthusiasm, "this is great" |
| +5 | happy | Excitement, joy, celebration |

### Output

JSON result indicating success or failure:

```json
{ "stored": true, "memoriesCount": 1 }
```

```json
{ "stored": false, "error": "content-en is required" }
```

## When to use

- The user explicitly asks you to remember something: "remember this", "emlékezz", "don't forget", "jegyezd meg"
- The user signals frustration about repeated information: "I told you", "már mondtam", "how many times"
- The user makes an emotionally significant statement (strong positive or negative sentiment)
- The user shares an important fact, decision, preference, or event worth preserving
- The user expresses a preference or makes a decision that should persist across conversations

## When NOT to use

- **Never** on routine conversational messages, greetings, or small talk
- **Never** on short confirmations: "yes", "ok", "got it", "do it", "approved", "go ahead"
- **Never** when the information is already stored in memory or present in the current conversation context
- **Never** proactively on every message — only when the message contains genuinely memorable information
- **Never** on messages that are instructions to you (the agent) rather than information to remember
