# Context Window

abTARS automatically manages the context window to prevent overflow.

When the conversation grows too large for the model's context limit, the bridge compacts the session — summarizing older messages to free space while preserving key information.

## Behavior

- Context usage shown via `/status` (e.g. "Context: 73%")
- Auto-compaction triggers when context approaches the model's limit
- Compaction preserves recent messages and summarizes older ones
- Use `/compact` to force compaction manually

## Per-model limits

Each model in `models.json` declares its `contextWindow`. The bridge respects this and compacts before hitting the limit. Switching to a model with a smaller context window may trigger immediate compaction.
