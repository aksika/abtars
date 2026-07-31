import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => p.includes("app") ? false : actual.existsSync(p),
  };
});

vi.mock("../components/null-memory.js", () => ({
  nullMemory: {},
}));

import { phaseMemory, createMemoryRuntimeFromEndpoint, AbmindModuleMissingError } from "./phase-memory.js";
import { createDisabledRuntime, createClientRuntime } from "../components/memory-runtime.js";
import { executeToolCall, setMemoryRuntime } from "../components/transport/tool-registry.js";
import type { BootCtx } from "./context.js";

let testHome = "";

function ctxWithMemory(enabled: boolean, overrides: Partial<BootCtx> = {}): BootCtx {
  return createBootCtx({
    memoryConfig: { memoryEnabled: enabled, memoryDir: "/tmp" } as any,
    ...overrides,
  });
}

function fakeClient(overrides: Record<string, unknown> = {}): any {
  return {
    capabilities: {
      version: 1,
      methods: ["private.recall", "private.recordMessage", "private.instantStore", "private.edit", "private.recordFeedback", "private.getCoreKnowledge", "private.getRuntimeStatus", "private.rebuildFts"],
      features: { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" },
    },
    privateMemory: {},
    sleep: {},
    negotiate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("phaseMemory — endpoint selection (#1508)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAbmind.mockReset();
    setMemoryRuntime(null);
    testHome = mkdtempSync(join(tmpdir(), "abtars-phase-mem-"));
    mkdirSync(join(testHome, "config"), { recursive: true });
    process.env["ABTARS_HOME"] = testHome;
  });

  afterEach(() => {
    delete process.env["ABTARS_HOME"];
    rmSync(testHome, { recursive: true, force: true });
  });

  it("disabled memory does not load config, import abmind, or connect", async () => {
    mockLoadAbmind.mockResolvedValue(fakeClient());
    const resolveEndpoint = vi.fn();
    const createRuntime = vi.fn();
    const ctx = ctxWithMemory(false);

    const result = await phaseMemory(ctx, { resolveEndpoint, createRuntime });

    expect(result).toBe("skipped");
    expect(resolveEndpoint).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(mockLoadAbmind).not.toHaveBeenCalled();
    expect(ctx.abmindModule).toBeNull();
    expect(ctx.memoryRuntime.state).toBe("disabled");
  });

  it("absent-config default local mode loads abmind and sets abmindModule", async () => {
    const fakeModule = { getMemoryClient: vi.fn().mockResolvedValue(fakeClient()) };
    mockLoadAbmind.mockResolvedValue(fakeModule);
    const ctx = ctxWithMemory(true);

    await phaseMemory(ctx);

    expect(ctx.abmindModule).toBe(fakeModule);
    expect(ctx.client).not.toBeNull();
    expect(ctx.memoryRuntime.state).toBe("ready");
  });

  it("absent-config default local mode without abmind stays disabled (compat)", async () => {
    mockLoadAbmind.mockResolvedValue(null);
    const ctx = ctxWithMemory(true);

    await phaseMemory(ctx);

    expect(ctx.memoryRuntime.state).toBe("disabled");
    expect(ctx.abmindModule).toBeNull();
  });

  it("an explicit local endpoint without abmind degrades instead of falling back", async () => {
    mockLoadAbmind.mockResolvedValue(null);
    const resolveEndpoint = vi.fn().mockReturnValue({ mode: "local", source: "explicit" });
    const ctx = ctxWithMemory(true);

    await phaseMemory(ctx, { resolveEndpoint });

    expect(ctx.memoryRuntime.state).toBe("unavailable");
    expect(ctx.client).toBeNull();
    expect(ctx.phaseHealth.get("phaseMemory")?.status).toBe("failed");
  });

  it("a wss endpoint builds the abtars client and leaves abmindModule null", async () => {
    mockLoadAbmind.mockResolvedValue(null);
    const client = fakeClient();
    const runtime = createClientRuntime(client);
    const resolveEndpoint = vi.fn().mockReturnValue({
      mode: "wss",
      source: "explicit",
      profileName: "primary",
      profile: {
        url: "wss://memory.example.invalid/ws",
        peerId: "abtars-test",
        signingKeyFile: "/tmp/key.pem",
        serverCertSha256: "a".repeat(64),
      },
    });
    const createRuntime = vi.fn().mockResolvedValue({ mode: "wss", client, runtime, abmindModule: null });
    const ctx = ctxWithMemory(true);

    const result = await phaseMemory(ctx, { resolveEndpoint, createRuntime });

    expect(result).toBe("ran");
    expect(mockLoadAbmind).not.toHaveBeenCalled();
    expect(ctx.abmindModule).toBeNull();
    expect(ctx.client).toBe(client);
    expect(ctx.memoryRuntime.state).toBe("ready");
  });

  it("a failing wss endpoint degrades and closes the partial client", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({ close });
    const resolveEndpoint = vi.fn().mockReturnValue({
      mode: "wss",
      source: "explicit",
      profileName: "primary",
      profile: { url: "wss://x.invalid/ws", peerId: "p", signingKeyFile: "/tmp/k.pem", serverCertSha256: "a".repeat(64) },
    });
    const createRuntime = vi.fn().mockRejectedValue(new Error("negotiation failed"));
    const ctx = ctxWithMemory(true);

    await phaseMemory(ctx, { resolveEndpoint, createRuntime });

    expect(ctx.memoryRuntime.state).toBe("unavailable");
    expect(ctx.client).toBeNull();
    expect(ctx.phaseHealth.get("phaseMemory")?.status).toBe("failed");
    void client;
  });

  it("invalid endpoint config degrades with the bounded reason code", async () => {
    const resolveEndpoint = vi.fn().mockImplementation(() => {
      throw new Error("config_invalid: unknown field");
    });
    const ctx = ctxWithMemory(true);

    await phaseMemory(ctx, { resolveEndpoint });

    expect(ctx.memoryRuntime.state).toBe("unavailable");
    expect(ctx.phaseHealth.get("phaseMemory")?.status).toBe("failed");
  });

  it("clears a stale registry runtime on every path", async () => {
    const staleStore = vi.fn().mockResolvedValue({ stored: true });
    setMemoryRuntime({
      ...createDisabledRuntime(),
      state: "ready",
      supports: capability => capability === "instantStore",
      instantStore: staleStore,
    });
    const freshStore = vi.fn().mockResolvedValue({ stored: true, memoryId: 42, semanticRevision: 1 });
    const freshClient = fakeClient({
      privateMemory: { instantStore: freshStore },
    });
    mockLoadAbmind.mockResolvedValue({ getMemoryClient: vi.fn().mockResolvedValue(freshClient) });
    const ctx = ctxWithMemory(true);

    await phaseMemory(ctx);

    const result = JSON.parse(await executeToolCall("memory_store", { translated: "x", type: "fact" }, { userId: "e2e-phase-test" }));
    expect(staleStore).not.toHaveBeenCalled();
    expect(freshStore).toHaveBeenCalled();
    expect(result.stored).toBe(true);
  });
});

describe("createMemoryRuntimeFromEndpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAbmind.mockReset();
  });

  it("local default without abmind throws AbmindModuleMissingError", async () => {
    mockLoadAbmind.mockResolvedValue(null);
    await expect(createMemoryRuntimeFromEndpoint({ mode: "local", source: "default" }, "/tmp/home"))
      .rejects.toBeInstanceOf(AbmindModuleMissingError);
  });

  it("local mode returns the abmind module for abmindModule", async () => {
    const fakeModule = { getMemoryClient: vi.fn().mockResolvedValue(fakeClient()) };
    mockLoadAbmind.mockResolvedValue(fakeModule);
    const result = await createMemoryRuntimeFromEndpoint({ mode: "local", source: "default" }, "/tmp/home");
    expect(result.mode).toBe("local");
    expect(result.abmindModule).toBe(fakeModule);
    expect(result.runtime.state).toBe("ready");
  });

  it("negotiation without core capabilities is rejected", async () => {
    mockLoadAbmind.mockResolvedValue({
      getMemoryClient: vi.fn().mockResolvedValue(fakeClient({
        capabilities: { version: 1, methods: [], features: {} },
      })),
    });
    await expect(createMemoryRuntimeFromEndpoint({ mode: "local", source: "default" }, "/tmp/home"))
      .rejects.toThrow(/capabilities/i);
  });
});
