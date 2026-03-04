# Memory System Test Results — 2026-03-01

## Summary

- **187 passed** / 3 failed (pre-existing) / 190 total
- **17 test files** — 16 passed, 1 failed (`session-manager.test.ts`)
- Duration: ~28s
- Phase 1 (Wire the Foundation) and Phase 2 (Command-Based Features) complete

## Test File Breakdown

| File | Pass | Fail | Total | Coverage |
|------|------|------|-------|----------|
| `config.test.ts` | 18 | 0 | 18 | Config parsing, env vars, defaults |
| `memory-config.test.ts` | 19 | 0 | 19 | Memory env vars, defaults, invalid fallback |
| `memory-manager.test.ts` | 35 | 0 | 35 | Session CRUD, scratchpad, disk budget, recordMessage, autoCompact, rolling summary, LLM compaction |
| `memory-index.test.ts` | 12 | 0 | 12 | FTS5 indexing, BM25 search, filters, prune, removeSession |
| `vector-index.test.ts` | 15 | 0 | 15 | Cosine similarity, RRF ordering, hybrid search, model-version-aware search, reembed |
| `compaction-engine.test.ts` | 9 | 0 | 9 | Daily compaction, consolidation, FTS indexing, LLM failure handling |
| `sleep-cycle-runner.test.ts` | 6 | 0 | 6 | Weekly/monthly/yearly rollups, threshold checks, failure retention |
| `context-assembler.test.ts` | 5 | 0 | 5 | Tier assembly, budget enforcement, truncation, rolling summary integration |
| `memory-e2e.test.ts` | 3 | 0 | 3 | Full lifecycle, disk budget, auto-compaction |
| `memory-properties.test.ts` | 13 | 0 | 13 | Property-based tests (fast-check) |
| `transcript-writer.test.ts` | 9 | 0 | 9 | Path structure, JSONL serialization, error handling |
| `transcript-parser.test.ts` | 7 | 0 | 7 | Round-trip, malformed lines, parseTail |
| `session-manager.test.ts` | 4 | 3 | 7 | SessionManager ↔ MemoryManager integration |
| `jsonrpc.test.ts` | 11 | 0 | 11 | JSON-RPC message parsing, serialization, error codes |
| `response-formatter.test.ts` | 12 | 0 | 12 | Response formatting, truncation, markdown |
| `security-gate.test.ts` | 5 | 0 | 5 | Permission checks, allowlist, rate limiting |
| `tmux-client.test.ts` | 4 | 0 | 4 | Tmux command execution, session management |

## Pre-existing Failures (not memory-related)

3 tests in `session-manager.test.ts` fail due to a `channelKey` type mismatch — the
`StoredSession.channelKey` field was changed to `string` but the tests still expect
`number`. For example, the stored value is `"42"` but the assertion expects `42`.
These failures predate the memory enhancement work and are unrelated to Phase 1/2 changes.

## Changes Since Last Run (2026-02-27)

### Phase 1 — Wire the Foundation
- LLM compaction wiring (`setLlmCall`, `/compact`, auto-compact, consolidation)
- Context assembly integrated into prompt flow (Telegram + Discord)
- Rolling summary buffer (`rollingBufferSize` config, `updateRollingSummary`)

### Phase 2 — Command-Based Features
- **IngestionPipeline**: YouTube transcript, PDF, text/markdown chunking; `/ingest` commands
- **ReflectionEngine**: `/reflect`, `/reflect list`, `/reflect <days>`
- **Embedding hot-swap**: `model_version` tracking, `reembed()`, model-version-aware search, `/reembed`
- **Selective forgetting**: Cascade delete across 6 layers, `forgetTopic`/`Range`/`Session`, `/forget` commands

### Test Delta
| Metric | 2026-02-27 | 2026-03-01 | Δ |
|--------|-----------|-----------|---|
| Total tests | 187 | 190 | +3 |
| Passing | 184 | 187 | +3 |
| Failing | 3 | 3 | 0 |
| Duration | ~22s | ~28s | +6s |
| `memory-manager.test.ts` | 34 | 35 | +1 |
| `memory-config.test.ts` | 17 | 19 | +2 |

## Property-Based Tests (fast-check)

| Property | Description | Runs |
|----------|-------------|------|
| P4 | Transcript serialization round-trip | 50 |
| P5 | Transcript file path structure | 100 |
| P6 | Indexed messages are searchable | 30 |
| P7 | BM25 score ordering | 1 (20 msgs) |
| P8 | Search filters (chatId + date range) | 20 + 1 |
| P9 | Session deletion removes index entries | 1 |
| P11 | Reciprocal rank fusion correctness | 100 |
| P13 | Pruning preserves most recent messages | 20 |
| P17 | parseTail returns last N messages | 50 |
| P18 | Malformed JSONL lines are skipped | 50 |
| P24 | Scratchpad persistence round-trip | 50 |
| P26 | Context assembly respects token budgets | 20 |
