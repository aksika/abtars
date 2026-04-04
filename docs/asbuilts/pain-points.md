# Known Pain Points & Mitigations

Operational issues encountered, how they were addressed, and potential future improvements.

---

## 1. Power Nap Restart Storm

**Problem:** Mac Power Nap wakes the machine every ~30 minutes overnight for iCloud sync, network maintenance, etc. Each wake triggers standby detection → bridge restart → agent session start → greeting. Observed 10+ restarts per night, all wasted — each one spins up a new kiro-cli process, sends a greeting, then the Mac sleeps again within minutes.

**Impact:** Wasted API calls (session start + greeting per restart), log noise, unnecessary kiro-cli process churn, potential sleep cycle interruption.

**Mitigation (implemented):**
- `bridge.lock` carries `exitReason: "standby"` + `exitedAt` timestamp on standby-triggered exit
- On startup: if recent standby exit (< 30min) → 3-minute grace period before fully starting
- If OS sleeps during grace → process dies quietly, no session start, no greeting, no noise
- LaunchAgent `ThrottleInterval` bumped from 15s to 60s to slow restart loops

**What else could be done:**
- **OS-specific darkwake detection:** macOS `pmset -g systemstate` returns `DarkWake` vs `FullWake`. Exit immediately on darkwake without waiting for grace period. Linux equivalent: check `/sys/power/wakeup_count` or `loginctl` session state.
- **Disable Power Nap entirely:** `sudo pmset -a powernap 0`. Nuclear option — stops the wake cycle but loses iCloud background sync.
- **LaunchAgent schedule:** Use `StartCalendarInterval` to only run during waking hours (e.g. 8am–2am). Downside: loses 24/7 availability.

---

## 2. Cron Failures Go Unresolved

**Problem:** When a cron job fails (e.g. `exit 127: command not found`), the error is reported to the user via Telegram but the agent never sees it. The agent is often capable of diagnosing and fixing the issue (wrong path, missing tool, permission error) but has no opportunity to do so.

**Impact:** User has to manually debug and fix cron issues that the agent could handle autonomously.

**Mitigation (implemented):**
- On cron failure, error details (command, exit code, stderr) are injected to the main agent transport
- Agent receives: "Cron task X failed: [details]. Diagnose and fix if possible."
- Max 2 auto-fix attempts per entry per day to prevent loops
- User still gets the failure notification via Telegram

**What else could be done:**
- **Structured fix verification:** After agent attempts a fix, automatically re-run the failed cron entry and verify success
- **Fix history:** Track which fixes the agent applied, learn from patterns (e.g. "path issues usually mean the tool moved to ~/.agentbridge/bin/")
- **Escalation:** If 2 auto-fix attempts fail, create a TODO/reminder for the user with the agent's diagnosis

---

## 3. Sleep Queue Blocking User Messages

**Problem:** During sleep cycle, user messages were queued silently (SleepQueue). User sends a message, gets no response for 2+ minutes, then a delayed response appears with no explanation. Sleep uses its own AcpTransport — the main transport is available but wasn't being used.

**Impact:** User thinks the bot is broken. Messages appear to be lost.

**Mitigation (implemented):**
- Removed sleep queue entirely. User messages go straight to the main transport during sleep.
- Sleep runs on its own AcpTransport, main transport stays responsive.

**What else could be done:**
- Nothing — this is fully resolved. The two transports are independent.

---

## 4. Daily Summary Missing After-Midnight Messages

**Problem:** Sleep running after midnight (e.g. 00:19) uses `localDate()` which returns the new day. No messages exist for the new day yet → daily summary skipped. Previous day's evening messages (22:00–00:19) never get summarized.

**Impact:** Lost conversation data from late-night sessions.

**Mitigation (implemented):**
- Before running 04a-daily-summary, check if yesterday has no daily file but has messages
- If so, target yesterday's date for the summary
- Follows human day cycle: midnight–2am is still "today", new day starts after wake-up

**What else could be done:**
- **Configurable day boundary:** `DAY_BOUNDARY_HOUR` env var (default: 6am) for users with different schedules
- **Multi-day catch-up:** If multiple days are missing summaries, process all of them (currently only checks yesterday)
