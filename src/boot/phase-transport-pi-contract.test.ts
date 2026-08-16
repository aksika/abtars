/**
 * phase-transport-pi-contract.test.ts — #1573 transactional transport
 * replacement at the boot composition boundary.
 *
 * buildTransport()/rebuildTransport() run with the REAL resolution pipeline
 * stubbed only at the external boundaries (transport-config resolution, Pi
 * installation resolution, and the runtime-contract probe). The PiCore
 * transport itself is real: a rejected probe must clean up only the candidate,
 * never the working transport, and a rejected replacement must surface as
 * `skipped` with the exact old instance still wired. ABTARS_HOME is redirected
 * to a tmpdir so the success-path wiring (ActionGate, sealed tool socket) stays
 * contained.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveAgentMock, loadTransportStructuredMock, createAgentTransportMock, readAndClearAcpPidsMock } = vi.hoisted(() => ({
  resolveAgentMock: vi.fn(),
  loadTransportStructuredMock: vi.fn(),
  createAgentTransportMock: vi.fn(),
  readAndClearAcpPidsMock: vi.fn(),
}));

vi.mock("../components/transport-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/transport-config.js")>();
  return {
    ...actual,
    anyProviderUseProviderLib: () => false,
    resolveAgent: (...args: unknown[]) => resolveAgentMock(...args),
    getEnvFallback: () => ({
      model: "fb-model", provider: "fb-provider", providerName: "fb",
      contextWindow: 128000, maxOutput: 4096, fallbacks: [],
    }),
    resolveHailMary: () => null,
    validateProviderReady: () => ({ ok: true as const }),
    validateModelProviderPair: () => ({ ok: true as const }),
    routeAssignments: () => ({ agents: { main: { model: "test-model", provider: "test-provider" } }, fallbacks: [] }),
    loadTransportStructured: (...args: unknown[]) => loadTransportStructuredMock(...args),
  };
});

vi.mock("../components/pi-installation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/pi-installation.js")>();
  return {
    ...actual,
    resolvePiInstallation: () => ({ state: "absent" as const }),
  };
});

vi.mock("../components/agent-registry.js", () => ({
  createAgentTransport: (...args: unknown[]) => createAgentTransportMock(...args),
}));

vi.mock("../components/transport/bridge-lock-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/transport/bridge-lock-transport.js")>();
  return {
    ...actual,
    readAndClearAcpPids: (...args: unknown[]) => readAndClearAcpPidsMock(...args),
  };
});

// #1573: the probe is the external boundary of PiCoreTransport.initialize().
vi.mock("../components/transport/pi-runtime-contract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/transport/pi-runtime-contract.js")>();
  return {
    ...actual,
    validatePiRuntimeContract: vi.fn(async () => {}),
  };
});

import { buildTransport, rebuildTransport, phaseTransport } from "./phase-transport.js";
import { createBootCtx, type BootCtx } from "./context.js";
import { PiCoreTransport } from "../components/transport/pi-core-transport.js";
import { PiRuntimeContractError, validatePiRuntimeContract } from "../components/transport/pi-runtime-contract.js";
import type { IKiroTransport } from "../components/transport/kiro-transport.js";

const TEST_MODEL = "test-model";

function validTransportLoad(): ReturnType<typeof loadTransportStructuredMock> {
  return { ok: true, config: { schemaVersion: 3, activeRoute: "pi-ai", routes: { "pi-ai": { agents: { main: { model: TEST_MODEL, provider: "test-provider" } } } }, providers: {} }, source: "primary" };
}

function validResolvedAgent(): ReturnType<typeof resolveAgentMock> {
  return {
    model: TEST_MODEL,
    provider: { transport: "api", endpoint: "https://api.test/v1", apiFormat: "chat" },
    providerName: "test-provider",
    contextWindow: 128000,
    maxOutput: 4096,
    fallbacks: [],
  };
}

function validAcpResolvedAgent(): ReturnType<typeof resolveAgentMock> {
  return {
    ...validResolvedAgent(),
    provider: { transport: "acp", cli: "kiro-cli" },
  };
}

function makeBootCtx(): BootCtx {
  return createBootCtx({
    memoryConfig: { memoryEnabled: false, memoryDir: "/tmp/no-memory" },
    config: {
      transport: {
        agentCliPath: "node", workingDir: "/tmp/work", trustMode: true,
        permissionTimeoutMs: 60_000, tmuxSession: "kiro", tmuxCaptureDelaySec: 1, tmuxMaxWaitSec: 60,
      },
    } as unknown as BootCtx["config"],
  });
}

function makeOldTransport(): IKiroTransport {
  return {
    initialize: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => ""),
    sendInterrupt: vi.fn(async () => {}),
    resetSession: vi.fn(async () => {}),
    lastUsage: vi.fn(() => null),
    getRuntimeStatus: vi.fn(() => ({ route: "acp" }) as never),
    isReady: true,
    transportCommands: [],
  } as unknown as IKiroTransport;
}

let homeDir: string;

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), "abtars-transport-contract-"));
  process.env.ABTARS_HOME = homeDir;
});

afterAll(() => {
  delete process.env.ABTARS_HOME;
  rmSync(homeDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(validatePiRuntimeContract).mockReset();
  vi.mocked(validatePiRuntimeContract).mockResolvedValue(undefined);
  loadTransportStructuredMock.mockReset();
  loadTransportStructuredMock.mockReturnValue(validTransportLoad());
  resolveAgentMock.mockReset();
  resolveAgentMock.mockReturnValue(validResolvedAgent());
  createAgentTransportMock.mockReset();
  readAndClearAcpPidsMock.mockReset();
  readAndClearAcpPidsMock.mockReturnValue([]);
});

describe("transport readiness contract (#1573)", () => {
  it("initial boot rejects the api route with the typed bounded error and leaves no transport installed", async () => {
    const ctx = makeBootCtx();
    vi.mocked(validatePiRuntimeContract).mockRejectedValueOnce(
      new PiRuntimeContractError("Pi runtime contract incompatible (0.84.0; pi-ai; missing createProvider).", {
        component: "pi-ai", capability: "createProvider",
      }),
    );
    const error = await phaseTransport(ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PiRuntimeContractError);
    const contractError = error as PiRuntimeContractError;
    expect(contractError.component).toBe("pi-ai");
    expect(contractError.remediationCommand).toBe("npm i -g '@earendil-works/pi-coding-agent@~0.83.0'");
    expect(ctx.transport).toBeNull();
  });

  it("rejects with the bounded error when a compatible installation is probed on the api route", async () => {
    const ctx = makeBootCtx();
    vi.mocked(validatePiRuntimeContract).mockRejectedValueOnce(
      new PiRuntimeContractError("Pi runtime contract incompatible (0.84.0; openai-completions; missing streamSimple).", {
        component: "openai-completions", capability: "streamSimple",
      }),
    );
    await expect(buildTransport(ctx)).rejects.toThrow(PiRuntimeContractError);
    expect(ctx.transport).toBeNull();
  });

  it("failed replacement preserves the exact old transport and cleans up only the candidate", async () => {
    const ctx = makeBootCtx();
    const oldTransport = makeOldTransport();
    ctx.transport = oldTransport;
    const destroySpy = vi.spyOn(PiCoreTransport.prototype, "destroy").mockImplementation(() => {});
    try {
      vi.mocked(validatePiRuntimeContract).mockRejectedValueOnce(
        new PiRuntimeContractError("Pi runtime contract incompatible (0.84.0; pi-ai; missing createProvider).", {
          component: "pi-ai", capability: "createProvider",
        }),
      );
      const result = await buildTransport(ctx);
      expect(result).toBe("skipped");
      expect(ctx.transport).toBe(oldTransport);
      expect(oldTransport.destroy).not.toHaveBeenCalled();
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("successful replacement initializes the candidate before destroying the old transport and rewires", async () => {
    const ctx = makeBootCtx();
    const oldTransport = makeOldTransport();
    ctx.transport = oldTransport;
    vi.mocked(validatePiRuntimeContract).mockImplementationOnce(async () => {});
    const result = await buildTransport(ctx);
    expect(result).toBe("ran");
    expect(ctx.transport).toBeInstanceOf(PiCoreTransport);
    expect(ctx.transport).not.toBe(oldTransport);
    expect(oldTransport.destroy).toHaveBeenCalledTimes(1);
    const probeOrder = vi.mocked(validatePiRuntimeContract).mock.invocationCallOrder[0];
    const destroyOrder = (oldTransport.destroy as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(probeOrder).toBeLessThan(destroyOrder);
    expect(ctx.modelName).toBe(TEST_MODEL);
    expect(ctx.modelProvider).toBe("test-provider");
  });

  it("does not sweep ACP processes while an old transport is retained", async () => {
    const ctx = makeBootCtx();
    const oldTransport = makeOldTransport();
    const candidate = makeOldTransport();
    ctx.transport = oldTransport;
    resolveAgentMock.mockReturnValue(validAcpResolvedAgent());
    createAgentTransportMock.mockReturnValue(candidate);

    const result = await buildTransport(ctx);

    expect(result).toBe("ran");
    expect(candidate.initialize).toHaveBeenCalledTimes(1);
    expect(oldTransport.destroy).toHaveBeenCalledTimes(1);
    expect(readAndClearAcpPidsMock).not.toHaveBeenCalled();
  });

  it("rebuildTransport does not rewire downstream references when the replacement is skipped", async () => {
    const ctx = makeBootCtx();
    const oldTransport = makeOldTransport();
    ctx.transport = oldTransport;
    ctx.pipelineDeps = { transport: oldTransport } as never;
    ctx.idleSave = { transport: oldTransport } as never;
    vi.mocked(validatePiRuntimeContract).mockRejectedValueOnce(
      new PiRuntimeContractError("Pi runtime contract incompatible (0.84.0; openai-responses; missing stream).", {
        component: "openai-responses", capability: "stream",
      }),
    );
    const result = await rebuildTransport(ctx);
    expect(result).toBe("skipped");
    expect(ctx.transport).toBe(oldTransport);
    expect((ctx.pipelineDeps as { transport: IKiroTransport }).transport).toBe(oldTransport);
    expect((ctx.idleSave as unknown as { transport: IKiroTransport }).transport).toBe(oldTransport);
  });

  it("rebuildTransport rewires downstream references only after a successful replacement", async () => {
    const ctx = makeBootCtx();
    const oldTransport = makeOldTransport();
    ctx.transport = oldTransport;
    ctx.pipelineDeps = { transport: oldTransport } as never;
    ctx.idleSave = { transport: oldTransport } as never;
    const result = await rebuildTransport(ctx);
    expect(result).toBe("ran");
    expect(ctx.transport).not.toBe(oldTransport);
    expect((ctx.pipelineDeps as { transport: IKiroTransport }).transport).toBe(ctx.transport);
    expect((ctx.idleSave as unknown as { transport: IKiroTransport }).transport).toBe(ctx.transport);
  });
});
