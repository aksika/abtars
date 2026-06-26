# Sleep System (Dreamy)

Dreamy is the nightly memory maintenance agent. After bedtime, it processes the day's conversations — extracting memories, writing summaries, checking contradictions, and optionally putting the hardware to sleep.

## How it triggers

1. `BED_TIME` passes (default: 02:00)
2. Bridge waits for quiet — no messages for `BED_QUIET_MIN` minutes (default: 7)
3. Dreamy spawns as a subagent (same process, separate session)

If the bridge restarts and sleep hasn't run today, it catches up on next quiet period.

## Pipeline (15 steps)

| # | Step | What it does |
|---|------|-------------|
| 1 | daily-summary | Summarizes today's conversations |
| 2 | retrospective | Reflects on the day, appends to daily summary |
| 3 | extract-memories | Pulls facts, preferences, decisions from transcripts |
| 4 | retro-derive | Generates agent_notes + core knowledge updates |
| 5 | feedback | Self-assessment of interaction quality |
| 6 | contradiction | Checks new memories against existing ones |
| 7 | graph | Updates relationship/topic graph (daily) |
| 8–15 | curation (weekly) | topic-assignment, core-promotion, merge, translation, skill-review, consolidation, emotion-context, rem-synthesis |

Steps 8–15 only run on curation days (configurable).

## Quality levels

| Level | LLM calls | Use case |
|-------|-----------|----------|
| basic | 1 | Testing |
| budget | ~3–5 | Low-cost providers |
| normal | ~7–15 | Default |
| ultimate | ~15 nightly | Full processing |

## Configuration

```bash
# ~/.abtars/config/.env
BED_TIME=02:00
BED_QUIET_MIN=7
SLEEP_QUALITY=normal
SLEEP_MAX_LLM_CALLS=15
HARDWARE_SLEEP_AFTER_DREAMY=false
```

## Hardware sleep (optional)

When `HARDWARE_SLEEP_AFTER_DREAMY=true`:
1. Dreamy completes → announces "going to sleep in ~5 minutes"
2. 5-minute grace period — if user messages, hardware sleep is cancelled
3. No message → `pmset sleepnow` (Mac) or `systemctl suspend` (Linux)
4. Morning wake → watchdog detects stale heartbeat → bridge restarts fresh

## Commands

| Command | Description |
|---------|-------------|
| `/sleep` | Show sleep status (last run, next scheduled) |
| `/sleep now` | Force sleep cycle immediately |
| `/sleep skip` | Skip tonight's cycle |

## Guard logic

`hasSleepAuditToday()` prevents double-runs:
- `completed` or `suspended` in lock file → no spawn
- `ongoing` + process alive → already running
- `failed` → retry allowed

Budget cap: if `SLEEP_MAX_LLM_CALLS` exhausted → status set to `suspended`, no retry until tomorrow.

## Auto-skill creation (step 15)

Dreamy reviews conversations for skill-worthy patterns (trial-and-error, user corrections, multi-step workflows) and creates skills in `~/.abtars/skills/self/` via the `abtars-skill` CLI.
