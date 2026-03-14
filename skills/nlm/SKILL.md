---
alwaysApply: true
name: nlm
description: Query the NotebookLM knowledge base (Layer 6) for answers grounded in curated reference material
user-invocable: false
---

# Knowledge Base Query Skill

You have access to a persistent knowledge base powered by Google NotebookLM. Use it to answer questions grounded in curated reference documents — research papers, technical docs, guides, and other uploaded material.

## How to invoke

Run this command using your shell tool:

```bash
nlm notebook query <NOTEBOOK_ID> "your question here" --json
```

### Parameters

- `<NOTEBOOK_ID>` (required): The notebook ID to query. Use the default notebook ID from your environment.
- `"your question here"` (required): A natural-language question. Be specific and descriptive.

### Other useful commands

```bash
nlm notebook list --json          # List all notebooks
nlm notebook create <name> --json # Create a new notebook
nlm source list <NOTEBOOK_ID> --json  # List sources in a notebook
```

### Output

JSON object with: `answer`, `sources_used` (array of source references).

## When to use

- The user asks about topics covered by uploaded reference material (documents, research, guides)
- The user asks for technical documentation lookups that local memory wouldn't have
- The user asks research-oriented questions that require grounded, cited answers
- Local memory search returned no useful results and the question is about curated knowledge

## When NOT to use

- The answer is already in the current conversation context
- The user is asking about personal memories or past conversations (use memory-search instead)
- The user needs real-time or live information (knowledge base contains static documents)
- The user is giving instructions, confirmations, or continuing a conversation
- Short messages like "yes", "ok", "do it" — these are never knowledge base queries
