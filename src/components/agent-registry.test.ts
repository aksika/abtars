/**
 * agent-registry.test — #1527 production construction through the REAL
 * createSubagentTransport factory: a specialist Pi transport created via the
 * real PiCoreTransport constructor must capture the shared late-bound
 * provider holder. Only the transport-config/env boundary is mocked.
 * #1611: configured-only candidate policy must exclude inherited Main and
 * every route fallback during transport construction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadTransport = vi.hoisted(() => vi.fn());
const mockGetEnvFallback = vi.hoisted(() => vi.fn());
const mockResolveAgent = vi.hoisted(() => vi.fn());
const mockRouteAssignments = vi.hoisted(() => vi.fn());
const mockAcpTransport = vi.hoisted(() => vi.fn(function AcpTransportMock() {
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

const INHERITED_MAIN = {
  model: "main-model",
  provider: "main-provider",
  endpoint: "https://main.test/v1",
  maxContext: 128000,
  apiFormat: "openai" as const,
  thinking: false,
};

function candidatesOf(transport: unknown): Array<{ model: string; source?: string }> {
  return (transport as { config: { candidates: Array<{ model: string; source?: string }> } }).config.candidates;
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

  it("passes the late-bound provider holder into the constructed transport", async () => {
    const holder = { current: null };
    const { transport } = await createSubagentTransport("task", undefined, null, holder);
    expect(transport).toBeInstanceOf(PiCoreTransport);
    const stored = (transport as unknown as { _contextProvider: typeof holder })._contextProvider;
    expect(stored).toBe(holder);

    // Late binding must reach the transport after construction.
    const provider = { projectContext: vi.fn() };
    holder.current = provider;
    expect(stored.current).toBe(provider);
  });

  it("defaults to an empty holder when none is composed", async () => {
    const { transport } = await createSubagentTransport("task");
    const stored = (transport as unknown as { _contextProvider: { current: unknown } })._contextProvider;
    expect(stored.current).toBeNull();
  });
});

describe("createSubagentTransport — configured-only candidate policy (#1611)", () => {
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

  it("configured-only excludes inherited Main and every route fallback candidate", async () => {
    const { transport, model } = await createSubagentTransport("sleep", undefined, INHERITED_MAIN, undefined, undefined, "configured-only");
    expect(model).toBe("dreamy-model");
    const candidates = candidatesOf(transport);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.model, "only the configured Dreamy candidate may be initialized").toBe("dreamy-model");
  });

  it("configured-only works with no inherited Main and no route assignments", async () => {
    mockResolveAgent.mockImplementation((agentName: string) => (agentName === "dreamy" ? dreamyAgent() : null));
    mockRouteAssignments.mockReturnValue(null);
    const { transport } = await createSubagentTransport("sleep", undefined, null, undefined, undefined, "configured-only");
    const candidates = candidatesOf(transport);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.model).toBe("dreamy-model");
  });

  it("default callers keep the full fallback chain (inherited Main + route fallbacks)", async () => {
    const { transport } = await createSubagentTransport("sleep", undefined, INHERITED_MAIN, undefined, undefined, "fallback-chain");
    const candidates = candidatesOf(transport);
    const models = candidates.map(c => c.model);
    expect(models).toContain("dreamy-model");
    expect(models).toContain("main-model");
    expect(models).toContain("fallback-model");
  });

  it("non-sleep roles default to fallback-chain", async () => {
    const { transport } = await createSubagentTransport("task", undefined, INHERITED_MAIN, undefined, undefined);
    expect(candidatesOf(transport).length).toBeGreaterThan(1);
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

    const { model } = await createSubagentTransport("sleep", undefined, INHERITED_MAIN, undefined, undefined, "configured-only");

    expect(model).toBe("dreamy-model");
    expect(mockAcpTransport).toHaveBeenCalledTimes(1);
    expect(mockAcpTransport.mock.calls[0]![2]).toMatchObject({ model: "dreamy-model" });
  });
});
