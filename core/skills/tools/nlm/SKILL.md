---
name: nlm
description: Query NotebookLM knowledge base (Layer 6) for grounded answers
user-invocable: false
---

# Knowledge Base Query (NotebookLM)

Query curated reference documents — research papers, technical docs, guides.

```bash
nlm notebook query <NOTEBOOK_ID> "your question here" --json
```

Other commands:
```bash
nlm notebook list --json                    # list notebooks
nlm notebook create <name> --json           # create notebook
nlm source list <NOTEBOOK_ID> --json        # list sources
```

## Troubleshooting

If `nlm` returns `400 Bad Request` or auth errors, the session has expired. Fix:
```bash
nlm login
```
This opens a browser for Google re-authentication. Happens periodically when Google rotates session tokens.

Returns JSON: `answer`, `sources_used`.

## When to use
- Questions about uploaded reference material (docs, research, guides)
- Technical documentation lookups local memory wouldn't have
- Local memory search returned nothing and question is about curated knowledge

## When NOT to use
- Answer already in conversation context
- Personal memories / past conversations (use memory-search)
- Real-time / live information (knowledge base is static)
