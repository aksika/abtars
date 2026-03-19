# LCM-Inspired Memory Enhancements

Created: 2026-03-19
Source: lossless-claw comparison (github.com/martian-engineering/lossless-claw)

## Stage 1: Source Linking + agentbridge-expand (highest impact)

- [ ] Task 1: Add `source_message_ids TEXT` column to `extracted_memories` — **merge with Darwinism Stage 1 schema migration**
- [ ] Task 2: Wire `--source-ids` param into agentbridge-store CLI — **merge with Darwinism Tasks 4-5 (--confidence, --boost, --demote)**
- [ ] Task 3: Update agentbridge-recall output to show expand hints when source IDs exist
- [ ] Task 4: Create `agentbridge-expand --ids 451,452,453` CLI (read-only, JSON output) + steering file
- [ ] Task 5: Update sleep template to pass `--source-ids` when calling agentbridge-store — **merge with Darwinism Task 11 (--confidence)**

## Stage 2: Sleep Retry Logic — ✅ DONE (commit d08ba31)

## Stage 3: Bootstrap Reconciliation — ✅ DONE (commit d08ba31)

## Stage 4: Consolidation Source Linking — merge with Darwinism Stage 4 sleep template restructure

## Stage 5: Large Message Interception — TODO (safety net for A2A / Browsie oversized payloads)

- [ ] Intercept oversized messages before they hit the memory pipeline
- [ ] Write overflow to file, replace message body with summary + file path reference
- [ ] Threshold: configurable, default ~8K chars
