import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCompactionGuard, type CompactionGuardDeps } from "./compaction-guard.js";
import { SessionRegistry } from "../session-registry.js";
import { _resetEnv, initEnv } from "../env-schema.js";

vi.mock("../compaction.js", () => ({
  runCompaction: vi.fn().mockResolvedValue(true),
}));
vi.mock("../transport/bridge-lock-transport.js", () => ({
  writeRestartReason: vi.fn(),
}));

function makeMsg() {
  return { sessionKey: "master:tg", channelId: "100", threadId: undefined, platform: "telegram" } as any;
}
function makeAdapter() { return { sendMessage: vi.fn().mockResolvedValue(1) } as any; }

describe("runCompactionGuard", () => {
  let sessions: SessionRegistry;
  let deps: CompactionGuardDeps;

  beforeEach(() => {
    _resetEnv();
    vi.clearAllMocks();
    sessions = new SessionRegistry();
    deps = {
      transport: { contextPercent: -1 } as any,
      sessions,
      memory: null,
      memoryConfig: { memoryEnabled: false, memoryDir: "/tmp" },
      updateCtxStart: vi.fn(),
    };
  });

  it("does nothing when contextPercent < 0", async () => {
    const adapter = makeAdapter();
    await runCompactionGuard(makeMsg(), adapter, deps);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("warns at warn threshold", async () => {
    (deps.transport as any).contextPercent = 72;
    const adapter = makeAdapter();
    await runCompactionGuard(makeMsg(), adapter, deps);
    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("⚠️"), expect.any(Object));
    expect(sessions.get("master:tg")?.ctxWarned).toBe(true);
  });

  it("does not warn twice", async () => {
    (deps.transport as any).contextPercent = 72;
    sessions.getOrCreate("master:tg").ctxWarned = true;
    const adapter = makeAdapter();
    await runCompactionGuard(makeMsg(), adapter, deps);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("triggers compaction at compact threshold", async () => {
    (deps.transport as any).contextPercent = 82;
    const adapter = makeAdapter();
    await runCompactionGuard(makeMsg(), adapter, deps);
    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("compacting"), expect.any(Object));
  });

  it("circuit breaker after max failures", async () => {
    (deps.transport as any).contextPercent = 82;
    const entry = sessions.getOrCreate("master:tg");
    entry.compactFailures = 3;
    entry.ctxWarned = true;
    const adapter = makeAdapter();
    await runCompactionGuard(makeMsg(), adapter, deps);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });
});
