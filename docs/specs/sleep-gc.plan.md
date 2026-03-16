# Sleep GC (Garbage Collection) — Implementation Plan

## Problem
KP's message DB accumulates noise (greetings, repeated probes, duplicates, emotional reactions with no info content). Dreamy should clean this up during sleep, preserving emotional signals before deleting.

## Requirements
- Dreamy scans all messages each sleep cycle
- Emotional noise → extract emotion_score to relevant memory, then mark garbage
- Pure noise (greetings, pings, filler) → mark garbage
- Repeated probes (same question 3+ times, answer already stored) → keep first + answer, mark rest
- Duplicates (same content within 5 min) → immediate delete
- Wrong chat messages → immediate delete
- Garbage marked >7 days ago → hard delete
- Tracking via `~/.agentbridge/memory/garbage.json`
- Both user AND paired assistant messages get garbage-marked/deleted

## Bug fixes bundled
- `rebuild-db.ts` — apply `stripEmojis()` before insert
- `recordMessage()` — skip if content empty after emoji strip

## Tasks

### Task 1: Fix rebuild-db.ts emoji stripping + empty content guard
- Add `stripEmojis()` to rebuild script
- Fix `recordMessage()` to skip if content empty after strip
- Tests: unit test empty-after-strip skipped; unit test rebuild strips emojis

### Task 2: Update sleeping prompt §3 with GC instructions
- Replace "DO NOT delete messages" safety rule with GC protocol
- Add §3a "Garbage Collection":
  - Immediate delete: duplicates (same content, same chat, within 5 min), wrong-chat
  - Emotion harvest: recognize emotional reactions, update emotion_score on nearest extracted_memory via agentbridge-store, then mark garbage
  - Pure noise: Dreamy uses judgment (greetings/pings/filler), mark garbage
  - Repeated probes: 3+ times, answer in extracted_memories → keep first + answer, mark rest
  - garbage.json: `{"<message_id>": "<ISO timestamp>"}`
  - Dreamy uses sqlite3 for deletes, agentbridge-store for emotion updates
- Update sleep-trigger unit tests

### Task 3: Integration test — sleep cycle diff
- `scripts/test-sleep-gc.sh`:
  1. Copy live memory.db to /tmp/agentbridge-gc-test/
  2. Snapshot pre-sleep: message count, extracted_memories count, emotion_scores
  3. Run one sleep cycle against copy
  4. Snapshot post-sleep
  5. Diff report to stdout
- Validates no data corruption, FTS in sync

### Task 4: Deploy and verify
- Build, deploy sleeping prompt
- Add garbage.json to ~/.agentbridge/.gitignore
- Update as-built docs
- Commit to main repo only (backup repo handled by daily cron)
