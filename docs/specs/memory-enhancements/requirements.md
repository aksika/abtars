# Requirements Document — Memory Enhancements

## Introduction

This specification covers enhancements to the existing local memory system in AgentBridge. The current system provides SQLite-backed persistence, JSONL transcripts, FTS5 full-text search, optional local-model vector search, hierarchical compaction (daily → weekly → monthly → yearly), and tiered context assembly with token budgets.

These enhancements are organized into three phases based on complexity, risk to the core Q→A pipeline, and dependency ordering:

- **Phase 1 — Wire the Foundation**: Connect existing dormant infrastructure (compaction, context assembly, rolling summary). Low risk, high immediate value. These components are already built but not wired into the hot path.
- **Phase 2 — Command-Based Features**: Add user-initiated capabilities (document ingestion, reflections, embedding hot-swap, selective forgetting). Medium complexity, zero risk to the hot path since they're opt-in via commands.
- **Phase 3 — Intelligence Layer**: Add autonomous behaviors that change the message processing pipeline (proactive recall, importance scoring, contradiction detection, cross-channel linking, feedback loop, topic chunking). High complexity, requires Phase 1 to be stable first.

Each phase is independently shippable. Phase 1 is a prerequisite for Phase 2 and Phase 3. Phase 2 and Phase 3 have no dependency on each other but Phase 3 benefits from Phase 2's embedding hot-swap and ingestion pipeline being in place.

## Glossary

- **MemoryManager**: The top-level coordinator component (`memory-manager.ts`) that orchestrates all memory subsystems.
- **CompactionEngine**: The component (`compaction-engine.ts`) responsible for daily compaction and hierarchical tier consolidation of conversation summaries.
- **ContextAssembler**: The component (`context-assembler.ts`) that builds the LLM context window from tiered memory sources with fixed token budgets.
- **EmbeddingProvider**: The component (`embedding-provider.ts`) that generates vector embeddings using a local ONNX model.
- **VectorIndex**: The component (`vector-index.ts`) that stores and searches embedding vectors using cosine similarity in SQLite.
- **MemoryIndex**: The component (`memory-index.ts`) that provides FTS5 full-text search over indexed messages.
- **MessageRecord**: A single conversation turn stored in a transcript and indexed for search.
- **CompactedMemory**: A compacted summary produced by the LLM at any tier (daily, weekly, monthly, yearly).
- **AssembledContext**: The assembled LLM context string with per-tier token usage breakdown.
- **IngestionPipeline**: A new component that accepts external documents (YouTube URLs, PDFs, transcripts) and vectorizes them into long-term memory.
- **ImportanceScorer**: A new component that classifies message importance and applies time-based decay to influence compaction survival.
- **ContradictionDetector**: A new component that detects when new facts contradict stored core facts and prompts for resolution.
- **ReflectionEngine**: A new component that generates periodic human-readable meta-summaries of recent activity.
- **FeedbackTracker**: A new component that tracks whether recalled memories were useful and tunes retrieval weights over time.
- **RollingSummary**: A compressed representation of older conversation messages beyond the full-detail buffer window.
- **ChannelKey**: A string identifier for a communication channel (Telegram chat ID or Discord channel snowflake).
- **TopicChunk**: A semantically coherent segment of conversation identified by topic boundaries rather than time boundaries.
- **LlmCall**: A callback function `(prompt: string) => Promise<string>` provided by the transport layer for LLM inference.

---

## Phase 1 — Wire the Foundation

> Goal: Activate the dormant memory infrastructure so the Q→A pipeline becomes memory-aware. Low risk — all components already exist, this is wiring and integration work.
>
> Prerequisite: None (builds on existing as-built components).

### Requirement 1: Wire LLM Compaction

**User Story:** As a system operator, I want the CompactionEngine and SleepCycleRunner to use a real LLM for summarization, so that conversation compaction produces meaningful summaries instead of placeholder responses.

#### Acceptance Criteria

1. WHEN the `/compact` command is invoked, THE MemoryManager SHALL call the CompactionEngine with a valid LlmCall callback and return the generated summary to the user.
2. WHEN mid-session auto-compaction is triggered by exceeding the MEMORY_AUTO_COMPACT_THRESHOLD token count, THE MemoryManager SHALL invoke the CompactionEngine with the LlmCall callback without user intervention.
3. WHEN the SleepCycleRunner performs hierarchical consolidation, THE SleepCycleRunner SHALL use the LlmCall callback to generate tier summaries (daily → weekly → monthly → yearly).
4. IF the LlmCall callback returns an error or times out, THEN THE CompactionEngine SHALL log the error and preserve the original unconsolidated messages without data loss.

### Requirement 2: Wire Context Assembly into Prompt Flow

**User Story:** As a user, I want my conversations to automatically include relevant memories, core facts, and scratchpad content, so that the AI has full context without me repeating information.

#### Acceptance Criteria

1. WHEN a user message is received on any channel (Telegram or Discord), THE MemoryManager SHALL call ContextAssembler.assemble() to build the tiered context before sending the prompt to the LLM.
2. THE ContextAssembler SHALL include all five tiers (soul/core facts, scratchpad, recalled memories, working memory, new input) in the assembled context sent to the LLM.
3. WHEN context assembly completes, THE assembled context text SHALL replace the raw user message as the prompt payload sent to the LLM transport.
4. IF context assembly fails, THEN THE MemoryManager SHALL fall back to sending the raw user message without assembled context and log a warning.

### Requirement 3: Rolling Summary for Conversation Buffer

**User Story:** As a user, I want older conversation messages to be compressed into a rolling summary while recent messages remain in full detail, so that the AI maintains long conversation context without exceeding token budgets.

#### Acceptance Criteria

1. THE ContextAssembler SHALL include the last N messages (configurable via MEMORY_ROLLING_BUFFER_SIZE, default 20) in full detail in the working memory tier.
2. WHEN the conversation exceeds N messages, THE ContextAssembler SHALL compress messages older than the buffer window into a RollingSummary using the LlmCall callback.
3. WHEN a RollingSummary exists, THE ContextAssembler SHALL prepend the rolling summary text before the full-detail messages in the working memory tier.
4. WHEN new messages push older messages out of the buffer window, THE ContextAssembler SHALL incrementally update the RollingSummary to incorporate the newly displaced messages.
5. IF the LlmCall callback is unavailable for summary generation, THEN THE ContextAssembler SHALL fall back to simple truncation of older messages.

---

## Phase 2 — Command-Based Features

> Goal: Add user-initiated capabilities via new slash commands. These are opt-in features that don't touch the core message processing pipeline. Zero risk to the hot path.
>
> Prerequisite: Phase 1 (LLM compaction wiring needed for reflections; context assembly needed for ingested documents to surface in conversations).

### Requirement 4: External Document Ingestion Pipeline

**User Story:** As a user, I want to feed the AI external documents (YouTube URLs, PDFs, text transcripts) so that the AI can learn from and recall information from those sources.

#### Acceptance Criteria

1. WHEN a user provides a YouTube URL via the `/ingest` command, THE IngestionPipeline SHALL extract the transcript text from the video.
2. WHEN a user provides a PDF file via the `/ingest` command, THE IngestionPipeline SHALL extract the text content from the PDF.
3. WHEN a user provides a plain text or markdown file via the `/ingest` command, THE IngestionPipeline SHALL read the text content directly.
4. WHEN text content is extracted from any source, THE IngestionPipeline SHALL split the content into chunks of a configurable maximum token size.
5. WHEN chunks are produced, THE IngestionPipeline SHALL generate embeddings for each chunk and store them in the VectorIndex with source metadata (source type, URL or filename, ingestion timestamp).
6. WHEN ingestion completes, THE IngestionPipeline SHALL report to the user the number of chunks ingested and the source identifier.
7. IF text extraction fails for a given source, THEN THE IngestionPipeline SHALL return a descriptive error message to the user identifying the failure reason.
8. WHEN a user invokes `/ingest list`, THE IngestionPipeline SHALL display all previously ingested documents with their source type, identifier, chunk count, and ingestion date.

### Requirement 5: Memory Reflection and Meta-Summaries

**User Story:** As a user, I want periodic human-readable digests of what the AI and I have been working on, so that I can review activity and maintain awareness of accumulated knowledge.

#### Acceptance Criteria

1. WHEN a user invokes the `/reflect` command, THE ReflectionEngine SHALL generate a human-readable summary of activity over a configurable time window (default: last 7 days).
2. THE ReflectionEngine SHALL organize the summary by topic clusters derived from compacted memories and recent conversations.
3. THE ReflectionEngine SHALL use the LlmCall callback to generate natural-language prose from the raw compacted memory data.
4. WHEN the reflection is generated, THE ReflectionEngine SHALL store the reflection as a markdown file in the memory directory under `reflections/{channelKey}/YYYY-MM-DD.md`.
5. WHEN a user invokes `/reflect list`, THE ReflectionEngine SHALL display available past reflections with their dates and a one-line preview.
6. IF no compacted memories or conversations exist for the requested time window, THEN THE ReflectionEngine SHALL inform the user that insufficient data is available for reflection.

### Requirement 6: Embedding Model Hot-Swap

**User Story:** As a system operator, I want to swap embedding models without losing existing search capability, so that I can upgrade to better models as they become available.

#### Acceptance Criteria

1. THE EmbeddingProvider SHALL store a model version identifier alongside each embedding vector in the embeddings table.
2. WHEN a new embedding model is configured (via MEMORY_EMBEDDING_MODEL env var), THE EmbeddingProvider SHALL detect the model change by comparing the configured model name against the stored model version.
3. WHEN a model change is detected, THE EmbeddingProvider SHALL continue to serve search queries using existing embeddings until re-embedding is complete.
4. WHEN a user or operator invokes the `/reembed` command, THE EmbeddingProvider SHALL re-generate embeddings for all stored content using the new model and update the embeddings table.
5. WHILE re-embedding is in progress, THE EmbeddingProvider SHALL report progress to the user (percentage or count of processed items).
6. THE VectorIndex SHALL only compare embeddings generated by the same model version during cosine similarity search.

### Requirement 7: Selective Forgetting

**User Story:** As a user, I want to selectively forget specific topics, time ranges, or conversations, so that I can manage my memory and remove outdated or unwanted information.

#### Acceptance Criteria

1. WHEN a user invokes `/forget topic <topic>`, THE MemoryManager SHALL identify and remove all messages, embeddings, and compacted memories semantically related to the specified topic.
2. WHEN a user invokes `/forget range <start_date> <end_date>`, THE MemoryManager SHALL remove all messages, embeddings, and compacted memories within the specified date range.
3. WHEN a user invokes `/forget session <session_id>`, THE MemoryManager SHALL remove all messages, embeddings, transcript files, and compacted memories associated with the specified session.
4. WHEN a forget operation is executed, THE MemoryManager SHALL cascade the deletion through all storage layers: SQLite messages table, FTS5 index, embeddings table, vector index, transcript JSONL files, and compacted memory markdown files.
5. WHEN a forget operation completes, THE MemoryManager SHALL report to the user the count of items removed from each storage layer.
6. WHEN a topic-based forget is executed, THE MemoryManager SHALL use hybrid search to identify related messages and require a relevance threshold (MEMORY_FORGET_THRESHOLD, default 0.8) to avoid accidental deletion of unrelated content.
7. IF a forget operation targets content that has been consolidated into a higher-tier compaction, THEN THE MemoryManager SHALL regenerate the affected compaction summaries excluding the forgotten content.

---

## Phase 3 — Intelligence Layer

> Goal: Add autonomous behaviors that make the memory system proactively intelligent. These change the message processing hot path and introduce new async work on every incoming message.
>
> Prerequisite: Phase 1 (context assembly and compaction must be stable). Benefits from Phase 2 (embedding hot-swap improves vector quality; ingested documents expand the recall corpus).

### Requirement 8: Memory-Aware Proactive Recall

**User Story:** As a user, I want the AI to automatically surface relevant past memories mid-conversation without me explicitly asking, so that the AI behaves like a knowledgeable assistant who remembers our history.

#### Acceptance Criteria

1. WHEN a user message is received, THE MemoryManager SHALL perform a hybrid search against the user's message content to identify relevant past memories.
2. WHEN the hybrid search returns results above a configurable relevance threshold (MEMORY_PROACTIVE_RECALL_THRESHOLD, default 0.7), THE ContextAssembler SHALL include those results in the recalled memories tier.
3. WHEN proactively recalled memories are included, THE ContextAssembler SHALL annotate them with a "[PROACTIVE]" label so the LLM can distinguish them from explicitly requested recalls.
4. THE MemoryManager SHALL limit proactive recall to a configurable maximum number of results (MEMORY_PROACTIVE_RECALL_LIMIT, default 3) to avoid context window bloat.
5. WHILE the conversation is in its first message of a session, THE MemoryManager SHALL skip proactive recall to avoid surfacing irrelevant memories before context is established.

### Requirement 9: Importance Scoring and Decay

**User Story:** As a user, I want the system to classify message importance and apply time-based decay, so that compaction preserves the most valuable information and stale low-importance memories fade naturally.

#### Acceptance Criteria

1. WHEN a message is recorded, THE ImportanceScorer SHALL assign an importance score between 0.0 and 1.0 based on content characteristics (decisions, action items, facts, preferences score higher; greetings, acknowledgments score lower).
2. THE ImportanceScorer SHALL store the importance score alongside the MessageRecord in the messages table.
3. WHEN the CompactionEngine selects messages for compaction, THE CompactionEngine SHALL prioritize messages with higher importance scores for inclusion in the summary.
4. THE ImportanceScorer SHALL apply a configurable time-based decay function (MEMORY_DECAY_HALF_LIFE_DAYS, default 30) that reduces the effective importance score of older messages.
5. WHEN the VectorIndex or MemoryIndex returns search results, THE MemoryManager SHALL factor the decayed importance score into the final ranking alongside relevance scores.
6. IF a message is marked as a core fact (stored in user_core_facts.md), THEN THE ImportanceScorer SHALL exempt the message from time-based decay.

### Requirement 10: Contradiction Detection

**User Story:** As a user, I want the system to detect when new information contradicts previously stored core facts, so that my knowledge base stays accurate and I can resolve conflicts.

#### Acceptance Criteria

1. WHEN a new message contains a factual assertion that semantically contradicts an existing entry in user_core_facts.md, THE ContradictionDetector SHALL identify the contradiction.
2. WHEN a contradiction is detected, THE ContradictionDetector SHALL present both the new assertion and the existing fact to the user with a prompt asking which version to keep.
3. WHEN the user resolves a contradiction by choosing the new fact, THE ContradictionDetector SHALL update user_core_facts.md with the new information and log the change.
4. WHEN the user resolves a contradiction by keeping the existing fact, THE ContradictionDetector SHALL discard the new assertion and log the decision.
5. IF the ContradictionDetector cannot determine with sufficient confidence whether a contradiction exists, THEN THE ContradictionDetector SHALL skip the check silently rather than produce false positives.

### Requirement 11: Cross-Channel Memory Linking

**User Story:** As a user who communicates across Telegram and Discord, I want a shared semantic index across all channels with channel-aware filtering, so that the AI can recall relevant information regardless of where it was discussed.

#### Acceptance Criteria

1. THE VectorIndex SHALL maintain a single shared embedding store across all channels (Telegram and Discord).
2. WHEN performing a hybrid search, THE MemoryManager SHALL search across all channels by default and return results with their source ChannelKey.
3. WHERE the user or system specifies a channel filter, THE MemoryManager SHALL restrict search results to the specified channel.
4. WHEN assembling context, THE ContextAssembler SHALL annotate recalled memories with their source channel identifier so the LLM can distinguish origin.
5. THE MemoryIndex (FTS5) SHALL support cross-channel search by omitting the chatId filter when cross-channel mode is active.

### Requirement 12: Context Assembly Feedback Loop

**User Story:** As a system operator, I want the system to track whether recalled memories were useful and tune retrieval weights over time, so that context assembly becomes more relevant with use.

#### Acceptance Criteria

1. WHEN the LLM generates a response that references or builds upon a recalled memory, THE FeedbackTracker SHALL record a positive signal for that memory's retrieval.
2. WHEN the LLM generates a response that ignores all recalled memories in the context, THE FeedbackTracker SHALL record a neutral signal for those memories.
3. THE FeedbackTracker SHALL maintain a per-memory usefulness score derived from accumulated positive and neutral signals.
4. WHEN the MemoryManager ranks search results for context assembly, THE MemoryManager SHALL factor the usefulness score into the final ranking alongside relevance and importance scores.
5. THE FeedbackTracker SHALL store feedback signals in a dedicated SQLite table with columns for memory_id, signal_type, and timestamp.

### Requirement 13: Topic-Based Chunking for Compaction

**User Story:** As a user, I want compaction to segment conversations by topic rather than only by time, so that summaries are coherent and topic-focused rather than arbitrary time slices.

#### Acceptance Criteria

1. WHEN the CompactionEngine prepares messages for compaction, THE CompactionEngine SHALL identify topic boundaries within the conversation using semantic similarity between consecutive message groups.
2. WHEN topic boundaries are identified, THE CompactionEngine SHALL group messages into TopicChunks where each chunk contains semantically related messages.
3. WHEN generating compaction summaries, THE CompactionEngine SHALL produce one summary per TopicChunk rather than one summary per time window.
4. THE CompactionEngine SHALL fall back to time-based chunking when the EmbeddingProvider is unavailable or when topic detection produces chunks smaller than a configurable minimum size (MEMORY_MIN_TOPIC_CHUNK_SIZE, default 5 messages).
5. WHEN storing topic-based compaction summaries, THE CompactionEngine SHALL tag each CompactedMemory with a topic label derived from the chunk content.
