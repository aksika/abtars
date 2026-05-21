---
name: gmail
description: Read and manage Gmail via gws CLI
user-invocable: false
---

# Gmail Access

Read, search, and manage emails using `gws-cli`. Auth is pre-configured.

## Commands

```bash
# List unread emails
gws-cli gmail users messages list --params '{"userId": "me", "q": "is:unread", "maxResults": 20}'

# Read message (metadata only)
gws-cli gmail users messages get --params '{"userId": "me", "id": "MSG_ID", "format": "metadata", "metadataHeaders": ["From","Subject","Date"]}'

# Read full message
gws-cli gmail users messages get --params '{"userId": "me", "id": "MSG_ID"}'

# Mark as read
gws-cli gmail users messages modify --params '{"userId": "me", "id": "MSG_ID"}' --json '{"removeLabelIds": ["UNREAD"]}'
```

## Search query syntax

Standard Gmail operators: `from:`, `to:`, `subject:`, `is:unread`, `newer_than:1d`, `has:attachment`, `label:`, `after:2026/03/01`.

## When checking emails

1. List unread messages (metadata only)
2. For each unread email: read the full body, then send a SHORT summary to the user as a separate message (one message per email)
3. Summary format: **From:** / **Subject:** / 1-2 sentence gist
4. Do NOT create files, reports, or .md documents — deliver summaries directly in chat
5. After summarizing, mark as read

## Rules
- Never delete or trash emails without explicit user request
- The `gws-cli` output includes a `Using keyring backend:` line on stderr — ignore it
- If no unread emails, just say "No new emails."
