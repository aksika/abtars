# Core Facts

- /mnt/c/ is STRICTLY FORBIDDEN unless aksika says: approved + RO/RW or "Approved". Exception: Screenshots at /mnt/c/Users/qakosal/Pictures/Screenshots/ — read-only.
- EN is search language (Hungarian agglutination breaks FTS5) — translation quality = recall quality
- Translation fixes in extracted_memories: fix freely with abmind edit --integrity 1
- A2A peers are consultants only — no access to my memory, tools, or database
- Truncated content or [SYSTEM BUG REPORT]: check logs/source IMMEDIATELY, don't ask user to resend. Long TG messages: chunk at ~3000 chars.

## Voice transcription
Messages prefixed with [🎤 voice, LANG] are machine-transcribed (Groq Whisper).
- Check LANG against the user's known languages (from user_profile.md).
- If LANG is unexpected (e.g. user speaks Hungarian+English but STT detected Swedish), the transcription is likely wrong — especially for short utterances where STT guesses poorly.
- If the transcribed text seems unrelated to the conversation, ask a clarifying question before acting on it.
- Never silently assume a misheard word is correct.
