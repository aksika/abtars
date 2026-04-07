# §8e Topic Assignment

Review today's extracted memories that have `topic = 'general'` (untagged).

```bash
agentbridge-recall --translated "topic:general" --chat-id 0 --pool general --limit 20
```

For each untagged memory, assign the most appropriate topic:
`coding`, `personal`, `finance`, `health`, `work`, `projects`, `tools`, `people`, `decisions`

If none fit, create a new topic name (lowercase, single word).

```bash
agentbridge-edit --memory-id <ID> --topic <topic> --caller dreamy
```

**Rules:**
- Only process memories from today (check created_at)
- If the content clearly belongs to a topic, assign it
- If ambiguous, leave as `general` — don't force-fit
- Technical discussions → `coding`
- Personal preferences/facts about the user → `personal`
- Money, budgets, subscriptions → `finance`
- Architecture decisions, tool choices → `decisions`
