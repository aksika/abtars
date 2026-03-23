# Requirements Document

## Introduction

Instant Memory Store enables the agent to immediately persist important information from user messages by invoking a dedicated `instant_store` tool. Instead of relying on regex-based cue phrase detection, the LLM agent itself decides when a message contains information worth remembering — leveraging its full understanding of context, emotion, and intent. This bypasses the normal heartbeat-driven extraction delay for high-priority memories.

The agent also assesses the user's emotional state and provides an `emotion_score` with each stored memory, enabling emotion-boosted recall ranking.

## Glossary

- **Instant_Store_Tool**: A shell command (`agentbridge-store`) that the LLM agent invokes to immediately persist one or more memories. The agent decides when to call it based on its understanding of the conversation.
- **Memory_Manager**: Top-level coordinator for the local memory layer, owning the SQLite database, transcript I/O, FTS index, and sub-components including heartbeat-based extraction.
- **Heartbeat_System**: Background timer that periodically runs registered tasks including batch memory extraction from conversation transcripts.
- **Message_Pipeline**: The message handling flow in main.ts that receives user messages from Telegram/Discord, assembles context, sends to transport, and delivers responses.
- **Platform_API**: The Telegram or Discord API interface used to send confirmation messages back to the user.
- **Extracted_Memory**: A structured record stored in the `extracted_memories` table with fields: content_en, content_original, memory_type, preserve_original, preserved_keyword, emotion_score.
- **Emotion_Score**: An integer value from -5 to +5 representing the user's emotional valence at the time of the message. Based on the psychological Valence dimension of the VAD (Valence-Arousal-Dominance) model. Negative values indicate negative emotions, positive values indicate positive emotions.
- **Agent**: The LLM (e.g., Claude) running inside Kiro that processes user messages, generates responses, and can invoke tools.

## Requirements

### Requirement 1: Agent-Initiated Memory Storage

**User Story:** As a user, I want the bot to intelligently decide when something I say is worth remembering, so that important information is stored immediately without me needing to use specific keywords.

#### Acceptance Criteria

1. THE Agent SHALL have access to an `instant_store` tool (via `agentbridge-store` CLI command) that accepts structured memory data and persists it immediately.
2. THE Agent SHALL invoke the `instant_store` tool when it determines a user message contains information worth remembering, including but not limited to:
   - Explicit storage requests ("remember this", "emlékezz", "don't forget", "jegyezd meg")
   - Frustration signals indicating repeated information ("I told you", "már mondtam", "how many times")
   - Emotionally significant statements (strong positive or negative sentiment)
   - Important facts, decisions, or preferences expressed by the user
3. THE Agent SHALL NOT invoke the `instant_store` tool for routine conversational messages, greetings, confirmations ("ok", "yes", "got it"), or messages that don't contain memorable information.
4. THE Agent SHALL determine the appropriate `emotion_score` for each memory based on its understanding of the message's emotional content, tone, and context.
5. THE Agent SHALL provide both English (`content_en`) and original language (`content_original`) versions of the memory content.
6. THE Agent SHALL classify each memory with an appropriate `memory_type` ("fact", "decision", "preference", or "event").

### Requirement 2: Instant Store Tool Interface

**User Story:** As a developer, I want a clean CLI interface for the instant store tool, so that the agent can invoke it consistently across platforms.

#### Acceptance Criteria

1. THE system SHALL provide an `agentbridge-store` CLI command that accepts the following parameters:
   - `--content-en` (required): The memory content in English
   - `--content-original` (required): The memory content in the user's original language
   - `--memory-type` (required): One of "fact", "decision", "preference", "event"
   - `--emotion-score` (required): Integer from -5 to +5
   - `--chat-id` (required): The chat ID for the memory
   - `--keyword` (optional): A preserved keyword from the original message
2. THE `agentbridge-store` command SHALL validate all inputs and return a JSON result indicating success or failure.
3. THE `agentbridge-store` command SHALL clamp `emotion_score` to [-5, +5] if the provided value is outside range.
4. THE `agentbridge-store` command SHALL default `emotion_score` to 0 if the provided value is not a valid integer.
5. THE `agentbridge-store` command SHALL store the memory with `preserve_original = true`.

### Requirement 3: Immediate Memory Persistence

**User Story:** As a user, I want the fact the bot decided to remember to be stored right away, so that it is available for recall in subsequent conversations without delay.

#### Acceptance Criteria

1. WHEN the `agentbridge-store` command is invoked, THE Memory_Manager SHALL insert the memory into the `extracted_memories` table within the same execution cycle.
2. THE Memory_Manager SHALL store the memory with both `content_en` and `content_original` fields populated.
3. THE Memory_Manager SHALL set `preserve_original = true` on all instantly stored memories.
4. THE Memory_Manager SHALL populate the `preserved_keyword` field when the `--keyword` parameter is provided.
5. IF the database write fails, THEN THE `agentbridge-store` command SHALL return an error JSON and not advance the watermark.

### Requirement 4: Heartbeat Extraction Bypass

**User Story:** As a user, I want instantly stored memories to not be re-extracted by the background heartbeat process, so that duplicate memories are avoided.

#### Acceptance Criteria

1. WHEN the `agentbridge-store` command successfully stores a memory, THE Memory_Manager SHALL advance the extraction watermark for that chat to cover the current timestamp.
2. WHEN the Heartbeat_System runs its next extraction cycle for a chat, THE Heartbeat_System SHALL skip messages whose timestamps are at or before the extraction watermark, including messages that triggered instant storage.

### Requirement 5: User Confirmation Feedback

**User Story:** As a user, I want to receive a brief confirmation when the bot has stored my memory, so that I know the information was captured.

#### Acceptance Criteria

1. WHEN the `agentbridge-store` command successfully stores a memory, THE command SHALL output a JSON result containing `{ stored: true, lang, memoriesCount }`.
2. THE Agent SHALL use the tool result to decide whether and how to acknowledge the storage to the user in its response.
3. THE Agent SHOULD naturally weave the acknowledgment into its response rather than sending a separate confirmation message.

### Requirement 6: Skill Definition

**User Story:** As a developer, I want the instant store tool to be documented as a skill, so that the agent knows when and how to use it.

#### Acceptance Criteria

1. THE system SHALL provide a `SKILL.md` file at `skills/instant-store/SKILL.md` that describes the tool's purpose, parameters, and usage guidelines.
2. THE SKILL.md SHALL include clear "when to use" guidance covering: explicit storage requests, frustration signals, emotionally significant statements, and important facts/decisions/preferences.
3. THE SKILL.md SHALL include clear "when NOT to use" guidance covering: routine messages, greetings, confirmations, and information already in the current conversation context.
4. THE SKILL.md SHALL include the emotion score scale with examples for each level.
5. THE SKILL.md SHALL follow the same format as the existing `skills/memory-search/SKILL.md`.

### Requirement 7: Emotion Score on Extracted Memories

**User Story:** As a user, I want the bot to capture my emotional state when storing memories, so that recalled memories carry emotional context.

#### Acceptance Criteria

1. THE `extracted_memories` table SHALL include an `emotion_score` INTEGER column with a default value of 0.
2. THE Agent SHALL assess the user's emotional valence using the following scale:
   - `-5` = angry (e.g., profanity, aggressive tone)
   - `-3` = frustrated (e.g., repeated complaints, exasperation)
   - `-1` = slightly negative (e.g., mild disappointment)
   - `0` = neutral (e.g., factual statements)
   - `+1` = slightly positive (e.g., mild satisfaction)
   - `+3` = pleased (e.g., gratitude, enthusiasm)
   - `+5` = happy (e.g., excitement, joy)
3. THE `emotion_score` SHALL be clamped to the range [-5, +5]; any value outside this range SHALL be clamped to the nearest boundary.
4. THE ExtractedMemory type in `src/types/memory.ts` SHALL include an `emotion_score: number` field.
5. THE existing heartbeat-driven MemoryExtractor SHALL also extract `emotion_score` for each memory during batch extraction.
6. THE `emotion_score` SHALL be stored alongside the memory in the `extracted_memories` table and included in search results.
7. IF the provided `emotion_score` is not a valid integer, THEN the value SHALL default to 0 (neutral).

### Requirement 8: Emotion-Boosted Memory Recall Ranking

**User Story:** As a user, I want emotionally significant memories to rank higher in search results, so that the bot prioritizes information that was important to me when I stored it.

#### Acceptance Criteria

1. WHEN the memory search pipeline ranks extracted memories, THE ranking algorithm SHALL apply an emotion boost factor based on the absolute value of the `emotion_score`.
2. THE emotion boost SHALL use the `log1p` dampening formula: `boost = EMOTION_BOOST_WEIGHT * log1p(abs(emotion_score))`.
3. THE emotion boost SHALL be additive to the existing BM25/relevance score: `final_score = bm25_score + EMOTION_BOOST_WEIGHT * log1p(abs(emotion_score))`.
4. THE `EMOTION_BOOST_WEIGHT` SHALL be a named constant (default: `0.5`) defined in a single location.
5. THE emotion boost SHALL apply to the L2 (extracted memories English) and L4 (extracted memories original language) search layers.
6. THE emotion boost SHALL be computed in the application layer after the FTS5 query returns BM25 scores.
