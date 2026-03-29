---
alwaysApply: true
---
# Tools

## Memory Recall
```
agentbridge-recall --translated "kw1,kw2" --chat-id 7773842843 [--original "szó"] [--time-start <ms>] [--time-end <ms>]
```
Keywords: English content words, not meta-words. `--max-classification`: 0 in groups, 2 in DMs.

## Expand Source
```
agentbridge-expand --ids 451,452,453
```

## Memory Edit
```
agentbridge-edit --memory-id <N> [--translated "..." | --emotion-score N | --credibility N | --classification N | --relevance-score +N] [--caller kp] [--dry-run]
agentbridge-edit --message-id <N> --chat-id 7773842843 [field flags]
```
Attributes: free. Content: user must request (translation fixes exempt). See `instant-store` skill.
