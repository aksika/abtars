/**
 * agent-registry.test — #1527 production construction through the REAL
 * createSubagentTransport factory: a specialist Pi transport created via the
 * real PiCoreTransport constructor must capture the shared late-bound
 * provider holder. Only the transport-config/env boundary is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadTransport = vi.hoisted(() => vi.fn());
const mockGetEnvFallback = vi.hoisted(() => vi.fn());

vi.mock("./transport-config.js", () => ({
  loadTransport: mockLoadTransport,
  resolveAgent: vi.fn(() => null),
  routeAssignments: vi.fn(() => null),
  getEnvFallback: mockGetEnvFallback,
}));

vi.mock("./env-schema.js", () => ({
  getEnv: () => ({ getApiKey: () => "test-key" }),
}));

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

describe("createSubagentTransport #1527", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadTransport.mockReturnValue(null);
    mockGetEnvFallback.mockReturnValue(apiAgentFallback());
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
