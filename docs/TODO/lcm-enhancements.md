# LCM-Inspired Memory Enhancements

Created: 2026-03-19
Source: lossless-claw comparison (github.com/martian-engineering/lossless-claw)

## Stage 1: Source Linking + agentbridge-expand (highest impact)

- [ ] Task 1: Add `source_message_ids TEXT` column to `extracted_memories` (migration in memory-db.ts)
- [ ] Task 2: Wire `--source-ids` param into agentbridge-store CLI + instantStore()
- [ ] Task 3: Update agentbridge-recall output to show expand hints when source IDs exist
- [ ] Task 4: Create `agentbridge-expand --ids 451,452,453` CLI (read-only, JSON output) + steering file
- [ ] Task 5: Update sleep template §6 to pass `--source-ids` when calling agentbridge-store

## Stage 2: Sleep Retry Logic

- [ ] Task 6: Replace `spawnedToday: boolean` → `attemptsToday: number` (max 2) + `lastAttemptTime` (1h cooldown)
- [ ] Task 7: Add immediate retry (1x, 30s delay) in main.ts sleep spawn; both count as 1 trigger
- [ ] Task 8: Update sleep-trigger.test.ts for new retry semantics

## Stage 3: Bootstrap Reconciliation (detect-only)

- [ ] Task 9: JSONL line count vs DB row count check on startup → logWarn on drift

## Stage 4: Consolidation Source Linking (template-only)

- [ ] Task 10: Add `## Sources` section instructions to sleeping_prompt.md §1 (daily/weekly/quarterly)

## Stage 5: Large Message Interception (low priority)

- [ ] Task 11: recordMessage() size check >50K chars → file overflow + DB reference; recall/expand read from file
