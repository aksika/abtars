# §2 Feedback Pass

Review today's conversations for recalled memories that appeared in agent responses. For each extracted memory that was surfaced via `agentbridge-recall`:

1. Check the user's reaction:
   - **User confirmed or continued the topic** → `agentbridge-edit --memory-id <N> --relevance-score +10 --caller dreamy`
   - **User corrected or rejected the memory** → `agentbridge-edit --memory-id <N> --relevance-score -10 --caller dreamy`
   - **Ambiguous or no reaction** → skip (no signal is better than noise)

Search messages for `agentbridge-recall` invocations. Each result has a `source` field — entries with `source: "extracted"` or `source: "extracted:original"` are extracted memories.

Respond with count of memories boosted and demoted.
