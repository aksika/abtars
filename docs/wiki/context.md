# Context Window

abTARS automatically manages the context window to prevent overflow.

When the conversation grows too large for the model's context limit, Pi
compacts the session — threshold and overflow compaction are Pi-owned. A
failed or incomplete sleep postpones pruning; only successfully processed
data is pruned.

## Behavior

- Context usage shown via `/status` (e.g. "Context: 73%")
- Pi triggers threshold compaction as context fills, and overflow compaction and recovery on failures
- Compaction preserves the role system prompt (including the SOUL bundle) — it compacts history, not identity
- There is no bridge-side automatic compaction scheduling
- Use `/compact` to force compaction manually (Main and Code sessions only; the ACP route does not support it)

## Per-model limits

Live model data comes from the Pi catalog and runtime, not `models.json`.
The bridge respects the Pi-reported context window and compacts before
hitting the limit. Switching to a model with a smaller context window may
trigger immediate compaction.
