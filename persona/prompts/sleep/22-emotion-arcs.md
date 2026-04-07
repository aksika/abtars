# §8k Emotional Arcs

Build emotional trajectory per topic from recent core memories.

For each topic that has 3+ core memories with emotion_tags:

1. Load memories ordered by created_at
2. Track the emotional trajectory: are things getting better (↑), worse (↓), volatile (↕), or stable (→)?
3. Store the arc symbol on the most recent core memory for that topic

```bash
agentbridge-edit --memory-id <LATEST_ID> --caller dreamy
```

**Arc symbols:**
- ↑ rising — emotions trending positive (fear→hope→relief)
- ↓ falling — emotions trending negative (hope→doubt→frustration)
- ↕ volatile — emotions swinging (joy→anger→relief→fear)
- → stable — emotions consistent (trust→trust→trust)
- — neutral — no emotional data

**Use cases:**
- Wake-up context shows `[coding ↑]` — agent knows the project is going well
- `[work ↓]` — agent should be more supportive, check in
- `[personal ↕]` — volatile period, tread carefully
