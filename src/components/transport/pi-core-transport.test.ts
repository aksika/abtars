// TEST DEFICIENCY: Real-Pi integration test (loading actual pi-agent-core) is
// deferred — requires a full Pi installation. These tests verify the compositor
// structure and lifecycle with mocked dependencies.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PiCoreTransport } from "./pi-core-transport.js";
import type { ModelCandidate } from "./model-candidates.js";
import { ModelHealthRegistry } from "./model-health-registry.js";

function makeCandidates(): ModelCandidate[] {
  return [{
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
    apiKey: "test-key",
    source: "primary",
  }];
}

function makeTransport() {
  const registry = new ModelHealthRegistry();
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "You are a helpful assistant.",
    candidates: makeCandidates(),
    healthRegistry: registry,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
  });
}

describe("PiCoreTransport", () => {
  it("constructs with main role", () => {
    const t = makeTransport();
    expect(t.config.role).toBe("main");
    expect(t.config.candidates).toHaveLength(1);
  });

  it("starts uninitialized", () => {
    const t = makeTransport();
    expect(t.isReady).toBe(false);
  });

  it("initialize sets isReady", async () => {
    const t = makeTransport();
    await t.initialize();
    expect(t.isReady).toBe(true);
  });

  it("implements IKiroTransport interface", () => {
    const t = makeTransport();
    expect(typeof t.initialize).toBe("function");
    expect(typeof t.sendPrompt).toBe("function");
    expect(typeof t.resetSession).toBe("function");
    expect(typeof t.sendInterrupt).toBe("function");
    expect(typeof t.destroy).toBe("function");
    expect(typeof t.lastUsage).toBe("function");
    expect(typeof t.getRuntimeStatus).toBe("function");
  });

  it("getRuntimeStatus returns route/provider/model", () => {
    const t = makeTransport();
    const status = t.getRuntimeStatus();
    expect(status.route).toBe("pi-ai");
    expect(status.provider).toBe("test-provider");
    expect(status.model).toBe("test-model");
  });

  it("resetSession clears state", async () => {
    const t = makeTransport();
    await t.resetSession("test_session");
    expect(t.isReady).toBe(false);
  });

  it("destroy clears active host", () => {
    const t = makeTransport();
    t.destroy();
    expect(t.isReady).toBe(false);
  });

  it("sendPrompt requires Pi installation", async () => {
    const t = makeTransport();
    await t.initialize();
    // Without a real Pi installation, loadAndValidatePiAgentCore will throw
    await expect(t.sendPrompt("test_session", "hello")).rejects.toThrow();
  });

  it("interrupt on inactive host does not throw", async () => {
    const t = makeTransport();
    await t.sendInterrupt();
  });

  it("supports specialist role", () => {
    const registry = new ModelHealthRegistry();
    const t = new PiCoreTransport({
      role: "specialist",
      systemPrompt: "",
      candidates: makeCandidates(),
      healthRegistry: registry,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    });
    expect(t.config.role).toBe("specialist");
  });
});
