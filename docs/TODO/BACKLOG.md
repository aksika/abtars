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

## 9. Memory Store Injection Scanning (defense-in-depth)

**Status:** Not started
**Priority:** Low — A2A prompt scanning already blocks poisoned input at entry point
**Source:** Gap review of Hermes study (2026-03-14)

**Problem:**
If a poisoned prompt somehow bypasses A2A scanning, kiro could store poisoned memories via `agentbridge-store`. These persist in SQLite and get injected into future sessions via recall.

**Proposed approach:**
Reuse `scanPrompt()` from `prompt-scanner.ts` on `--content-en` and `--content-original` in `agentbridge-store.ts`. On match: skip the save, log warning.

**Why low priority:**
The A2A prompt scanner (22 patterns) catches injection at the entry point. For a poisoned memory to enter the DB, the attacker would need to bypass the prompt scanner AND trick kiro into extracting+storing the payload — double barrier already exists.
