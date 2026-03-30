# §5.5 Retro Extract

Read the retrospective you wrote in §1 (`~/.agentbridge/memory/retrospectives/retro_${WAKEUP_DATE}.md`).

Extract durable facts from the "What did I learn?" and "How can I improve?" sections. For each:

```bash
agentbridge-store --translated "<fact in English>" --original "<fact in English>" \
  --memory-type <fact|decision> --emotion-score 0 --chat-id 0 \
  --trust 2 --integrity 2 --credibility 2 --classification 1
```

- "What did I learn?" items → memory_type `fact`
- "How can I improve?" items → memory_type `decision`
- Skip items that are too vague or already stored

Respond with count of facts extracted.
