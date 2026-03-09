# Tools

These are Telegram commands you can send as messages. They are handled by the bridge layer.

## /nlm — NotebookLM Knowledge Base (Layer 6)

Cloud-backed RAG over curated reference material (documents, guides, research).

| Command | Description |
|---------|-------------|
| `/nlm list` | List all notebooks |
| `/nlm create <name>` | Create a new notebook |
| `/nlm sources <notebook>` | List sources in a notebook |
| `/nlm query <question>` | Query the default notebook |

### When to use
- Questions about uploaded reference material, docs, research
- Technical documentation lookups local memory wouldn't have
- Local memory search returned nothing and the question is about curated knowledge

### When NOT to use
- Answer is in the current conversation context
- Personal memories or past conversations (use memory-search)
- Real-time information needs
- Short confirmations like "yes", "ok", "do it"
