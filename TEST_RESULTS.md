# Memory System Test Results — 2026-02-27

## Summary

- **184 passed** / 3 failed (pre-existing) / 187 total
- **17 test files** — 16 passed, 1 failed (config.test.ts — unrelated to memory)
- Duration: ~22s

## New Test Files (all passing)

| File | Tests | Time | Coverage |
|------|-------|------|----------|
| `session-manager.test.ts` | 7 | ~1s | SessionManager ↔ MemoryManager integration |
| `memory-e2e.test.ts` | 3 | ~0.7s | Full lifecycle, disk budget, auto-compaction |
| `memory-properties.test.ts` | 13 | ~4.7s | Property-based tests (fast-check) |

## Existing Test Files (all passing)

| File | Tests | What it covers |
|------|-------|----------------|
| `memory-manager.test.ts` | 34 | Session CRUD, scratchpad, disk budget, recordMessage, autoCompact, loadRecent, compactSession, assembleContext |
| `memory-index.test.ts` | 12 | FTS5 indexing, BM25 search, filters, prune, removeSession |
| `vector-index.test.ts` | 15 | Cosine similarity, RRF ordering, hybrid search FTS-only mode |
| `compaction-engine.test.ts` | 9 | Daily compaction, consolidation, FTS indexing of compactions, LLM failure |
| `sleep-cycle-runner.test.ts` | 6 | Weekly/monthly/yearly rollups, threshold checks, failure retention |
| `context-assembler.test.ts` | 5 | Tier assembly, budget enforcement, truncation, empty tiers |
| `transcript-writer.test.ts` | 9 | Path structure, JSONL serialization, error handling |
| `transcript-parser.test.ts` | 7 | Round-trip, malformed lines, parseTail |
| `memory-config.test.ts` | 17 | Env var parsing, defaults, invalid value fallback |

## Pre-existing Failures (not memory-related)

3 tests in `config.test.ts` fail because the `.env` file leaks real values into the test
environment, overriding the mocked env vars. These existed before the memory feature.

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
