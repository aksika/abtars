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

## 2. Task Failures Go Unresolved

**Problem:** When a task fails (e.g. `exit 127: command not found`), the error is reported to the user via Telegram but the agent never sees it. The agent is often capable of diagnosing and fixing the issue (wrong path, missing tool, permission error) but has no opportunity to do so.

**Impact:** User has to manually debug and fix task issues that the agent could handle autonomously.

**Mitigation (implemented):**
- On task failure, error details (command, exit code, stderr) are injected to the main agent transport
- Agent receives: "Task X failed: [details]. Diagnose and fix if possible."
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

---

## 5. SOUL Injection Silently Truncated for 2 Weeks (CRITICAL)

**Problem:** The `MessageInterceptor` (8000 char threshold, designed for A2A/Browsie overflow) was applied to ALL outbound prompts, including session-start prompts. The SOUL bundle alone is 10165 chars — every session start got truncated to a 500-char preview + file path. The agent ran without its identity, tools, memory context, or steering on every `/new`, restart, standby resume, and deploy for ~2 weeks.

**Impact:** Agent had no persona, no TOOLS.md, no agent notes, no memory context after any session reset. It still "worked" because kiro-cli has its own base prompt, but all AgentBridge customization was lost. Led to hallucinated features, ignored steering rules, and inconsistent behavior.

**Why it wasn't caught:**
- The interceptor logged the truncation at INFO level, but it looked routine ("Intercepted oversized message")
- The agent responded normally (kiro-cli base prompt), so nothing obviously broke
- No test verified that session-start prompts actually reached the transport intact

**Mitigation (implemented):**
- Session-start prompts (when `pendingSessionStart` is set) bypass the interceptor entirely
- SOUL + context injection is expected to be large — it's not overflow

**What else could be done:**
- **Integration test:** Verify that after `/new`, the prompt sent to transport contains the SOUL bundle
- **Prompt size monitoring:** Log prompt size on session start, alert if suspiciously small (< 5000 chars)
- **Interceptor scope:** Rename/refactor to make it clear it's for A2A/Browsie only, not general pipeline
