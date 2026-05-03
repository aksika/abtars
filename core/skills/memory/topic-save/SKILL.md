---
name: topic-save
description: Save, update, and manage topic-specific knowledge files from conversation discussions
user-invocable: true
---

# Topic Save

Save topic-specific knowledge from conversations into persistent markdown files at `~/.agentbridge/topics/`.

## How to invoke

Use native file tools (read/write/list directory). No CLI commands.

1. **Sanitize name:** spaces→hyphens, remove non-alphanumeric (keep `-_`), collapse consecutive hyphens, preserve casing. Reject if empty or contains `..` or starts with `/`.
2. **Check existing:** list `~/.agentbridge/topics/`, case-insensitive match on `{Name}-*.md`. If found, update that file. If multiple, use most recent date.
3. **Create new:** write to `~/.agentbridge/topics/{Name}-{YYYY-MM-DD}.md`
4. **Update existing:** read file, append/merge new content into relevant sections, write back. Keep original filename/date.

## File format

```markdown
# {TopicName}

## Summary
[Condensed summary]

## Key Points
- [Point 1]
- [Point 2]

## Details
[Expanded details by subtopic]
```

Write condensed summaries, not transcript dumps.

## When to use
- User says "save this topic", "store this as a topic", "add this to the X topic"

## When NOT to use
- Routine messages, greetings, small talk
- Short facts/preferences (use instant-store)
- Recall/search requests (use memory-search)
