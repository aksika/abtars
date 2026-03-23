# Requirements Document — Memory Search Enhancements (4+1 Tier Architecture)

## Introduction

This specification covers a comprehensive overhaul of the AgentBridge memory system, evolving it from a reactive search-on-every-message model to a 3+1 tier architecture with background memory extraction, English-normalized storage, agent-initiated recall, and temporal decay ranking.

The core problem: the current system stores raw conversation messages and searches them with FTS5. This fails for Hungarian (agglutinative word forms defeat token matching), produces noisy results (raw chat vs. distilled facts), and adds latency by searching on every message regardless of need.

The solution introduces:
- **Tier 2 enhancements**: English rolling summaries, context window monitoring, per-session injection
- **Tier 3 collection**: A heartbeat-driven background system that extracts meaningful memories from transcripts using LLM calls, stores them in English with dual-column original-language preservation
- **Tier 3 recall**: An agent-initiated `memory_search` tool with English keyword search, temporal decay, and MMR diversity re-ranking
- **Tier 4 (future, documented only)**: Deep search with Pinecone for user-triggered exhaustive recall

Compaction tiers are simplified to daily → weekly → quarterly (no yearly tier yet).

## Glossary

- **MemoryManager**: The top-level coordinator (`memory-manager.ts`) that orchestrates search, indexing, context assembly, and memory lifecycle.
- **ContextAssembler**: The component (`context-assembler.ts`) that builds the tiered LLM context window from soul/core facts, scratchpad, recalled memories, working memory, and new input.
- **CompactionEngine**: The component (`compaction-engine.ts`) that handles hierarchical memory consolidation (daily → weekly → quarterly).
- **MemoryIndex**: The FTS5 full-text search index (`memory-index.ts`) over conversation messages and compacted summaries.
- **RecallFallbackPipeline**: The existing multi-stage search cascade (`recall-fallback-pipeline.ts`) that broadens search when initial FTS5 returns empty.
- **HeartbeatSystem**: A new periodic background task runner (inspired by OpenClaw's heartbeat architecture) that processes unprocessed transcripts, extracts memories, and runs consolidation on configurable intervals.
- **MemoryExtractor**: A new component that uses LLM calls to distill meaningful memories (facts, decisions, preferences, events) from raw conversation transcripts.
- **ExtractedMemory**: A structured memory record produced by the MemoryExtractor, containing dual-column content (`content_original` + `content_en`), metadata, and an optional `preserve_original` flag.
- **MemorySearchTool**: A new tool exposed to the LLM agent that allows agent-initiated memory recall via English keyword search with optional original-language fallback.
- **TemporalDecay**: A score multiplier applied to search results based on memory age, with a configurable half-life. Recent memories rank higher.
- **MMR (Maximal Marginal Relevance)**: A diversity re-ranking algorithm that penalizes search results too similar to already-selected results, reducing near-duplicate snippets.
- **RollingSummary**: An incrementally updated conversation summary maintained in the working memory tier, compressed when context window usage exceeds a threshold.
- **ContextWindowMonitor**: Logic that checks context window token usage at prompt construction time and triggers async rolling summary compression when a configurable threshold is exceeded.
- **CoreFacts**: The `user_core_facts.md` file loaded per conversation start (~500 token budget) containing permanent user facts. Already built, no changes needed.
- **SearchOptions**: Filter options for search queries including `chatId`, `startTime`, `endTime`, and `limit`.
- **TokenBudget**: The maximum number of tokens allocated for a given context tier.

---

## Tier 2 Enhancements — Working Memory

### Requirement 1: English Rolling Summary Generation

**User Story:** As a system operator, I want the rolling summary to always be generated in English regardless of conversation language, so that downstream search and context assembly work consistently across languages.

#### Acceptance Criteria

1. WHEN the ContextAssembler generates or updates a rolling summary, THE ContextAssembler SHALL instruct the LLM to produce the summary in English, regardless of the language used in the conversation messages.
2. WHEN a rolling summary is injected into the context window, THE ContextAssembler SHALL prefix the summary with the section label `[ROLLING SUMMARY (English)]` so the LLM recognizes the summary is English background context.
3. WHEN the conversation is conducted in a non-English language, THE ContextAssembler SHALL preserve the semantic meaning of all conversation content in the English summary without omitting information due to translation.
4. IF the LLM fails to produce an English summary (returns non-English text or an error), THEN THE ContextAssembler SHALL retain the previous valid rolling summary and log a warning.

### Requirement 2: Context Window Monitoring and Async Compression

**User Story:** As a system operator, I want the system to monitor context window usage and trigger rolling summary compression when usage is high, so that long conversations do not exceed the context window limit.

#### Acceptance Criteria

1. WHEN the ContextAssembler constructs a prompt, THE ContextWindowMonitor SHALL check the current context window token usage against a configurable threshold percentage.
2. THE ContextWindowMonitor SHALL read the threshold from the environment variable `MEMORY_COMPACT_THRESHOLD_PCT` with a default value of 85.
3. WHEN context window usage exceeds the configured threshold, THE ContextWindowMonitor SHALL schedule rolling summary compression to execute asynchronously AFTER the LLM has responded to the current user message.
4. THE ContextWindowMonitor SHALL NOT add latency to the current LLM request when triggering compression — the compression runs as a background task after the response is delivered.
5. WHEN a configuration value for `MEMORY_COMPACT_THRESHOLD_PCT` is invalid or unparseable, THE ContextWindowMonitor SHALL log a warning and use the default value of 85, consistent with the existing `parseNumberEnvSafe` pattern.


### Requirement 3: Per-Conversation Context Injection

**User Story:** As a system operator, I want Tier 1 (core facts) and Tier 2 (rolling summary) context to be injected only at conversation/session start rather than on every message, so that token budget is not wasted on redundant context within a session where the LLM already has native recall.

#### Acceptance Criteria

1. WHEN a new conversation session starts, THE ContextAssembler SHALL inject the CoreFacts and the current RollingSummary into the first prompt of the session.
2. WHILE a conversation session is active and the LLM context window retains prior messages, THE ContextAssembler SHALL omit CoreFacts and RollingSummary from subsequent prompts within the same session.
3. WHEN a session is restored after inactivity (staleness threshold exceeded), THE ContextAssembler SHALL re-inject CoreFacts and RollingSummary as if it were a new session start.
4. THE ContextAssembler SHALL track session injection state per channel key to determine whether the current message is the first in a session.
5. IF the session injection state cannot be determined (e.g., state lost due to restart), THEN THE ContextAssembler SHALL default to injecting CoreFacts and RollingSummary to avoid information loss.

---

## Tier 3 Collection — Heartbeat-Driven Memory Extraction

### Requirement 4: Heartbeat System for Background Processing

**User Story:** As a system operator, I want a periodic heartbeat system that processes memory tasks in the background, so that memory extraction and consolidation do not add latency to the conversation flow.

#### Acceptance Criteria

1. THE HeartbeatSystem SHALL execute periodic background tasks at a configurable interval read from the environment variable `MEMORY_HEARTBEAT_INTERVAL_MS` with a default value of 60000 (60 seconds).
2. WHEN a heartbeat tick fires, THE HeartbeatSystem SHALL check for unprocessed conversation transcripts and delegate them to the MemoryExtractor for processing.
3. WHEN a heartbeat tick fires, THE HeartbeatSystem SHALL check for pending compaction consolidations (daily → weekly, weekly → quarterly) and execute them if thresholds are met.
4. THE HeartbeatSystem SHALL run each heartbeat task with error isolation so that a failure in one task (e.g., memory extraction) does not prevent other tasks (e.g., consolidation) from executing.
5. THE HeartbeatSystem SHALL support starting and stopping gracefully, cleaning up any pending timers on shutdown.
6. WHEN the HeartbeatSystem starts, THE HeartbeatSystem SHALL log the configured interval and registered task names at info level.
7. IF the `MEMORY_HEARTBEAT_INTERVAL_MS` environment variable is invalid or unparseable, THEN THE HeartbeatSystem SHALL log a warning and use the default value of 60000, consistent with the existing `parseNumberEnvSafe` pattern.

### Requirement 5: LLM-Based Memory Extraction from Transcripts

**User Story:** As a user, I want the system to extract meaningful memories (facts, decisions, preferences, events) from my conversations rather than storing raw chat noise, so that recalled memories are high-quality and relevant.

#### Acceptance Criteria

1. WHEN the HeartbeatSystem identifies unprocessed transcript segments, THE MemoryExtractor SHALL use an LLM call to analyze the raw transcript and extract structured memories containing facts, decisions, preferences, and notable events.
2. THE MemoryExtractor SHALL discard conversational noise (greetings, filler, step-by-step reasoning, formatting artifacts) and retain only semantically meaningful information.
3. THE MemoryExtractor SHALL produce each extracted memory as an ExtractedMemory record with the fields: `content_original` (original language text), `content_en` (English translation), `memory_type` (fact, decision, preference, event), `source_chat_id`, `source_timestamp`, and `preserve_original` (boolean, default false).
4. THE MemoryExtractor SHALL track which transcript segments have been processed using a watermark (last processed timestamp or message ID per chat) to avoid reprocessing already-extracted content.
5. IF the LLM call fails during extraction, THEN THE MemoryExtractor SHALL log the error and leave the transcript segment marked as unprocessed for retry on the next heartbeat tick.
6. THE MemoryExtractor SHALL process transcript segments in chronological order per chat to maintain temporal coherence of extracted memories.

### Requirement 6: English Translation and Dual-Column Storage

**User Story:** As a system operator, I want extracted memories stored in English with the original language preserved alongside, so that FTS5 and vector search operate on consistent English text while original-language context is not lost.

#### Acceptance Criteria

1. WHEN the MemoryExtractor produces an ExtractedMemory, THE MemoryExtractor SHALL store both `content_original` (the memory in the original conversation language) and `content_en` (the English translation) in the extracted memories table.
2. THE MemoryIndex SHALL index the `content_en` field of extracted memories in the FTS5 full-text index so that English keyword searches match extracted memories.
3. WHEN vector search is enabled, THE VectorIndex SHALL generate embeddings from the `content_en` field of extracted memories.
4. WHEN the conversation is already in English, THE MemoryExtractor SHALL set `content_original` and `content_en` to the same value without performing a redundant translation step.
5. THE extracted memories table SHALL include columns for: `id`, `chat_id`, `content_original`, `content_en`, `memory_type`, `source_timestamp`, `preserve_original`, `created_at`.

### Requirement 7: Original-Language Keyword Preservation

**User Story:** As a user, I want to be able to tell the system to remember specific words in my language (e.g., "remember if I say 'ribanc' it is Alexa"), so that those keywords are preserved and searchable in the original language.

#### Acceptance Criteria

1. WHEN the MemoryExtractor detects that the user explicitly stresses a specific original-language keyword or phrase for memorization, THE MemoryExtractor SHALL set the `preserve_original` flag to true on the corresponding ExtractedMemory record.
2. WHEN an ExtractedMemory has `preserve_original` set to true, THE MemoryIndex SHALL index both the `content_en` and `content_original` fields in the FTS5 index so that the original-language keyword is directly searchable.
3. THE MemoryExtractor SHALL identify keyword preservation intent through explicit user phrasing patterns such as "remember that [word] means", "if I say [word]", "jegyezd meg hogy [word]", or equivalent formulations.
4. WHEN a preserved original-language keyword is stored, THE ExtractedMemory record SHALL include the specific keyword in a `preserved_keyword` field for targeted lookup.

### Requirement 8: Compaction Tier Simplification (Daily → Weekly → Quarterly)

**User Story:** As a system operator, I want the compaction hierarchy simplified to daily → weekly → quarterly (removing monthly and yearly tiers), so that the consolidation schedule matches actual usage patterns and reduces unnecessary LLM calls.

#### Acceptance Criteria

1. THE CompactionEngine SHALL support three compaction tiers: daily, weekly, and quarterly.
2. WHEN the HeartbeatSystem triggers consolidation, THE CompactionEngine SHALL consolidate daily summaries into weekly summaries after 7 daily summaries accumulate for a given chat.
3. WHEN the HeartbeatSystem triggers consolidation, THE CompactionEngine SHALL consolidate weekly summaries into quarterly summaries after 12 weekly summaries (approximately 3 months) accumulate for a given chat.
4. THE CompactionEngine SHALL generate all compacted summaries in English, consistent with the dual-column storage approach.
5. THE CompactionEngine SHALL NOT create monthly or yearly compaction tiers.
6. WHEN existing monthly or yearly compacted files are present from previous versions, THE CompactionEngine SHALL leave them in place without deleting or reprocessing them.

---

## Tier 3 Recall — Agent-Initiated Memory Search

### Requirement 9: Memory Search Tool for Agent

**User Story:** As a user, I want the AI agent to be able to search its memory when it needs to recall past information, rather than searching automatically on every message, so that recall is targeted and does not add unnecessary latency.

#### Acceptance Criteria

1. THE MemorySearchTool SHALL be exposed as a callable tool that the LLM agent can invoke when it determines a memory lookup is needed.
2. WHEN a new conversation session starts, THE system prompt SHALL inform the agent about the availability of the MemorySearchTool, its parameters, and when to use it.
3. THE MemorySearchTool SHALL accept the following parameters: `keywords` (array of English search terms), `original_keyword` (optional, a single original-language term for fallback search), `time_range` (optional, with `start` and `end` timestamps).
4. WHEN the agent invokes the MemorySearchTool, THE MemorySearchTool SHALL return a ranked list of matching memories formatted for inclusion in the agent's context.
5. THE MemorySearchTool SHALL complete its search within a configurable timeout (environment variable `MEMORY_SEARCH_TIMEOUT_MS`, default 1000ms) and return whatever results are available when the timeout is reached.
6. IF the MemorySearchTool encounters an error during search, THEN THE MemorySearchTool SHALL return an empty result set with an error description so the agent can inform the user gracefully.

### Requirement 10: English Keyword Search

**User Story:** As a system operator, I want the agent to search memories using English keywords extracted from the user's message, so that search matches the English-normalized memory store without requiring a separate translation step.

#### Acceptance Criteria

1. WHEN the agent invokes the MemorySearchTool with English `keywords`, THE MemorySearchTool SHALL search the `content_en` column of extracted memories and compacted summaries using FTS5 full-text search.
2. WHEN vector search is enabled, THE MemorySearchTool SHALL also perform vector similarity search against the `content_en` embeddings and combine results using the existing hybrid search (reciprocal rank fusion) approach.
3. THE MemorySearchTool SHALL NOT perform a separate LLM translation step — the agent itself extracts English keywords from the user's message as part of its natural language understanding.
4. WHEN multiple English keywords are provided, THE MemorySearchTool SHALL construct an FTS5 query that matches memories containing any of the provided keywords (OR-style matching), with results ranked by relevance.

### Requirement 11: Original-Language Keyword Fallback Search

**User Story:** As a user, I want the agent to also search for specific original-language keywords when I explicitly stress them, so that preserved original-language terms (like nicknames or code words) are found.

#### Acceptance Criteria

1. WHEN the agent invokes the MemorySearchTool with an `original_keyword` parameter, THE MemorySearchTool SHALL search the `content_original` column of extracted memories for that exact term in addition to the English keyword search.
2. WHEN both English keywords and an original-language keyword produce results, THE MemorySearchTool SHALL merge and deduplicate the result sets, preferring higher-scored entries when duplicates exist.
3. THE MemorySearchTool SHALL apply the original-language search specifically against memories where `preserve_original` is true, as well as against the raw `content_original` column for broader matching.
4. WHEN the original-language keyword matches a memory with `preserve_original` set to true, THE MemorySearchTool SHALL boost the score of that result to prioritize explicitly preserved keywords.

### Requirement 12: Search Across Compacted Tiers

**User Story:** As a user, I want memory search to include weekly and quarterly compacted summaries, not just individual messages, so that older consolidated memories are also discoverable.

#### Acceptance Criteria

1. WHEN the MemorySearchTool executes a search, THE MemorySearchTool SHALL search across extracted memories, weekly compacted summaries, and quarterly compacted summaries.
2. THE MemorySearchTool SHALL search compacted summaries using the same FTS5 and optional vector search mechanisms used for extracted memories.
3. WHEN a compacted summary matches a search query, THE MemorySearchTool SHALL include the tier label (weekly or quarterly) in the result metadata so the agent can gauge the granularity of the recalled information.
4. THE MemorySearchTool SHALL apply the same temporal decay and MMR re-ranking to compacted summary results as to extracted memory results.

### Requirement 13: Temporal Decay Scoring

**User Story:** As a system operator, I want recent memories to rank higher than old ones in search results, so that the agent prioritizes current and relevant information over stale memories.

#### Acceptance Criteria

1. WHEN the MemorySearchTool ranks search results, THE MemorySearchTool SHALL apply a temporal decay multiplier to each result's relevance score based on the age of the memory.
2. THE temporal decay SHALL use an exponential decay function with a configurable half-life read from the environment variable `MEMORY_DECAY_HALFLIFE_DAYS` with a default value of 30 days.
3. THE temporal decay multiplier SHALL be calculated as `2^(-age_in_days / half_life)` where `age_in_days` is the number of days between the memory's source timestamp and the current time.
4. THE temporal decay SHALL be applied as a multiplier on the base relevance score (FTS5 BM25 or hybrid RRF score), not as a replacement for it.
5. WHEN a configuration value for `MEMORY_DECAY_HALFLIFE_DAYS` is invalid or unparseable, THE MemorySearchTool SHALL log a warning and use the default value of 30, consistent with the existing `parseNumberEnvSafe` pattern.

### Requirement 14: MMR Diversity Re-Ranking

**User Story:** As a user, I want search results to be diverse rather than returning near-duplicate snippets, so that the recalled memories cover a broader range of relevant information.

#### Acceptance Criteria

1. WHEN the MemorySearchTool has computed relevance-scored results, THE MemorySearchTool SHALL apply Maximal Marginal Relevance (MMR) re-ranking before returning the final result set.
2. THE MMR algorithm SHALL select the first result as the highest-scored entry, then for each subsequent selection, penalize candidates whose content is too similar to already-selected results.
3. THE MMR similarity threshold SHALL be configurable via the environment variable `MEMORY_MMR_LAMBDA` with a default value of 0.7 (where 1.0 means pure relevance, 0.0 means pure diversity).
4. THE MMR similarity comparison SHALL use token-level Jaccard similarity between the `content_en` fields of candidate and already-selected results.
5. WHEN fewer than 2 results are available, THE MemorySearchTool SHALL skip MMR re-ranking and return the results as-is.

---

## Tier 3 Configuration

### Requirement 15: Memory Search Enhancement Configuration

**User Story:** As a system operator, I want all new memory search enhancement settings configurable via environment variables following the existing `MEMORY_*` pattern, so that I can tune behavior without code changes.

#### Acceptance Criteria

1. THE MemoryConfig SHALL include configuration fields for all new environment variables introduced by this specification: `MEMORY_COMPACT_THRESHOLD_PCT`, `MEMORY_HEARTBEAT_INTERVAL_MS`, `MEMORY_SEARCH_TIMEOUT_MS`, `MEMORY_DECAY_HALFLIFE_DAYS`, `MEMORY_MMR_LAMBDA`.
2. THE `loadMemoryConfig()` function SHALL parse all new environment variables using the existing `parseBooleanEnv` and `parseNumberEnvSafe` helper functions.
3. WHEN any new configuration value is invalid or unparseable, THE `loadMemoryConfig()` function SHALL log a warning and use the documented default value, consistent with the existing graceful degradation pattern.
4. THE MemoryConfig SHALL include a `heartbeat` configuration section with fields for: `enabled` (MEMORY_HEARTBEAT_ENABLED, default true), `intervalMs` (MEMORY_HEARTBEAT_INTERVAL_MS, default 60000).
5. THE MemoryConfig SHALL include a `searchEnhancements` configuration section with fields for: `searchTimeoutMs` (MEMORY_SEARCH_TIMEOUT_MS, default 1000), `decayHalflifeDays` (MEMORY_DECAY_HALFLIFE_DAYS, default 30), `mmrLambda` (MEMORY_MMR_LAMBDA, default 0.7), `compactThresholdPct` (MEMORY_COMPACT_THRESHOLD_PCT, default 85).

### Requirement 16: Graceful Degradation

**User Story:** As a system operator, I want the system to fall back to previous behavior if any enhancement fails, so that a bug in the new features does not break the existing conversation flow.

#### Acceptance Criteria

1. IF the HeartbeatSystem fails to start or encounters a fatal error, THEN THE MemoryManager SHALL continue operating without background memory extraction, and the existing inline search pipeline SHALL remain functional.
2. IF the MemoryExtractor fails to extract memories from a transcript, THEN THE MemoryManager SHALL preserve the raw transcript and the existing FTS5 index over raw messages SHALL remain searchable.
3. IF the MemorySearchTool encounters an error, THEN THE agent SHALL receive an empty result set and the conversation SHALL continue without recalled memories.
4. IF the English rolling summary generation fails, THEN THE ContextAssembler SHALL fall back to the previous rolling summary or omit the summary section, and log a warning.
5. IF the temporal decay or MMR re-ranking computation fails, THEN THE MemorySearchTool SHALL return results with base relevance scores only, without decay or diversity adjustments.

---

## Tier 4 — Deep Search (FUTURE — Document Only)

### Requirement 17: Deep Search (Future — Not Implemented)

**User Story:** As a user, I want to be able to trigger a deep, exhaustive memory search when I explicitly ask the system to "dig deeper" or "search more", so that I can find information that the standard search missed.

> **NOTE: This requirement is documented for future reference only. It SHALL NOT be implemented in this phase.**

#### Acceptance Criteria (Future)

1. WHEN the user explicitly requests a deep search (e.g., "dig deeper", "search more", "keresd jobban"), THE agent SHALL invoke a DeepSearch tool that performs high-latency exhaustive search.
2. THE DeepSearch tool SHALL use Pinecone free tier (https://www.pinecone.io/) for cloud-hosted vector search across all stored memories.
3. THE DeepSearch tool SHALL support cross-channel search, searching memories from all chat channels rather than just the current one.
4. THE DeepSearch tool SHALL apply LLM-assisted semantic reranking on the top candidate results before returning them to the agent.
5. WHEN Tier 3 search returns no results and the user insists on finding information, THE agent SHALL suggest using the deep search option.

---

## Future Improvements (Document Only)

### Requirement 18: Future Enhancements (Not Implemented)

> **NOTE: These items are documented for future reference only. They SHALL NOT be implemented in this phase.**

#### Planned Enhancements

1. **RRF (Reciprocal Rank Fusion) for multi-signal merging**: Deferred until cross-channel search is built in Tier 4. Will merge FTS5, vector, temporal, and semantic ranking signals into a unified score.
2. **Yearly compaction tier**: Consolidate quarterly summaries into yearly summaries. Deferred until sufficient quarterly data accumulates to justify the tier.
