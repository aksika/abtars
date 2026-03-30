# §10 Report

Before writing the report, review everything you did in this session. If you notice anything you missed or should have done differently, **fix it now**.

Then write the sleep audit to `~/.agentbridge/memory/sleep/sleep_${AUDIT_FILENAME}.md`:

Include:
- **Retrospective:** written to `retrospectives/retro_${WAKEUP_DATE}.md` (yes/no, key insight)
- **Feedback:** memories boosted/demoted (count)
- **Todos:** items added (count)
- **GC summary:**
  - Messages immediately deleted (dupes + wrong chat + STT): count
  - Messages garbage-marked this cycle: count
  - Expired garbage purged: count
  - Conversations compacted (N messages → 1 extracted): count
  - Emotion scores updated: list of (memory_id, old → new)
- **Messages flushed:** count (>24h old)
- **DB maintenance:** WAL checkpoint, FTS rebuilds, embeddings
- **Anomaly audit:** auto-fixed count, flagged count
- **Consolidation:** daily file written (yes/no), rollups created
- **Fitness:** memories pruned/merged (count)
- **Disk:** ${DISK_USAGE_MB} MB / ${DISK_BUDGET_MB} MB (flag if >80%)

## Flagged for Review

Append all accumulated flags from every step under `## Flagged for Review` in the retro file (`~/.agentbridge/memory/retrospectives/retro_${WAKEUP_DATE}.md`). KP will pick these up on wake-up.

Respond with "Sleep cycle complete" and a one-line summary.
