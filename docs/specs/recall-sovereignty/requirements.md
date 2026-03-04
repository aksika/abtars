# Recall Sovereignty — Requirements

## Problem Statement

The bridge's `RecallFallbackPipeline` auto-injects `[RECALLED MEMORIES]` into every message sent to Kiro. For short/generic messages like "Ok do it now", it pulls in irrelevant old memories from the same chatId across all sessions, causing Kiro to execute the wrong task.

### Incident (2026-03-04)

1. Active conversation about fixing cron/update.sh PATH issue on remote Mac
2. Kiro applied the fix, suggested testing: *"Holnap 12:05-kor már futnia kell. Ha nem akarsz várni, most is tesztelheted..."*
3. User replied: **"Ok do it now"** (meaning: run the update.sh test)
4. The `RecallFallbackPipeline` searched for memories matching "Ok do it now"
5. Primary FTS5 found nothing (too generic), fell through to fallback stages
6. Fallback injected 2-day-old memories about Whisper STT language config, Alexa, Taylor Swift
7. Kiro interpreted "Ok do it now" as "apply the Whisper language change" from the old conversation
8. **Result**: Kiro modified `openclaw.json` Whisper config instead of running the update test — an unauthorized config change

### Root Cause

The `RecallFallbackPipeline` runs on **every message unconditionally**. The `IntentDetector` only optimizes the search path for explicit recall requests — it does not gate whether recall happens at all. The bridge has zero understanding of conversation flow and cannot judge when recall is appropriate.

## Requirements

### REQ-1: Agent-Driven Recall
Memory recall must be initiated by the agent (Kiro), not the bridge. Kiro has full conversation context and can judge when recall is needed. The bridge must not inject recalled memories into the assembled context.

### REQ-2: Shell-Callable Recall Skill
Provide a standalone CLI tool (`agentbridge-recall`) that Kiro can invoke via its shell tool when it decides recall is needed. The tool must:
- Accept keywords (English), optional original-language keyword, optional time range, and chat ID
- Search extracted memories (FTS5) and compaction summaries (LIKE)
- Apply temporal decay to deprioritize old results
- Output JSON results to stdout

### REQ-3: Session-Start Context Injection
On the first message of a new session (after `/new`, `/reset`, or bridge startup), inject the latest daily compaction summary with an "ended at" timestamp. This gives Kiro background context without polluting ongoing conversations.

### REQ-4: Temporal Anchoring
Every assembled context must include clear temporal markers:
- `[LAST SESSION SUMMARY — ended <ISO timestamp>]` for the session-start summary
- `[SESSION START — <current ISO timestamp>]` before the conversation block

This creates a visible time gap that tells Kiro "the summary is old context, the conversation is happening now."

### REQ-5: Skill Guidance
The SKILL.md steering file must clearly instruct Kiro:
- **When to use**: message doesn't make sense in context, user explicitly asks to recall, references past topics
- **When NOT to use**: short confirmations ("yes", "ok", "do it"), clear instructions, every message
