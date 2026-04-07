# §8i Compression Backfill

Backfill `content_compressed` (ABM-L) on existing memories that lack it.

```bash
agentbridge-recall --translated "" --chat-id 0 --limit 50 --include-expired
```

For each memory missing content_compressed, compress the content_en into ABM-L format:

```
[FLAGS|topic|emotion|confidence|date] compressed content with @entity references
```

Flags: D=decision, P=preference, F=fact, L=lesson, O=origin, V=pivot, M=milestone, C=correction, T=technical, B=core belief.

**Rules:**
- Preserve paths, URLs, commands verbatim
- Use @references for known entities (@user, @agent, project names)
- Strip filler words, keep facts
- Parentheses for reasons: (pricing+DX)
- Keep under 120 chars

Once all are backfilled, this step becomes a no-op.
