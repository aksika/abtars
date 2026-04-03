# §5.5 Retro Extract

Read the retrospective you wrote in §1 (`~/.agentbridge/memory/retrospectives/retro_${WAKEUP_DATE}.md`).

Extract EVERY lesson, mistake, correction, and user feedback. Nothing is too small — if it happened, store it. For each item, determine:

- **What happened** — the specific event or feedback
- **The consequence** — what to do differently, or what to keep doing
- **Emotion** — how significant was this?

Store each with:

```bash
agentbridge-store --translated "<consequence in English>" --original "<consequence in English>" \
  --memory-type <fact|decision> --emotion-score <-5 to 5> --chat-id 0 \
  --trust 2 --integrity 2 --credibility 2 --classification 1
```

**Categories and emotion scoring:**

| Category | memory_type | emotion_score | Example |
|----------|------------|---------------|---------|
| Mistake I made | decision | -4 to -5 | "Don't restart without asking — user got frustrated" |
| User correction | decision | -3 to -4 | "Use local timezone CEST, not UTC" |
| Lesson learned | fact | -2 to +2 | "Mac uses darkwake with MAGICWAKE on en1" |
| Positive feedback | fact | +3 to +5 | "User appreciated quick fix of the cron bug" |
| Behavioral rule | decision | -4 to -5 | "Never pretend I did something I didn't" |
| User preference | decision | +1 to +3 | "User prefers planning before implementation" |

**Dedup and escalation:**
- Before storing, check with `agentbridge-recall --translated "<consequence>"` if a similar memory exists
- If it exists and the new event adds context → update with `agentbridge-edit --memory-id <id> --content "<updated consequence>"`
- If the same mistake happened AGAIN → escalate emotion: increase the negative score by -2 (e.g. -5 → -7) using `agentbridge-edit --memory-id <id> --emotion-score <escalated>`
- Only store as new if no similar memory found

**Rules:**
- Every "What did I learn?" item → store it
- Every "How can I improve?" item → store it
- Every user correction or frustration → store with negative emotion
- Every positive moment → store with positive emotion
- Phrase as actionable consequences: "Do X" or "Don't do Y" — not just "X happened"

Respond with count of memories stored and updated.
