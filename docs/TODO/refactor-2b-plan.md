# Refactor 2b — Structural Polish

> Post-architecture-v2 cleanup. No new features — just fixing coupling, organizing files, and decomposing remaining god objects.

## 1. Fix cron-checker reverse dependency

**Problem:** `components/cron-checker.ts` imports from `capabilities/browser/` (wrong direction).

**Fix:** Move `deliverBrowseResult()`, `checkBrowseTasks()`, `readPendingBrowse()`, `writePendingBrowse()`, and `PendingBrowseEntry` into the browser capability. `cron-checker.ts` keeps only generic reminder logic (`appendReminder`, `readPendingReminders`, `checkReminders`).

**Files:**
- `src/components/cron-checker.ts` — remove browse-specific code
- `src/capabilities/browser/browse-delivery.ts` — new, owns browse result delivery
- `src/capabilities/browser/index.ts` — import from local instead of cron-checker
- `src/capabilities/browser/agentbridge-browse.ts` — move `PendingBrowseEntry` type + read/write helpers here or to browse-delivery

**Effort:** Small. **Risk:** None.

## 2. Migrate retro-extract to memory backend factory

**Problem:** `src/cli/agentbridge-retro-extract.ts` line 98: `new MemoryManager(config)` — old pattern, bypasses IPC.

**Fix:** Replace with `createMemoryBackend()`. Same pattern as agentbridge-store/recall/edit.

**Effort:** Tiny. **Risk:** None.

## 3. Organize components/ into subdirectories

**Problem:** `components/` has 60 files with no grouping. Finding anything requires knowing the filename.

**Subdirectories:**

```
components/
├── cron/                    # cron-db, cron-checker, cron-queue
├── dashboard/               # dashboard-server, dashboard-ui, dashboard-config
├── transport/               # kiro-transport (interface), acp-client, acp-transport, tmux-client
├── pipeline/                # (already exists) middleware, voice, commands, busy-guard
├── logger.ts                # stays (used everywhere)
├── config.ts                # stays (used everywhere)
├── env-utils.ts             # stays (used everywhere)
└── ... (remaining ~30 files stay flat)
```

**Platform API files move into platforms/:**

```
platforms/
├── telegram/
│   ├── telegram-adapter.ts
│   ├── telegram-api.ts       # moved from components/
│   └── telegram-poller.ts    # moved from components/
└── discord/
    ├── discord-adapter.ts
    ├── discord-api.ts        # moved from components/
    └── discord-poller.ts     # moved from components/
```

**Approach:** One subdirectory at a time. Each is a single commit: move files + update imports + verify tests.

**Order:** cron/ → dashboard/ → transport/ → platforms/ restructure

**Effort:** Medium (mechanical, but many import updates). **Risk:** Low (compiler catches everything).

## 4. Decompose startBridge()

**Problem:** `startBridge()` is 548 lines. Wires config, transport, memory, platforms, heartbeat, dashboard, capabilities, shutdown handlers — all inline.

**Fix:** Extract into Bridge class methods:

```typescript
class Bridge {
  async start() {
    await this.initConfig();
    await this.initTransport();
    await this.initMemory();
    await this.initPlatforms();
    await this.initHeartbeat();
    await this.initDashboard();
    await this.discoverCapabilities();
    this.registerShutdownHandlers();
  }
}
```

Each method ~60-100 lines. Bridge class owns all state (already has the fields). `startBridge()` becomes `new Bridge().start()`.

**Depends on:** #3 (cleaner imports make this easier, but not required).

**Effort:** Medium. **Risk:** Medium (touches all wiring, but Bridge class already exists as the target).

## 5. Split PipelineDeps

**Problem:** `PipelineDeps` is a 25-field interface. Every consumer gets everything.

**Fix:** Group into focused interfaces:

```typescript
interface TransportDeps {
  transport: IKiroTransport;
  codingMode: CodingMode;
  config: { agentTransport: string; workingDir: string };
}

interface MemoryDeps {
  memory: MemoryManager | null;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  conversationBuffer: ConversationBuffer;
}

interface SessionState {
  busyChats: Set<string>;
  messageQueue: Map<string, Array<...>>;
  fullModeChats: Set<string>;
  pendingSessionStart: Set<string>;
  seenSessions: Set<string>;
}

interface PipelineDeps extends TransportDeps, MemoryDeps, SessionState {
  // remaining fields
}
```

Consumers narrow their parameter type: middleware takes `MessageContext` (already done), core pipeline takes `PipelineDeps`, individual handlers take the group they need.

**Depends on:** #4 (Bridge class methods create the natural grouping).

**Effort:** Medium. **Risk:** Low (type-level, compiler-assisted).

## 6. Tweet/RSS as capability candidates (optional)

**Problem:** `agentbridge-tweet.ts` (579 lines) and `agentbridge-rss.ts` are standalone CLIs in `src/cli/`. They're agent tools but don't participate in the capability system.

**Assessment:** Both are stateless — agent calls them via bash, they output JSON, no heartbeat tasks or commands needed. They're fine as CLIs. Only worth moving if they grow lifecycle needs (e.g., tweet feed becomes a heartbeat task, RSS gets auto-update).

**Decision:** Skip unless a feature request triggers it. Note here for future reference.

---

## Execution Order

```
#1 cron-checker reverse dep  ✅  →  #2 retro-extract  ✅  →  #3 subdirectories  ✅  →  #4 Bridge decomp  ⏸  →  #5 PipelineDeps  ⏸
```

#1-#3 shipped. #4-#5 deferred — startBridge() is a wiring function, forced decomposition adds indirection without reducing complexity. The comment sections serve as virtual methods. Revisit if #50 (memory decoupling) or #48 (multi-CLI) create a real need for clean seams.

## Success Criteria

- [x] No `components/` → `capabilities/` imports (reverse dependency eliminated)
- [x] All CLI tools use `createMemoryBackend()` (no direct `new MemoryManager()` outside bridge/sleep)
- [x] `components/` has ≤40 top-level files (down from 60)
- [ ] ~~`startBridge()` ≤ 50 lines~~ — deferred, cosmetic gain only
- [ ] ~~`PipelineDeps` split into ≥3 focused interfaces~~ — deferred, groupings not natural yet
- [x] 78 test files, 764 tests passing
- [x] Clean typecheck
- [x] Flaky auto-compact tests fixed (wrong table + timezone mismatch)
