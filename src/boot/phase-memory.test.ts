import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBootCtx } from "./context.js";

const mockLoadAbmind = vi.hoisted(() => vi.fn());
vi.mock("../utils/abmind-lazy.js", () => ({
  loadAbmind: mockLoadAbmind,
}));

vi.mock("../components/logger.js", () => ({
  logDebug: vi.fn(),
  logTrace: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  redactSecrets: (value: string) => value,
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("../components/null-memory.js", () => ({
  nullMemory: {},
}));

import { phaseMemory } from "./phase-memory.js";
import { createDisabledRuntime } from "../components/memory-runtime.js";
import { executeToolCall, setMemoryRuntime } from "../components/transport/tool-registry.js";

describe("phaseMemory — abmindModule assignment (#1429)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAbmind.mockReset();
    setMemoryRuntime(null);
  });

  it("sets ctx.abmindModule to the loaded module on success", async () => {
    const fakeModule = { MemoryManager: vi.fn() };
    mockLoadAbmind.mockResolvedValue(fakeModule);
    const ctx = createBootCtx({ memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any });

    await phaseMemory(ctx);

    expect(ctx.abmindModule).toBe(fakeModule);
  });

  it("sets ctx.abmindModule to null when loadAbmind returns null", async () => {
    mockLoadAbmind.mockResolvedValue(null);
    const ctx = createBootCtx({ memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any });

    await phaseMemory(ctx);

    expect(ctx.abmindModule).toBeNull();
  });

  it("sets ctx.abmindModule to null when memory is disabled", async () => {
    const fakeModule = { MemoryManager: vi.fn() };
    mockLoadAbmind.mockResolvedValue(fakeModule);
    const ctx = createBootCtx({ memoryConfig: { memoryEnabled: false, memoryDir: "" } as any });

    await phaseMemory(ctx);

    expect(ctx.abmindModule).toBe(fakeModule);
  });

  it("keeps abmindModule even when memory initialization throws", async () => {
    const fakeModule = { MemoryManager: vi.fn(() => { throw new Error("init failed"); }) };
    mockLoadAbmind.mockResolvedValue(fakeModule);
    const ctx = createBootCtx({ memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any });

    await phaseMemory(ctx);

    expect(ctx.abmindModule).toBe(fakeModule);
  });

  it.each([
    { name: "memory is disabled", module: { MemoryManager: vi.fn() }, enabled: false },
    { name: "memory initialization fails", module: { getMemoryClient: vi.fn().mockRejectedValue(new Error("init failed")) }, enabled: true },
  ])("clears a stale registry runtime when $name", async ({ module, enabled }) => {
    const staleStore = vi.fn().mockResolvedValue({ stored: true });
    setMemoryRuntime({
      ...createDisabledRuntime(),
      state: "ready",
      supports: capability => capability === "instantStore",
      instantStore: staleStore,
    });
    mockLoadAbmind.mockResolvedValue(module);
    const ctx = createBootCtx({ memoryConfig: { memoryEnabled: enabled, memoryDir: "/tmp" } as any });

    await phaseMemory(ctx);

    const result = JSON.parse(await executeToolCall("memory_store", { translated: "x", type: "fact" }));
    expect(result.code).toBe("private_write_unavailable");
    expect(staleStore).not.toHaveBeenCalled();
  });
});
