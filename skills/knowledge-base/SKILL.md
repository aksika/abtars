---
name: knowledge-base
description: Query the NotebookLM knowledge base (Layer 6) for answers grounded in curated reference material
user-invocable: false
---

# Knowledge Base Query Skill

You have access to a persistent knowledge base powered by Google NotebookLM. Use it to answer questions grounded in curated reference documents — research papers, technical docs, guides, and other uploaded material.

## How to invoke

Run this command using your shell tool:

```bash
agentbridge-kb query --query "your question here" --chat-id <CHAT_ID>
```

### Parameters

- `--query` (required): A natural-language question to ask the knowledge base. Be specific and descriptive.
  Example: `--query "What does the RFC say about authentication requirements?"`
- `--notebook` (optional): The notebook name to query. Defaults to the configured default notebook.
  Example: `--notebook "research"`
- `--chat-id` (required): The Telegram chat ID. Use `7773842843` for the main chat.

### Output

JSON object with: `answer`, `citations` (array of source references), `confidence`, `notebookName`, `cached`.

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
