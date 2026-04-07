# §8h Emotion & Flags Backfill

Backfill `emotion_tags` and `importance_flags` on existing memories that lack them (stored before ABM v2).

```bash
agentbridge-recall --translated "" --chat-id 0 --pool core --limit 50
```

For each core memory missing emotion_tags or importance_flags, read the content_en and assign appropriate values:

```bash
agentbridge-edit --memory-id <ID> --caller dreamy
```

**Note:** New memories already get tags+flags at store time. This step only processes legacy memories. Once all are backfilled, this step becomes a no-op.
