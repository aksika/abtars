# §8g Temporal Review

Review core-tier memories for staleness. Facts change — invalidate outdated ones instead of deleting.

## Process

Load all valid core memories:
```bash
agentbridge-recall --translated "" --chat-id 0 --pool core --limit 100
```

For each core memory, ask: **is this still true?**

Check against today's conversations and recent memories. If a fact has been superseded:

```bash
agentbridge-edit --memory-id <OLD_ID> --valid-to "${WAKEUP_DATE}" --caller dreamy
```

This sets `valid_to` — the memory is now "expired" but preserved for history. It won't appear in normal recall.

## What to look for

- **Contradicted facts**: "We use Auth0" but today we switched to Clerk → invalidate Auth0 memory
- **Outdated preferences**: "User prefers X" but they said they changed to Y → invalidate old preference
- **Completed events**: "Migration in progress" but it's done → invalidate, store completion as new fact
- **Stale technical facts**: "Running on Node 20" but we upgraded → invalidate

## Rules

- Only invalidate if you have EVIDENCE from today's conversations or recent memories
- Don't invalidate based on guessing or assumptions
- If unsure, leave it valid — better to keep a slightly stale fact than lose a correct one
- Never delete — always use `--valid-to` to preserve history
- After invalidating, check if a replacement fact should be stored or promoted to core
