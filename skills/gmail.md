---
name: gmail
description: Read and manage Gmail via gws CLI
user-invocable: false
---

# Gmail Access

Read, search, and manage emails using `gws` CLI. Auth is pre-configured.

## Commands

```bash
# Search emails
gws gmail users messages list --params '{"userId": "me", "q": "QUERY", "maxResults": 20}'

# Read message (metadata only)
gws gmail users messages get --params '{"userId": "me", "id": "MSG_ID", "format": "metadata", "metadataHeaders": ["From","Subject","Date"]}'

# Read full message
gws gmail users messages get --params '{"userId": "me", "id": "MSG_ID"}'

# Mark as read
gws gmail users messages modify --params '{"userId": "me", "id": "MSG_ID"}' --json '{"removeLabelIds": ["UNREAD"]}'
```

## Search query syntax

Standard Gmail operators: `from:`, `to:`, `subject:`, `is:unread`, `newer_than:1d`, `has:attachment`, `label:`, `after:2026/03/01`.

## Rules
- Fetch metadata first, then full body only for relevant messages
- Mark emails as read after processing them
- Never delete or trash emails without explicit user request
- The `gws` output includes a `Using keyring backend:` line on stderr — ignore it
