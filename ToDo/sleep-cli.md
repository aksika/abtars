The Sleep CLI 
Sleeping routine during overnight: Memory tidyness
Call a subagent: most skilled model, currently Opus 4.6 preferred

- Daily/weekly/Quarterly compactions - this is exsisting needs to be fixed, se plan below
- SQLite database cleaning!!
- Topics: we will review and reorganize the topic files for tidyness and clarity

- Timestep and bulletpoint description what happend in the cylce into the the memory log for audit trail


--
Preplanning how to solve the existing problems with th edaily compaction.

We want to restructure the memory directory so that each day gets its own working directory where sources accumulate throughout
the day. When the sleep cycle runs (on day change or catch-up), it consolidates each day's sources into a single daily_YYYYMMDD.md file and deletes the
working directory. The consolidation pipeline (daily→weekly→quarterly) then works off those consolidated daily files.

Implementation Plan — Daily Working Directory + Sleep Cycle Consolidation:

Problem Statement:
The current memory layout is flat and fragile — compact() writes directly to final daily files, there's no separation between "work in progress" and "done",
and catch-up after crashes produces one blob instead of per-day files.

Requirements:
- Each calendar day gets a working directory under ~/.agentbridge/memory/working/YYYY-MM-DD/
- Transcript compaction writes source files into today's working directory
- On day change, the sleep cycle consolidates all sources from each past day's working directory into daily/daily_YYYYMMDD.md
- After consolidation, the working directory is deleted
- Crash recovery: sleep cycle scans for any working directories older than today and consolidates them all
- The existing consolidation pipeline (daily→weekly→quarterly) continues to work off the daily/ directory

Background:
- compact() currently writes directly to memory/daily/<chatId>/YYYY-MM-DD.md
- getLatestCompaction() reads from the compactions DB table (not filesystem) — no change needed
- SleepCycleRunner.runWeeklyRollups() reads from memory/daily/<chatId>/ — needs path update
- MemorySearchTool uses DB/FTS only — no change needed
- context-assembler uses getLatestCompaction() (DB) — no change needed

Proposed directory layout:
~/.agentbridge/memory/
  working/
    2026-03-08/                              ← today's active working dir
      transcript_7773842843.md               ← compacted transcript source
    2026-03-07/                              ← missed day (crash recovery)
      transcript_7773842843.md
  daily/
    daily_20260306.md                        ← consolidated final output
    daily_20260305.md
  weekly/
    2026-W09.md                              ← from consolidation pipeline
  quarterly/
    2026-Q1.md


Task Breakdown:

Task 1: Restructure CompactionEngine.compact() to write into working directory
- Objective: Change compact() to write source files into memory/working/YYYY-MM-DD/ instead of memory/daily/<chatId>/
- The file is named transcript_<chatId>.md (one per chat per day)
- Group messages by calendar day before compacting — each day gets its own compact() call
- The compactionDate determines which working directory to write into
- DB row still gets inserted into compactions table (for watermark tracking)
- Append behavior preserved: if transcript_<chatId>.md already exists in the day dir, append with --- separator
- Demo: compact() writes to memory/working/2026-03-08/transcript_7773842843.md

Task 2: Add per-day message grouping to daily-compaction-task.ts
- Objective: The heartbeat task and startup catch-up must group uncompacted messages by calendar day and call compact() once per day
- Add a groupMessagesByDay() helper that takes the uncompacted messages (filtered by watermark) and groups them by YYYY-MM-DD
- Each group gets its own compact() call with the correct compactionDate
- Skip today's messages (they're still accumulating)
- Demo: After a 5-day gap, the heartbeat produces 5 separate source files in 5 working directories

Task 3: Create the daily consolidation sleep task
- Objective: New sleep task that scans memory/working/ for directories older than today, reads all source files in each, LLM-consolidates them into a single
daily/daily_YYYYMMDD.md, then deletes the working directory
- Register as a heartbeat task named "daily-consolidation" (runs after daily-compaction)
- For each past-day working directory found:
  - Read all .md files in it
  - Concatenate with --- separators
  - Call LLM with the daily consolidation prompt
  - Write to daily/daily_YYYYMMDD.md
  - Insert consolidation record into compactions table with tier "daily-final" (or reuse "daily")
  - Delete the working directory (rm -rf)
- Crash recovery is automatic: any working dir that isn't today gets consolidated
- Demo: After restart, old working dirs 2026-03-02/ through 2026-03-07/ each get consolidated into their own daily_YYYYMMDD.md

Task 4: Update SleepCycleRunner to read from new daily/ layout
- Objective: runWeeklyRollups() currently reads from memory/daily/<chatId>/. Update to read from memory/daily/ (flat, no chatId subdirectory since files are
now named daily_YYYYMMDD.md)
- Update file pattern matching for the new naming convention
- The weekly/monthly/yearly consolidation logic stays the same
- Demo: Weekly rollup correctly finds 7+ daily_*.md files and consolidates them

Task 5: Update shutdownCompaction in MemoryManager
- Objective: Shutdown compaction should write to working directories (same as Task 1) and NOT attempt consolidation (that's the sleep task's job)
- This ensures a clean shutdown saves today's transcript to the working dir, and the next startup's sleep cycle will consolidate any past days
- Demo: Clean shutdown writes memory/working/2026-03-08/transcript_7773842843.md, next startup consolidates any past-day dirs

Task 6: Wire everything together and update tests
- Objective: Register the new daily-consolidation task in startHeartbeat(), update existing tests for new paths, verify the full flow
- Update startHeartbeat() to register the consolidation task after the compaction task
- Update test helpers that create daily files to use new directory structure
- Verify: heartbeat compaction → working dir → sleep consolidation → daily file → weekly rollup
- Demo: Full end-to-end flow works: messages → working dir → consolidated daily → weekly rollup

