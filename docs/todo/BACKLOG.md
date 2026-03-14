# Backlog

## 8. Context Compression with Tool-Pair Integrity

**Status:** Not started
**Priority:** Low — implement when context windows become a bottleneck
**Source:** Hermes `context_compressor.py` study (2026-03-14)

**Problem:**
Long sessions or large `.chat` transcripts waste tokens on stale context. Naive truncation can split tool-call / tool-result pairs, confusing the model.

**Hermes approach:**
- Mid-session compression that identifies tool-call + tool-result pairs and keeps them atomic
- Compresses older turns while preserving recent context
- Maintains a "compressed summary" prefix so the model knows what happened earlier

**Open questions:**
1. Document only vs implement for `.chat` files vs implement for live sessions?
2. Should compression run during sleep cycle (offline) or mid-session (online)?
3. What's the trigger — token count threshold, turn count, or time-based?

**Reference:** `docs/specs/hermes-injection-scanning.study.md` (same study session), Hermes source at `/home/qakosal/workspace/hermes-agent/agent/context_compressor.py`
