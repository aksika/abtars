# Recovery System — Analysis & Redesign Plan

## Architecture: Three Clean Layers

```
┌─────────────────────────────────────────────────┐
│                  HEARTBEAT (5 min)               │
│                                                  │
│  Standby detection ──→ classifyResume()          │
│    dark  → skip tick                             │
│    full  → log, run normal tick                  │
│                                                  │
│  Tasks (run each tick):                          │
│    ├── transport.healthCheck()  — stuck prompts  │
│    ├── age-check  — bedtime + daily restart      │
│    ├── self-healer  — log scanning               │
│    ├── db-integrity  — PRAGMA check              │
│    └── ...other tasks                            │
│                                                  │
│  After all tasks: write lastHeartbeat            │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│              WATCHDOG (60s countdown timer)       │
│                                                  │
│  Counter starts at 15 min (3× heartbeat)         │
│  Every 60s: counter -= 60s                       │
│  Heartbeat kick: counter = 15 min (reset)        │
│  Counter ≤ 0: system dead → exit(1)              │
│                                                  │
│  No file I/O, no JSON, no timestamps.            │
│  Pure countdown + kick pattern.                  │
│  Also serves as morning restart after hw sleep.  │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│              EXTERNAL (LaunchAgent + doctor)      │
│                                                  │
│  Process dead → restart                          │
│  Startup → doctor.sh checks previous health      │
└─────────────────────────────────────────────────┘
```

## Daily Lifecycle

```
~01:20+ → Bedtime: quiet ticks accumulate (no user messages)
~01:50  → 6 quiet ticks → Dreamy spawns (sleep cycle)
~02:30  → Dreamy completes → pmset sleepnow → Mac hardware sleep
          (process frozen, heartbeat frozen, lastHeartbeat frozen)
07:55   → pmset wakeorpoweron → Mac wakes → process resumes
          → watchdog counter deeply negative (no kicks for hours) → exit(1)
          → LaunchAgent restarts → fresh process, clean memory
08:00   → Bridge starts → doctor.sh → session refresh
          → Sleep already done today → skip
```

Memory leaks solved by daily restart. No RSS tracking needed — process never lives >24h.

## Holistic Recovery Analysis

### All failure modes

**✅ = handled, ⚠️ = partial, ❌ = gap**

#### Process-level
| Failure | Handling | Status |
|---------|----------|--------|
| Crash | LaunchAgent restarts | ✅ |
| OOM kill | LaunchAgent restarts | ✅ |
| Memory leak | Daily restart via Dreamy → pmset sleep → wake → watchdog restart | ✅ |
| Event loop blocked | setInterval also blocked → process effectively dead → LaunchAgent | ✅ |
| Zombie children | Nothing — sleep, browser, tool subprocesses not reaped | ❌ |

#### Transport
| Failure | Handling | Status |
|---------|----------|--------|
| ACP process dies | healthCheck reinit | ✅ |
| ACP hangs | healthCheck interrupt | ✅ |
| AWS throttling | ACP retries | ⚠️ Bridge + sleep compete for same quota, no coordination |
| API 429 | Leaky bucket + fallback | ✅ |
| API auth error | Bucket 100%, skip | ✅ |
| All models exhausted | Error to user | ✅ |
| Fetch hangs | AbortController timeout | ✅ |

#### Network
| Failure | Handling | Status |
|---------|----------|--------|
| Internet down | Poller retries, API retries | ⚠️ No offline detection — retries blindly, wastes resources |
| Telegram API down | Poller exponential backoff | ✅ |
| Ollama crash | API fallback chain | ✅ |

#### OS / Hardware
| Failure | Handling | Status |
|---------|----------|--------|
| Dark wake | classifyResume in heartbeat + watchdog kick | ✅ Heartbeat kicks watchdog before it expires |
| Full wake (morning) | Watchdog counter expired (no kicks for hours) → exit(1) → fresh start | ✅ |
| Power loss / reboot | LaunchAgent | ✅ |
| Disk full | Sleep cycle checks | ⚠️ No runtime check — only during Dreamy |
| macOS update reboot | LaunchAgent | ✅ |

#### Database
| Failure | Handling | Status |
|---------|----------|--------|
| SQLite corruption | db-integrity heartbeat task | ✅ |
| WAL growth | Sleep WAL checkpoint | ✅ |
| DB locked | SQLite busy timeout | ⚠️ No explicit retry at app level |
| Migration failure | Process exits, doctor fixes | ✅ |

#### Resource exhaustion
| Failure | Handling | Status |
|---------|----------|--------|
| Context overflow | Compaction + circuit breaker | ✅ |
| Disk space | Sleep + doctor | ⚠️ Runtime only checked during Dreamy |
| File descriptor leak | Nothing | ❌ |
| Child process accumulation | Nothing | ❌ |

#### Logical / State
| Failure | Handling | Status |
|---------|----------|--------|
| Infinite retry loop | Max retries (3) | ✅ |
| State file corruption | Fragile JSON.parse assumptions | ⚠️ garbage.json bug proves this |
| Cascading failures | Self-healer reports | ⚠️ No circuit breaker |
| Clock skew (NTP jump) | Nothing | ⚠️ Bedtime counter + heartbeat alignment could break |

## Gaps & Remediation Plan

### Phase 1 — Active bugs (implement now)

**Gap 1: Dark wake restart loop** → **#10** ([010-watchdog-darkwake-fix.md](010-watchdog-darkwake-fix.md))
- Countdown+kick pattern was implemented but is vulnerable to setInterval batching on resume
- Fix: wall-clock watchdog (`Date.now() - lastKickAt`) + `classifyResume()` gate at kill threshold
- See #10 spec for full implementation

**Gap 2: Overlapping standby handlers**
- Standby resume calls `isDailyCycleDue()` + `process.exit(0)`, duplicating age-check task
- Causes double tick counting on quiet counter
- Fix: standby resume becomes classify + log only. Remove isDailyCycleDue call and process.exit.
- Files: `bridge-app.ts` (~10 lines removed)

### Phase 2 — Ticking time bombs (next sprint)

**Gap 3: Zombie children**
- Sleep, browser, tool subprocesses spawned but not tracked after exit
- Risk: child process accumulation over days (between daily restarts)
- Fix: heartbeat task that checks known child refs (`sleepHandle.child`, browser pids). Reap dead ones, warn on accumulation.
- Files: new heartbeat task (~15 lines)

**Gap 4: State file corruption**
- Every `JSON.parse(readFileSync(...))` assumes valid JSON and correct schema
- Proven by: garbage.json format mismatch, lock file assumptions
- Fix: defensive parsing helper — `safeReadJson(path, fallback)` that returns fallback on any parse error. Replace all raw JSON.parse of state files.
- Files: new utility (~10 lines), update ~5 call sites

### Phase 3 — Edge cases (backlog)

**Gap 5: File descriptor leak**
- Long-lived streams (SSE, WebSocket, ACP stdio) could leak FDs
- Fix: periodic `process.getActiveResourcesInfo()` log in heartbeat. Warn if count grows monotonically.
- Complexity: Low

**Gap 6: AWS quota competition** *(deferred)*
- Bridge ACP + sleep ACP both use kiro-cli simultaneously → throttling
- Fix: sleep uses different model (`qwen3-coder-next`) or different transport (API/Ollama). Already partially addressed by `AGENT_SLEEP_MODEL` env var.
- Complexity: Low (config change)
- Deferred: current config separation is sufficient, revisit if throttling recurs

**Gap 7: Disk space runtime check**
- Only checked during Dreamy sleep cycle
- Fix: heartbeat task checks `df` output, warns at 90%, blocks new writes at 95%
- Complexity: Trivial

**Gap 8: Offline detection**
- Poller retries blindly when internet is down, noisy logs
- Fix: consecutive poller failure counter. After N failures, log "offline" once, reduce retry frequency. Reset on success.
- Complexity: Low

**Gap 9: Clock skew** *(deferred)*
- NTP jump could break bedtime counter (suddenly past BED_TIME) or heartbeat alignment
- Fix: use `process.hrtime.bigint()` for interval measurement instead of `Date.now()` delta
- Complexity: Medium (touches heartbeat core)
- Deferred: NTP jumps are rare on always-on Mac, not worth the risk of touching heartbeat internals

**Gap 10: Cascading failures**
- One bad model/endpoint can stall the pipeline while bucket drains
- Fix: circuit breaker pattern — after N consecutive failures across all models, pause pipeline for cooldown period, notify user
- Complexity: Medium
