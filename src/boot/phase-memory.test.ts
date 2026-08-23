import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
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

import { phaseMemory, createMemoryRuntimeFromEndpoint, AbmindModuleMissingError, MemoryEndpointUnavailableError, MemoryCompositionPendingError, classifyCompositionFailure } from "./phase-memory.js";
import { createDisabledRuntime, createClientRuntime } from "../components/memory-runtime.js";
import { AbtarsSignedWssClient } from "../components/abmind-signed-wss-client.js";
import { AbmindEndpointConfigError } from "../components/abmind-endpoint-config.js";
import { readFileSync } from "node:fs";
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

  it("absent-config default local mode without abmind composes late instead of staying disabled", async () => {
    mockLoadAbmind.mockResolvedValue(null);
    const ctx = ctxWithMemory(true);

    await expect(phaseMemory(ctx)).rejects.toBeInstanceOf(MemoryCompositionPendingError);

    // Stable facade stays installed and unavailable; supervisor is idle.
    expect(ctx.memoryRuntime.state).toBe("unavailable");
    expect(ctx.abmindModule).toBeNull();
    expect(ctx.client).toBeNull();
    expect(ctx.memoryRecomposition).not.toBeNull();
    expect(ctx.memoryRuntime.compositionDiagnostics?.attempts).toBe(1);
    expect(ctx.memoryRuntime.compositionDiagnostics?.lastFailure).toBe("package_missing");
  });

  it("an explicit local endpoint without abmind composes late instead of falling back", async () => {
    mockLoadAbmind.mockResolvedValue(null);
    const resolveEndpoint = vi.fn().mockReturnValue({ mode: "local", source: "explicit" });
    const ctx = ctxWithMemory(true);

    await expect(phaseMemory(ctx, { resolveEndpoint })).rejects.toBeInstanceOf(MemoryCompositionPendingError);

    expect(ctx.memoryRuntime.state).toBe("unavailable");
    expect(ctx.client).toBeNull();
    expect(ctx.memoryRecomposition).not.toBeNull();
    expect(ctx.memoryRuntime.compositionDiagnostics?.lastFailure).toBe("package_missing");
  });

  it("immediate success publishes through the shared path and leaves no supervisor", async () => {
    const fakeModule = { getMemoryClient: vi.fn().mockResolvedValue(fakeClient()) };
    mockLoadAbmind.mockResolvedValue(fakeModule);
    const ctx = ctxWithMemory(true);

    const result = await phaseMemory(ctx);

    expect(result).toBe("ran");
    expect(ctx.abmindModule).toBe(fakeModule);
    expect(ctx.client).not.toBeNull();
    expect(ctx.memoryRuntime.state).toBe("ready");
    expect(ctx.memoryRuntime.compositionDiagnostics).toMatchObject({ state: "upgraded", attempts: 1 });
    expect(ctx.memoryRecomposition).toBeNull();
    expect(ctx.phaseHealth.get("memory")?.status).toBe("ok");
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

  it("a failing wss endpoint degrades, closes the partial client, and reports a bounded reason", async () => {
    const keyPath = join(testHome, "config", "test-ed25519.pem");
    execSync(`openssl genpkey -algorithm ed25519 -out ${keyPath}`, { stdio: "ignore" });
    chmodSync(keyPath, 0o600);
    const closeSpy = vi.spyOn(AbtarsSignedWssClient.prototype, "close").mockResolvedValue(undefined);
    const resolveEndpoint = vi.fn().mockReturnValue({
      mode: "wss",
      source: "explicit",
      profileName: "primary",
      profile: {
        url: "wss://127.0.0.1:1/ws",
        peerId: "abtars-test",
        signingKeyFile: keyPath,
        serverCertSha256: "a".repeat(64),
      },
    });
    const ctx = ctxWithMemory(true);

    await expect(phaseMemory(ctx, { resolveEndpoint })).rejects.toBeInstanceOf(MemoryCompositionPendingError);

    expect(ctx.memoryRuntime.state).toBe("unavailable");
    expect(ctx.client).toBeNull();
    expect(ctx.memoryRecomposition).not.toBeNull();
    expect(ctx.memoryRuntime.compositionDiagnostics?.lastFailure).toBe("endpoint_unavailable");
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it("invalid endpoint config defers composition with the bounded reason code", async () => {
    const resolveEndpoint = vi.fn().mockImplementation(() => {
      throw new AbmindEndpointConfigError("unknown_field", "config rejected: unknown field");
    });
    const ctx = ctxWithMemory(true);

    await expect(phaseMemory(ctx, { resolveEndpoint })).rejects.toBeInstanceOf(MemoryCompositionPendingError);

    expect(ctx.memoryRuntime.state).toBe("unavailable");
    expect(ctx.memoryRecomposition).not.toBeNull();
    expect(ctx.memoryRuntime.compositionDiagnostics?.lastFailure).toBe("config_invalid");
  });

  it("generation reset at entry cancels a stale supervisor before rebuilding", async () => {
    const staleCancel = vi.fn().mockResolvedValue(undefined);
    const ctx = ctxWithMemory(true, {
      memoryRecomposition: { cancel: staleCancel } as never,
    });
    mockLoadAbmind.mockResolvedValue({ getMemoryClient: vi.fn().mockResolvedValue(fakeClient()) });

    await phaseMemory(ctx);

    expect(staleCancel).toHaveBeenCalledTimes(1);
  });

  it("a retry through the real supervisor re-resolves config and re-runs local checks before composing", async () => {
    let resolveCalls = 0;
    const resolveEndpoint = vi.fn(() => {
      resolveCalls++;
      if (resolveCalls === 1) throw new AbmindEndpointConfigError("missing", "endpoint config not written yet");
      return { mode: "local" as const, source: "default" as const };
    });
    const fakeModule = { getMemoryClient: vi.fn().mockResolvedValue(fakeClient()) };
    mockLoadAbmind.mockResolvedValue(fakeModule);

    // Deterministic manual scheduler: ticks are explicit.
    const queue: Array<() => void> = [];
    const schedule = (fn: () => void): (() => void) => {
      queue.push(fn);
      return () => {};
    };

    const ctx = ctxWithMemory(true);
    await expect(phaseMemory(ctx, { resolveEndpoint, schedule })).rejects.toBeInstanceOf(MemoryCompositionPendingError);

    expect(resolveCalls).toBe(1);
    // Attempt 1 failed at endpoint-config resolution — before any package check.
    expect(mockLoadAbmind).toHaveBeenCalledTimes(0);
    expect(ctx.memoryRuntime.state).toBe("unavailable");

    ctx.memoryRecomposition!.start();
    expect(queue.length).toBeGreaterThanOrEqual(1);
    queue[0]!(); // first retry tick
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(resolveCalls).toBe(2);                       // endpoint config re-resolved
    // Retry attempt: closure-level package check + factory discovery (cached loader).
    expect(mockLoadAbmind).toHaveBeenCalledTimes(2);
    expect(ctx.memoryRuntime.state).toBe("ready");      // same facade upgraded in place
    expect(ctx.abmindModule).toBe(fakeModule);
    expect(ctx.client).not.toBeNull();
    expect(ctx.phaseHealth.get("memory")?.status).toBe("ok");
    expect(ctx.memoryRuntime.compositionDiagnostics?.state).toBe("upgraded");
    expect(ctx.memoryRecomposition!.diagnostics.attempts).toBe(2);
  });
});

describe("classifyCompositionFailure (#1706)", () => {
  it("maps typed and fallback failures to the closed code union", () => {
    expect(classifyCompositionFailure(new AbmindEndpointConfigError("invalid_url", "bad url"))).toBe("config_invalid");
    expect(classifyCompositionFailure(new AbmindModuleMissingError())).toBe("package_missing");
    expect(classifyCompositionFailure(new Error("explicit local memory endpoint selected but the abmind package is not installed"))).toBe("package_missing");
    expect(classifyCompositionFailure(new MemoryEndpointUnavailableError("pin_mismatch", "pin"))).toBe("pin_mismatch");
    expect(classifyCompositionFailure(new Error("connection failed: ECONNREFUSED"))).toBe("endpoint_unavailable");
  });

  it("the recomposition component never imports a boot module (architecture invariant)", () => {
    const source = readFileSync(new URL("../components/memory-recomposition.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from\s+"\.\.\/boot\//);
    expect(source).not.toMatch(/from\s+"\.\/phase-/);
  });
});

describe("createMemoryRuntimeFromEndpoint", () => {
  let factoryHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAbmind.mockReset();
    factoryHome = mkdtempSync(join(tmpdir(), "abtars-phase-factory-"));
    mkdirSync(join(factoryHome, "config"), { recursive: true });
    chmodSync(join(factoryHome, "config"), 0o700);
  });

  afterEach(() => {
    rmSync(factoryHome, { recursive: true, force: true });
  });

  it("local default without abmind throws AbmindModuleMissingError", async () => {
    mockLoadAbmind.mockResolvedValue(null);
    await expect(createMemoryRuntimeFromEndpoint({ mode: "local", source: "default" }, factoryHome))
      .rejects.toBeInstanceOf(AbmindModuleMissingError);
  });

  it("local mode returns the abmind module for abmindModule", async () => {
    const fakeModule = { getMemoryClient: vi.fn().mockResolvedValue(fakeClient()) };
    mockLoadAbmind.mockResolvedValue(fakeModule);
    const result = await createMemoryRuntimeFromEndpoint({ mode: "local", source: "default" }, factoryHome);
    expect(result.mode).toBe("local");
    expect(result.abmindModule).toBe(fakeModule);
    expect(result.runtime.state).toBe("ready");
  });

  it("negotiation without core capabilities is rejected", async () => {
    const client = fakeClient({
      capabilities: { version: 1, methods: [], features: {} },
    });
    mockLoadAbmind.mockResolvedValue({
      getMemoryClient: vi.fn().mockResolvedValue(client),
    });
    await expect(createMemoryRuntimeFromEndpoint({ mode: "local", source: "default" }, factoryHome))
      .rejects.toThrow(/capabilities/i);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("a wss endpoint that cannot connect fails with a bounded endpoint_unavailable code and closes the client", async () => {
    const keyPath = join(factoryHome, "config", "k.pem");
    execSync(`openssl genpkey -algorithm ed25519 -out ${keyPath}`, { stdio: "ignore" });
    chmodSync(keyPath, 0o600);
    const closeSpy = vi.spyOn(AbtarsSignedWssClient.prototype, "close").mockResolvedValue(undefined);

    const endpoint = {
      mode: "wss" as const,
      source: "explicit" as const,
      profileName: "primary",
      profile: {
        url: "wss://127.0.0.1:1/ws",
        peerId: "abtars-test",
        signingKeyFile: keyPath,
        serverCertSha256: "a".repeat(64),
      },
    };

    const err = await createMemoryRuntimeFromEndpoint(endpoint, factoryHome).catch(e => e);
    expect(err).toBeInstanceOf(MemoryEndpointUnavailableError);
    expect((err as MemoryEndpointUnavailableError).code).toBe("endpoint_unavailable");
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it("an explicit-local negotiation failure closes the partial client exactly once", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const client = {
      negotiate: vi.fn().mockRejectedValue(new Error("socket connect failed")),
      close,
    };
    class FakeTransport {}
    class FakeAbmindClient {
      constructor() { return client; }
    }
    const fakeModule = {
      AbmindClient: FakeAbmindClient,
      LocalTransport: FakeTransport,
    };
    mockLoadAbmind.mockResolvedValue(fakeModule);

    const endpoint = { mode: "local", source: "explicit", socketPath: join(factoryHome, "memory.sock") };
    await expect(createMemoryRuntimeFromEndpoint(endpoint, factoryHome)).rejects.toThrow("socket connect failed");

    expect(client.negotiate).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
