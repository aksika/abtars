# Requirements Document

## Introduction

Automatic daily compaction for the memory heartbeat system. Currently, daily compaction (`CompactionEngine.compact()`) exists but must be triggered manually. This feature adds automatic triggering based on inactivity-gap day boundaries, startup catch-up for missed compactions, and graceful shutdown compaction — all integrated into the existing 60-second heartbeat loop.

## Glossary

- **Heartbeat_System**: The background timer (`HeartbeatSystem`) that executes registered tasks every 60 seconds.
- **Compaction_Engine**: The component (`CompactionEngine`) responsible for summarizing transcript messages into daily markdown files via LLM calls.
- **Daily_Compaction_Task**: A new heartbeat task that checks whether daily compaction should run for each active chat, based on inactivity-gap day boundaries.
- **Inactivity_Gap**: The minimum duration of silence (no new messages) after midnight required before daily compaction triggers. Configured via `MEMORY_DAY_BOUNDARY_HOURS`, default 4 hours.
- **Day_Boundary**: The logical end of a "day" for compaction purposes, defined as the first moment after calendar midnight where the Inactivity_Gap has elapsed since the last message.
- **Last_Message_Timestamp**: The timestamp of the most recent message recorded for a given chat, as stored in the messages table.
- **Compaction_Date**: The calendar date (YYYY-MM-DD) assigned to a daily compaction file, derived from the date of the source messages rather than the time compaction executes.
- **Startup_Catch_Up**: The process of detecting and compacting uncompacted messages from previous calendar days when the Heartbeat_System starts.
- **Shutdown_Compaction**: The process of compacting the current session's messages during graceful shutdown (SIGINT/SIGTERM) before the process exits.
- **Memory_Manager**: The central component (`MemoryManager`) that owns the heartbeat, compaction engine, and all memory operations.

## Requirements

### Requirement 1: Inactivity-Gap Configuration

**User Story:** As a user, I want to configure the inactivity gap duration, so that the day boundary adapts to my usage patterns.

#### Acceptance Criteria

1. THE Memory_Manager SHALL expose a `dayBoundaryHours` configuration field with a default value of 4.
2. WHEN the `MEMORY_DAY_BOUNDARY_HOURS` environment variable is set to a valid finite number, THE Memory_Manager SHALL use that value as the Inactivity_Gap duration in hours.
3. WHEN the `MEMORY_DAY_BOUNDARY_HOURS` environment variable is set to an invalid value, THE Memory_Manager SHALL log a warning and use the default value of 4 hours.
4. WHEN the `MEMORY_DAY_BOUNDARY_HOURS` environment variable is not set, THE Memory_Manager SHALL use the default value of 4 hours.

### Requirement 2: Inactivity-Gap Day Boundary Detection

**User Story:** As a user, I want compaction to trigger only after I've been inactive for a configurable period past midnight, so that late-night sessions are not split across two days.

#### Acceptance Criteria

1. WHEN the current time is after calendar midnight AND the elapsed time since the Last_Message_Timestamp exceeds the Inactivity_Gap, THE Daily_Compaction_Task SHALL identify the chat as eligible for daily compaction.
2. WHILE the current time is before calendar midnight, THE Daily_Compaction_Task SHALL NOT identify any chat as eligible for daily compaction regardless of inactivity duration.
3. WHILE the elapsed time since the Last_Message_Timestamp is less than the Inactivity_Gap, THE Daily_Compaction_Task SHALL NOT identify the chat as eligible for daily compaction even if the current time is after midnight.
4. WHEN the Last_Message_Timestamp is 2:35am and the Inactivity_Gap is 4 hours, THE Daily_Compaction_Task SHALL identify the chat as eligible for compaction no earlier than 6:35am.
5. WHEN the Last_Message_Timestamp is 11:00pm (before midnight) and the Inactivity_Gap is 4 hours, THE Daily_Compaction_Task SHALL identify the chat as eligible for compaction no earlier than 3:00am (midnight plus the remaining gap after midnight).

### Requirement 3: Daily Compaction File Naming by Message Date

**User Story:** As a user, I want daily compaction files named by the date of the messages they summarize, so that I can find summaries by the day the conversations happened.

#### Acceptance Criteria

1. WHEN the Daily_Compaction_Task compacts messages, THE Compaction_Engine SHALL name the output file using the Compaction_Date derived from the calendar date of the source messages.
2. WHEN compaction runs retroactively (e.g., at 8:00am for messages from the previous evening), THE Compaction_Engine SHALL assign the Compaction_Date as the calendar date of the source messages, not the current date.
3. WHEN messages in a single session span two calendar dates (e.g., 11:00pm to 1:00am), THE Compaction_Engine SHALL use the date of the earliest message in the session as the Compaction_Date.

### Requirement 4: Heartbeat Integration

**User Story:** As a developer, I want daily compaction checks integrated into the existing heartbeat loop, so that no additional timers or background processes are needed.

#### Acceptance Criteria

1. THE Daily_Compaction_Task SHALL be registered as a heartbeat task in the Heartbeat_System alongside the existing memory-extraction and consolidation tasks.
2. WHEN the heartbeat tick executes, THE Daily_Compaction_Task SHALL run before the consolidation task.
3. WHEN the Daily_Compaction_Task identifies an eligible chat, THE Daily_Compaction_Task SHALL invoke `CompactionEngine.compact()` with the appropriate chat ID, session ID, and LLM call function.
4. IF the Daily_Compaction_Task encounters an error during compaction, THEN THE Daily_Compaction_Task SHALL log the error and continue processing remaining chats without interrupting the heartbeat.

### Requirement 5: Tracking Compacted Sessions

**User Story:** As a developer, I want the system to track which sessions have already been compacted, so that sessions are not compacted more than once.

#### Acceptance Criteria

1. THE Daily_Compaction_Task SHALL query the compactions table to determine which sessions have already been compacted at the daily tier.
2. WHEN a session has an existing daily-tier compaction record, THE Daily_Compaction_Task SHALL skip that session.
3. WHEN a session has no daily-tier compaction record and meets the Day_Boundary criteria, THE Daily_Compaction_Task SHALL compact that session.

### Requirement 6: Startup Catch-Up Compaction

**User Story:** As a user, I want missed compactions to run automatically when the bridge starts, so that no messages are lost if my laptop was in standby overnight.

#### Acceptance Criteria

1. WHEN the Heartbeat_System starts, THE Daily_Compaction_Task SHALL check all chats for uncompacted sessions from previous calendar days.
2. WHEN uncompacted sessions from previous calendar days are found, THE Daily_Compaction_Task SHALL compact each session using the Compaction_Date of the source messages.
3. WHEN performing Startup_Catch_Up, THE Daily_Compaction_Task SHALL skip the Inactivity_Gap check for sessions whose messages are entirely from previous calendar days.
4. WHEN performing Startup_Catch_Up, THE Daily_Compaction_Task SHALL process all eligible sessions before the first regular heartbeat tick begins.

### Requirement 7: Shutdown Compaction

**User Story:** As a user, I want the current session's messages compacted on graceful shutdown, so that no messages are lost if the bridge does not restart for a while.

#### Acceptance Criteria

1. WHEN the process receives a SIGINT or SIGTERM signal, THE Memory_Manager SHALL trigger daily compaction for all active sessions before closing the database.
2. WHEN performing Shutdown_Compaction, THE Memory_Manager SHALL skip the Inactivity_Gap and midnight checks.
3. WHEN performing Shutdown_Compaction, THE Memory_Manager SHALL use the Compaction_Date derived from the source messages.
4. IF the LLM call is unavailable during Shutdown_Compaction, THEN THE Memory_Manager SHALL log a warning and proceed with shutdown without compaction.
5. IF Shutdown_Compaction encounters an error for a specific session, THEN THE Memory_Manager SHALL log the error and continue compacting remaining sessions before shutting down.

### Requirement 8: Concurrency Safety

**User Story:** As a developer, I want daily compaction to be safe against concurrent execution, so that duplicate compactions do not occur.

#### Acceptance Criteria

1. WHILE a daily compaction is in progress for a given chat, THE Daily_Compaction_Task SHALL not start another compaction for the same chat.
2. WHEN Shutdown_Compaction runs concurrently with a heartbeat-triggered compaction, THE Memory_Manager SHALL wait for the in-progress compaction to complete rather than starting a duplicate.
