/**
 * agent-registry.test — #1527 production construction through the REAL
 * createSubagentTransport factory: a specialist Pi transport created via the
 * real PiCoreTransport constructor must capture the shared late-bound
 * provider holder. Only the transport-config/env boundary is mocked.
 * #1932: every Pi transport carries exactly its configured candidate — no
 * Main inheritance, no route fallbacks, no rotation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadTransport = vi.hoisted(() => vi.fn());
const mockGetEnvFallback = vi.hoisted(() => vi.fn());
const mockResolveAgent = vi.hoisted(() => vi.fn());
const mockRouteAssignments = vi.hoisted(() => vi.fn());
const mockAcpTransport = vi.hoisted(() => vi.fn(function AcpTransportMock(
  this: unknown,
  _cliPath: string,
  _workingDir: string,
  _opts?: { agent?: string; model?: string; cliArgs?: string[] },
) {
  return { initialize: vi.fn().mockResolvedValue(undefined) };
}));
const mockLoadAndValidateConfig = vi.hoisted(() => vi.fn().mockResolvedValue({ transport: { agentCliPath: "/usr/bin/kiro-cli", workingDir: "/tmp/work" } }));

vi.mock("./transport-config.js", () => ({
  loadTransport: mockLoadTransport,
  resolveAgent: mockResolveAgent,
  routeAssignments: mockRouteAssignments,
  getEnvFallback: mockGetEnvFallback,
}));

vi.mock("./env-schema.js", () => ({
  getEnv: () => ({ getApiKey: () => "test-key" }),
}));

vi.mock("./transport/acp-transport.js", () => ({ AcpTransport: mockAcpTransport }));
vi.mock("./config.js", () => ({ loadAndValidateConfig: mockLoadAndValidateConfig }));

// The runtime contract probe needs a compatible Pi installation in the
// environment; construction, candidate policy, and holder capture do not.
// Stub only the probe so these tests prove the real factory path hermetically.
vi.mock("./transport/pi-runtime-contract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport/pi-runtime-contract.js")>();
  return {
    ...actual,
    validatePiRuntimeContract: vi.fn(async () => {}),
  };
});

const { createSubagentTransport } = await import("./agent-registry.js");
const { PiCoreTransport } = await import("./transport/pi-core-transport.js");

function apiAgentFallback() {
  return {
    model: "test-model",
    provider: { transport: "api", endpoint: "https://api.test/v1", apiKeyEnv: "API_KEY" },
    providerName: "test-provider",
    contextWindow: 128000,
    maxOutput: 4096,
    fallbacks: [],
  };
}

/** A transport-config with healthy main/dreamy/fallback providers and a route
 *  assignment whose fallback list is populated. */
function tcWithFallbacks() {
  return {
    providers: {
      "test-provider": { apiKeyEnv: "API_KEY" },
      "fallback-provider": { apiKeyEnv: "API_KEY" },
      "main-provider": { apiKeyEnv: "API_KEY" },
    },
    maxToolRounds: 10,
    maxFallbackToolRounds: 2,
  };
}

function dreamyAgent() {
  return {
    model: "dreamy-model",
    provider: { transport: "api", endpoint: "https://dreamy.test/v1", apiKeyEnv: "API_KEY" },
    providerName: "test-provider",
    contextWindow: 128000,
    maxOutput: 4096,
    fallbacks: [],
  };
}

function mainAgent() {
  return {
    model: "main-model",
    provider: { transport: "api", endpoint: "https://main.test/v1", apiKeyEnv: "API_KEY" },
    providerName: "main-provider",
    contextWindow: 128000,
    maxOutput: 4096,
    fallbacks: [],
  };
}

function candidateOf(transport: unknown): { model: string; source?: string } {
  return (transport as { config: { candidate: { model: string; source?: string } } }).config.candidate;
}

describe("createSubagentTransport #1527", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadTransport.mockReturnValue(null);
    mockGetEnvFallback.mockReturnValue(apiAgentFallback());
    mockResolveAgent.mockReturnValue(null);
    mockRouteAssignments.mockReturnValue(null);
  });

  it("constructs a real PiCoreTransport through the real factory (api route)", async () => {
    const { transport } = await createSubagentTransport("task");
    expect(transport).toBeInstanceOf(PiCoreTransport);
    expect(transport.isReady).toBe(true);
  });

  it("wires memory-tool deps through the real factory (api route, #1940)", async () => {
    const memoryToolDeps = { current: null };
    const { transport } = await createSubagentTransport("task", memoryToolDeps);
    expect(transport).toBeInstanceOf(PiCoreTransport);
    // The Pi route no longer reads durable context per turn; the AgentSession
    // route marker is the integration evidence.
    expect((transport as unknown as { piAgentSessionRoute: boolean }).piAgentSessionRoute).toBe(true);
  });

  it("constructs without a composed provider (fail-closed baseline)", async () => {
    const { transport } = await createSubagentTransport("task");
    expect(transport).toBeInstanceOf(PiCoreTransport);
    expect(transport.isReady).toBe(true);
  });
});

describe("createSubagentTransport — single configured candidate (#1932)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadTransport.mockReturnValue(tcWithFallbacks());
    mockResolveAgent.mockImplementation((agentName: string) => {
      if (agentName === "dreamy") return dreamyAgent();
      if (agentName === "main") return mainAgent();
      return null;
    });
    mockRouteAssignments.mockReturnValue({ fallbacks: [{ provider: "fallback-provider", model: "fallback-model" }] });
    mockGetEnvFallback.mockReturnValue(apiAgentFallback());
  });

  it("carries exactly the configured candidate under configured-only", async () => {
    const { transport, model } = await createSubagentTransport("sleep", undefined, "configured-only");
    expect(model).toBe("dreamy-model");
    expect(candidateOf(transport).model).toBe("dreamy-model");
  });

  it("carries exactly the configured candidate with no route assignments", async () => {
    mockResolveAgent.mockImplementation((agentName: string) => (agentName === "dreamy" ? dreamyAgent() : null));
    mockRouteAssignments.mockReturnValue(null);
    const { transport } = await createSubagentTransport("sleep", undefined, "configured-only");
    expect(candidateOf(transport).model).toBe("dreamy-model");
  });

  it("ignores inherited Main and route fallbacks under the default policy", async () => {
    const { transport } = await createSubagentTransport("sleep", undefined, "fallback-chain");
    expect(candidateOf(transport).model).toBe("dreamy-model");
  });

  it("non-sleep roles also carry exactly one candidate", async () => {
    const { transport } = await createSubagentTransport("task");
    expect(candidateOf(transport).model).toBe("main-model");
  });

  it("ACP configured-only initializes only the configured model", async () => {
    mockResolveAgent.mockImplementation((agentName: string) => {
      if (agentName === "dreamy") {
        return {
          ...dreamyAgent(),
          provider: { transport: "acp", cli: "/usr/bin/kiro-cli" },
        };
      }
      if (agentName === "main") return mainAgent();
      return null;
    });

    const { model } = await createSubagentTransport("sleep", undefined, "configured-only");

    expect(model).toBe("dreamy-model");
    expect(mockAcpTransport).toHaveBeenCalledTimes(1);
    expect(mockAcpTransport.mock.calls[0]![2]).toMatchObject({ model: "dreamy-model" });
  });

  it("ACP honors an explicit sleep workingDir override, else the configured one (#1807)", async () => {
    mockResolveAgent.mockImplementation((agentName: string) => {
      if (agentName === "dreamy") {
        return {
          ...dreamyAgent(),
          provider: { transport: "acp", cli: "/usr/bin/kiro-cli" },
        };
      }
      if (agentName === "main") return mainAgent();
      return null;
    });

    await createSubagentTransport("sleep", undefined, "configured-only", "/tmp/sleep-scope");
    expect(mockAcpTransport.mock.calls[0]![1]).toBe("/tmp/sleep-scope");

    vi.clearAllMocks();
    await createSubagentTransport("sleep", undefined, "configured-only");
    expect(mockAcpTransport.mock.calls[0]![1]).toBe("/tmp/work");
  });
});
