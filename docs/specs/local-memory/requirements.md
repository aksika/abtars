# Requirements Document

## Introduction

The agentbridge project currently stores all session state in an in-memory Map that is lost on every restart. This feature adds a local-only, human-brain-inspired hierarchical memory layer — SQLite-backed persistence for sessions and conversation history, file-based session transcripts in JSONL format, tiered memory consolidation (daily → weekly → monthly summaries), full-text search (BM25) as the primary retrieval mechanism, optional local-model vector search for semantic recall, and dynamic context assembly with token budgets. The design is inspired by openclaw's memory system and the biological process of memory consolidation, but deliberately avoids any cloud API dependencies for the memory/embedding layer.

## Glossary

- **Memory_Store**: The SQLite database that persists session metadata, conversation messages, and search indexes on the local filesystem.
- **Session_Transcript**: A JSONL file on disk containing the ordered message history for a single chat session.
- **Transcript_Writer**: The component responsible for appending messages to Session_Transcript files and maintaining their integrity.
- **Transcript_Parser**: The component responsible for reading Session_Transcript JSONL files back into structured message objects.
- **Memory_Index**: The SQLite FTS5 full-text search index over conversation messages, used for BM25-ranked keyword retrieval.
- **Vector_Index**: An optional SQLite-backed vector store using a local embedding model for semantic similarity search.
- **Embedding_Provider**: A local-only embedding model (e.g. ONNX Runtime with a small transformer) that converts text into vector representations without cloud API calls.
- **Memory_Manager**: The top-level component that coordinates persistence, transcript I/O, indexing, and search across the memory layer.
- **Session_Manager**: The existing component (SessionManager class) that maps Telegram chat IDs to ACP sessions in memory.
- **Message_Record**: A structured object representing a single conversation turn, containing role, content, timestamp, chat ID, and session ID.
- **Disk_Budget**: A configurable maximum total size (in bytes) for all Session_Transcript files and the Memory_Store database combined.
- **Compacted_Memory**: A structured summary of a conversation session produced by the LLM, containing key facts, decisions, user preferences, and unresolved action items. Stored persistently and used as long-term context across sessions.
- **Compaction_Prompt**: A system-level prompt sent to the LLM along with the session transcript, instructing it to produce a Compacted_Memory summary.
- **Memory_Tier**: One of four hierarchical levels of memory storage — daily, weekly, monthly, or yearly — each representing a progressively more condensed summary of interactions.
- **Sleep_Cycle**: An automated or lazy-triggered consolidation process that rolls up lower-tier summaries into higher tiers (daily → weekly → monthly → yearly), mimicking biological memory consolidation.
- **Scratchpad**: A mutable markdown file (`scratchpad.md`) per chat that the agent can read and write during a session to track active tasks, uncompleted goals, and immediate context. Always injected into the context window.
- **User_Core_Facts**: A persistent markdown file containing immutable facts about the user extracted during yearly consolidation. Always injected alongside the system prompt as permanent context.
- **Soul_Config**: The agent's core identity file containing persona, constraints, and framework rules. Read-only, never altered by the agent.
- **Context_Assembly**: The process of dynamically building the LLM context window from tiered memory sources with fixed token budgets per tier.

## Requirements

### Requirement 1: Persist Session State in SQLite

**User Story:** As a bridge operator, I want session state to survive process restarts, so that active conversations are not lost when the bridge is restarted or crashes.

#### Acceptance Criteria

1. WHEN the Session_Manager creates a new session, THE Memory_Store SHALL insert a row containing the telegramChatId, acpSessionId, createdAt, and lastActivityAt fields.
2. WHEN the Session_Manager updates session activity, THE Memory_Store SHALL update the lastActivityAt timestamp for the corresponding session row.
3. WHEN the bridge process starts, THE Session_Manager SHALL restore all sessions from the Memory_Store whose lastActivityAt is within a configurable staleness threshold.
4. WHEN the Session_Manager resets a session, THE Memory_Store SHALL mark the corresponding session row as inactive.
5. IF the Memory_Store database file does not exist at startup, THEN THE Memory_Manager SHALL create the database with the required schema.
6. IF a write to the Memory_Store fails, THEN THE Memory_Manager SHALL log the error and allow the bridge to continue operating with in-memory-only state.

### Requirement 2: Record Conversation History as JSONL Transcripts

**User Story:** As a bridge operator, I want every conversation turn to be saved to disk, so that I have a durable log of all interactions.

#### Acceptance Criteria

1. WHEN a user sends a message to the bridge, THE Transcript_Writer SHALL append a Message_Record as a single JSON line to the Session_Transcript file for that chat.
2. WHEN the bridge sends a response to the user, THE Transcript_Writer SHALL append a Message_Record with role "assistant" to the same Session_Transcript file.
3. THE Transcript_Writer SHALL store Session_Transcript files under a configurable base directory, organized as `{baseDir}/transcripts/{chatId}/{sessionId}.jsonl`.
4. THE Transcript_Parser SHALL read a Session_Transcript JSONL file and return an ordered array of Message_Record objects.
5. FOR ALL valid Message_Record arrays, writing to a Session_Transcript via the Transcript_Writer then reading via the Transcript_Parser SHALL produce an equivalent array (round-trip property).
6. IF a write to a Session_Transcript file fails, THEN THE Transcript_Writer SHALL log the error and allow the bridge to continue operating without blocking the response.

### Requirement 3: Full-Text Search Over Conversation History

**User Story:** As a bridge operator, I want to search past conversations by keyword, so that relevant context can be retrieved for the agent.

#### Acceptance Criteria

1. WHEN a Message_Record is appended to a Session_Transcript, THE Memory_Index SHALL index the message content for full-text search.
2. WHEN a search query is submitted, THE Memory_Index SHALL return Message_Record references ranked by BM25 relevance score.
3. THE Memory_Index SHALL support filtering search results by chatId.
4. THE Memory_Index SHALL support filtering search results by a date range (start timestamp, end timestamp).
5. THE Memory_Index SHALL use SQLite FTS5 for full-text indexing.
6. WHEN a session is deleted, THE Memory_Index SHALL remove all indexed entries for that session.

### Requirement 4: Optional Local Vector Search for Semantic Retrieval

**User Story:** As a bridge operator, I want optional semantic search over past conversations using a local embedding model, so that contextually similar messages can be found even without exact keyword matches.

#### Acceptance Criteria

1. WHERE local vector search is enabled, THE Embedding_Provider SHALL generate vector embeddings using a local ONNX model without making cloud API calls.
2. WHERE local vector search is enabled, WHEN a Message_Record is indexed, THE Vector_Index SHALL store the embedding vector alongside the message reference in the Memory_Store.
3. WHERE local vector search is enabled, WHEN a semantic search query is submitted, THE Vector_Index SHALL return Message_Record references ranked by cosine similarity.
4. WHERE local vector search is enabled, THE Memory_Manager SHALL combine Vector_Index results with Memory_Index results using reciprocal rank fusion.
5. WHILE local vector search is disabled, THE Memory_Manager SHALL use only the Memory_Index for all search operations.
6. IF the local embedding model fails to load, THEN THE Memory_Manager SHALL log a warning and fall back to full-text search only.
7. THE Embedding_Provider SHALL cache computed embeddings in the Memory_Store keyed by the SHA-256 hash of the source text, so that identical text returns cached vectors and any content edit triggers re-embedding.

### Requirement 5: Configurable History Limits

**User Story:** As a bridge operator, I want to configure how many messages are retained per chat, so that storage usage stays within acceptable bounds.

#### Acceptance Criteria

1. THE Memory_Manager SHALL support a configurable maximum number of messages per chat (default: 1000).
2. WHEN the message count for a chat exceeds the configured limit, THE Memory_Manager SHALL remove the oldest messages beyond the limit from the Memory_Index.
3. WHEN the message count for a chat exceeds the configured limit, THE Memory_Manager SHALL remove the corresponding entries from the Vector_Index if vector search is enabled.
4. THE Memory_Manager SHALL retain the original Session_Transcript JSONL files on disk even after pruning index entries, preserving the full archival record.

### Requirement 6: Disk Budget Enforcement

**User Story:** As a bridge operator, I want to set a maximum disk usage for the memory layer, so that the bridge does not consume unbounded storage.

#### Acceptance Criteria

1. THE Memory_Manager SHALL support a configurable Disk_Budget (default: 500 MB).
2. WHEN the total size of all Session_Transcript files and the Memory_Store database exceeds the Disk_Budget, THE Memory_Manager SHALL delete the oldest Session_Transcript files until usage falls below the budget.
3. WHEN a Session_Transcript file is deleted due to budget enforcement, THE Memory_Manager SHALL also remove the corresponding entries from the Memory_Index and Vector_Index.
4. THE Memory_Manager SHALL check disk usage on startup and after every 100 message writes.

### Requirement 7: Configuration Integration

**User Story:** As a bridge operator, I want to configure the memory layer through environment variables, so that setup is consistent with the existing bridge configuration pattern.

#### Acceptance Criteria

1. THE Memory_Manager SHALL read configuration from environment variables: MEMORY_ENABLED (boolean, default true), MEMORY_DIR (path, default ~/.agentbridge/memory), MEMORY_MAX_MESSAGES_PER_CHAT (number, default 1000), MEMORY_DISK_BUDGET_MB (number, default 500), MEMORY_VECTOR_ENABLED (boolean, default false), MEMORY_COMPACT_ON_RESET (boolean, default false), MEMORY_AUTO_COMPACT_THRESHOLD (number, default 3000), MEMORY_CONTEXT_BUDGET_SOUL (number, default 500), MEMORY_CONTEXT_BUDGET_SCRATCHPAD (number, default 300), MEMORY_CONTEXT_BUDGET_RECALLED (number, default 600), MEMORY_CONTEXT_BUDGET_WORKING (number, default 2000).
2. WHEN MEMORY_ENABLED is false, THE Memory_Manager SHALL not initialize the Memory_Store, and the bridge SHALL operate with in-memory-only state as it does today.
3. IF MEMORY_DIR does not exist at startup, THEN THE Memory_Manager SHALL create the directory and all required subdirectories.
4. THE Memory_Manager SHALL validate all configuration values at startup and log warnings for invalid values while falling back to defaults.

### Requirement 8: Session Restoration on Startup

**User Story:** As a bridge operator, I want the bridge to automatically restore recent sessions on restart, so that users can continue conversations without manual intervention.

#### Acceptance Criteria

1. WHEN the bridge starts with MEMORY_ENABLED set to true, THE Session_Manager SHALL query the Memory_Store for sessions with lastActivityAt within the staleness threshold (default: 24 hours).
2. WHEN restoring a session, THE Session_Manager SHALL load the most recent N messages (configurable, default 50) from the Session_Transcript to provide conversation context.
3. IF a restored session's ACP backend is no longer reachable, THEN THE Session_Manager SHALL mark the session as inactive in the Memory_Store and create a new ACP session while preserving the conversation history.
4. THE Session_Manager SHALL log the number of sessions restored at startup.

### Requirement 10: Session Compaction via /compact Command

**User Story:** As a bridge operator, I want the model or user to trigger a `/compact` command that summarizes the current session into a daily memory snapshot, so that key facts and decisions survive across session resets and feed into the hierarchical consolidation pipeline.

#### Acceptance Criteria

1. WHEN a user or the model sends `/compact`, THE Memory_Manager SHALL load the current session transcript and send it to the LLM with a Compaction_Prompt requesting a structured summary.
2. WHEN the LLM returns a Compacted_Memory summary, THE Memory_Manager SHALL persist it as a daily-tier file at `{baseDir}/memory/daily/{chatId}/YYYY-MM-DD.md`.
3. WHEN a Compacted_Memory is persisted, THE Memory_Manager SHALL also store a row in the Memory_Store `compactions` table with chatId, source sessionId, timestamp, tier, and summary content.
4. WHEN MEMORY_COMPACT_ON_RESET is true, THE Memory_Manager SHALL automatically trigger compaction before a session reset via `/new`.
5. IF the LLM compaction request fails, THEN THE Memory_Manager SHALL log the error and continue without producing a Compacted_Memory.
6. THE Compacted_Memory SHALL be indexed in the Memory_Index for full-text search, allowing past compactions to be found via keyword queries.
7. IF multiple compactions occur on the same day for the same chat, THE Memory_Manager SHALL append to the existing daily file rather than overwriting it.

### Requirement 12: Hierarchical Memory Consolidation (Sleep Cycles)

**User Story:** As a bridge operator, I want daily summaries to be automatically consolidated into weekly, monthly, and yearly summaries, so that long-term memory remains compact and token-efficient without manual intervention.

#### Acceptance Criteria

1. WHEN a new session starts for a chat, THE Memory_Manager SHALL check if any pending consolidation is needed (daily → weekly, weekly → monthly, monthly → yearly) and run it lazily.
2. WHEN 7 or more daily files exist for a chat within the same ISO week, THE Memory_Manager SHALL consolidate them into a single weekly file at `{baseDir}/memory/weekly/{chatId}/YYYY-Wxx.md` and delete the source daily files.
3. WHEN 4 or more weekly files exist for a chat within the same month, THE Memory_Manager SHALL consolidate them into a single monthly file at `{baseDir}/memory/monthly/{chatId}/YYYY-MM.md` and delete the source weekly files.
4. WHEN 12 or more monthly files exist for a chat within the same year, THE Memory_Manager SHALL consolidate them into a single yearly file at `{baseDir}/memory/yearly/{chatId}/YYYY.md` and delete the source monthly files.
5. EACH consolidation step SHALL send the source files' content to the LLM with a tier-appropriate Compaction_Prompt that instructs progressively more aggressive summarization.
6. IF a consolidation LLM call fails, THEN THE Memory_Manager SHALL log the error and retain the source files unchanged, retrying on the next session start.
7. THE Memory_Manager SHALL update the Memory_Index and Vector_Index (if enabled) to reflect consolidated content, removing entries for deleted source files and indexing the new summary.
8. DURING yearly consolidation, THE Memory_Manager SHALL also extract permanent user facts and append them to User_Core_Facts.md.

### Requirement 13: Scratchpad (Mid-Term Active Memory)

**User Story:** As a bridge operator, I want the agent to have a mutable scratchpad file per chat for tracking active tasks and goals, so that the agent stays oriented across messages without replaying full conversation history.

#### Acceptance Criteria

1. THE Memory_Manager SHALL maintain a `scratchpad.md` file per chat at `{baseDir}/scratchpads/{chatId}/scratchpad.md`.
2. THE agent SHALL be able to read and write to the Scratchpad via dedicated tool calls or message annotations.
3. WHEN assembling context for the LLM, THE Memory_Manager SHALL always inject the current Scratchpad content into the context window.
4. THE agent SHALL be instructed (via system prompt) to erase completed items from the Scratchpad to keep it concise.
5. WHEN a session is reset via `/new`, THE Scratchpad SHALL be preserved (not cleared), carrying active tasks into the new session.
6. IF the Scratchpad file does not exist, THE Memory_Manager SHALL create an empty one on first access.

### Requirement 14: User Core Facts (Permanent Memory)

**User Story:** As a bridge operator, I want the system to maintain a persistent file of immutable facts about the user, so that critical preferences and identity information are never lost through compaction cycles.

#### Acceptance Criteria

1. THE Memory_Manager SHALL maintain a `user_core_facts.md` file per chat at `{baseDir}/core/{chatId}/user_core_facts.md`.
2. DURING yearly consolidation, THE Memory_Manager SHALL instruct the LLM to extract permanent, immutable facts about the user and append them to User_Core_Facts.
3. WHEN assembling context for the LLM, THE Memory_Manager SHALL always inject User_Core_Facts content into the context window alongside the system prompt.
4. DURING yearly consolidation, THE Memory_Manager SHALL instruct the LLM to read all existing User_Core_Facts, merge them with newly extracted facts, and produce a holistically deduplicated rewrite — removing redundant or contradictory entries while preserving all unique facts.
5. THE user SHALL be able to manually edit User_Core_Facts via a `/facts` command or by editing the file directly.
6. IF User_Core_Facts does not exist, THE Memory_Manager SHALL create an empty one on first access.

### Requirement 15: Dynamic Context Assembly with Token Budgets

**User Story:** As a bridge operator, I want the LLM context window to be assembled efficiently from tiered memory sources with fixed token budgets, so that the agent has maximum relevant context without exceeding token limits.

#### Acceptance Criteria

1. WHEN assembling context for the LLM, THE Memory_Manager SHALL inject components in this priority order: (1) Soul/system prompt + User_Core_Facts, (2) Scratchpad, (3) Recalled memories from hybrid search over the archive, (4) Working memory (last N raw messages), (5) New user input.
2. EACH context tier SHALL have a configurable maximum token budget: Soul+Facts (default 500), Scratchpad (default 300), Recalled Memories (default 600), Working Memory (default 2000).
3. WHEN the Recalled Memories tier is assembled, THE Memory_Manager SHALL run a hybrid search (BM25 + optional vector) over the memory archive and return the top K results (default K=3) capped at the tier's token budget.
4. WHEN the Working Memory tier exceeds its token budget, THE Memory_Manager SHALL truncate from the oldest messages, keeping the most recent ones.
5. THE Memory_Manager SHALL expose a `assembleContext(chatId, userInput)` method that returns the fully assembled context string respecting all tier budgets.

### Requirement 16: Mid-Session Auto-Compaction

**User Story:** As a bridge operator, I want the system to silently compact early messages when the working-memory transcript grows too large during a single session, so that context is not lost if the user never explicitly runs `/compact`.

#### Acceptance Criteria

1. THE Memory_Manager SHALL support a configurable auto-compact token threshold via `MEMORY_AUTO_COMPACT_THRESHOLD` (number, default 3000 tokens).
2. WHEN the estimated token count of the current session transcript exceeds the configured threshold, THE Memory_Manager SHALL silently trigger a daily compaction of the oldest messages up to the threshold boundary, without interrupting the conversation.
3. AFTER a mid-session auto-compaction, THE Memory_Manager SHALL remove the compacted messages from the working-memory window while retaining them in the JSONL transcript on disk.
4. THE mid-session auto-compaction SHALL produce the same daily-tier file output as a manual `/compact`, appending to the existing daily file if one already exists.
5. IF the auto-compaction LLM call fails, THE Memory_Manager SHALL log the error and continue without compacting, retrying on the next threshold check.

### Requirement 11: Transcript Serialization Round-Trip Integrity

**User Story:** As a developer, I want the JSONL transcript format to be lossless, so that no conversation data is corrupted during write/read cycles.

#### Acceptance Criteria

1. THE Transcript_Writer SHALL serialize each Message_Record as a single valid JSON line containing: role (string), content (string), timestamp (number), chatId (number), and sessionId (string).
2. THE Transcript_Parser SHALL deserialize each JSON line back into a Message_Record with identical field values.
3. FOR ALL valid Message_Record objects, serializing via the Transcript_Writer then deserializing via the Transcript_Parser SHALL produce an object with identical field values (round-trip property).
4. IF a JSON line in a Session_Transcript is malformed, THEN THE Transcript_Parser SHALL skip the malformed line, log a warning, and continue parsing subsequent lines.