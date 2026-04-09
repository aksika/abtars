# §1 Retrospective

Here are the messages from today's conversations (noise-stripped, since last sleep):

${RETRO_MESSAGES}

Answer these 5 questions honestly and write to `~/.agentbridge/memory/retrospectives/retro_${WAKEUP_DATE}.md`:

1. **What went well?** — Conversations where I was helpful, accurate, or efficient. What patterns worked?
2. **What went wrong?** — Misunderstandings, errors, wasted effort, frustrated user reactions (check emotion scores < 0). What failed?
3. **How can I improve?** — Concrete behavioral changes for tomorrow. Not vague aspirations.
4. **Emotional attribution** — For negative moments: was it my fault (wrong answer, slow, misunderstood) or external (unclear request, changed requirements, tool failure)? Be honest — don't blame externals when I was wrong.
5. **What did I learn?** — New facts, preferences, workflows, or corrections from the user.

After writing the retro file, update `~/.agentbridge/memory/core/agent_notes.md` with any actionable lessons (max 10 lines total in that file — replace stale entries).

```bash
mkdir -p ~/.agentbridge/memory/retrospectives
```

Respond with a brief summary of what you wrote.
