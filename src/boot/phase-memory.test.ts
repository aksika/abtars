import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBootCtx } from "./context.js";

const mockLoadAbmind = vi.hoisted(() => vi.fn());
vi.mock("../utils/abmind-lazy.js", () => ({
  loadAbmind: mockLoadAbmind,
}));

vi.mock("../components/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("../components/null-memory.js", () => ({
  nullMemory: {},
}));

import { phaseMemory } from "./phase-memory.js";

describe("phaseMemory — abmindModule assignment (#1429)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAbmind.mockReset();
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
});
