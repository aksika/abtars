---
name: instant-store
description: Immediately persist important information from user messages as memories with emotional context
user-invocable: false
---

# Instant Store

```bash
agentbridge-store --content-en "English" --content-original "original language" --memory-type <TYPE> --emotion-score <SCORE> --chat-id 7773842843
```

## Required params
- `--content-en`: memory in English
- `--content-original`: memory in user's original language
- `--memory-type`: `fact`, `decision`, `preference`, `event`
- `--emotion-score`: -5 (angry) to +5 (happy). 0 = neutral.
- `--chat-id`: `7773842843` (main chat)

## Optional params
- `--keyword "term"`: preserved original keyword for search
- `--classification 0-3`: NATO level (see classification skill). Default: 1
- `--trust 0-3`: 3=owner (aksika DM), 2=self, 1=peer agent, 0=untrusted/web. Default: 0
- `--integrity 0-3`: 0=verbatim, 1=translated, 2=extracted, 3=compacted. Default: 2
- `--credibility 1-6`: 1=confirmed, 2=probably true, 3=possibly, 4=doubtful, 5=improbable, 6=unknown. Default: 6

## When to use
- User says "remember this", "emlékezz", "jegyezd meg"
- User frustrated about repeating info: "már mondtam", "I told you"
- Emotionally significant statement (strong +/-)
- Important fact, decision, preference, or event worth persisting

## When NOT to use
- Greetings, small talk, confirmations ("ok", "yes", "go ahead")
- Already stored or in current context
- Instructions to you (not info to remember)
