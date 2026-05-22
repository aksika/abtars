---
name: gmail
description: Read and manage Gmail via gws-cli
user-invocable: false
---

# Gmail Access

Read, search, and manage emails using `gws-cli gmail`. Auth is pre-configured.

## Commands

```bash
# List unread emails
gws-cli gmail list -q "is:unread" -n 20

# Read a message by ID
gws-cli gmail read MSG_ID

# Search
gws-cli gmail search -q "from:someone subject:invoice"

# Mark as read
gws-cli gmail mark-read MSG_ID

# Mark as unread
gws-cli gmail mark-unread MSG_ID
```

## Search query syntax

Standard Gmail operators: `from:`, `to:`, `subject:`, `is:unread`, `newer_than:1d`, `has:attachment`, `label:`, `after:2026/03/01`.

## When checking emails

1. `gws-cli gmail list -q "is:unread" -n 20`
2. For each unread email: `gws-cli gmail read <id>`, then send a SHORT summary to the user as a separate message (one message per email)
3. Summary format: **From:** / **Subject:** / 1-2 sentence gist
4. Do NOT create files, reports, or .md documents — deliver summaries directly in chat
5. After summarizing, mark as read: `gws-cli gmail mark-read <id>`

## Rules
- Never delete or trash emails without explicit user request
- If no unread emails, do not send any message — stay silent
