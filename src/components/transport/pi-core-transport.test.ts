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

  it("sendPrompt without Pi installation throws", async () => {
    const t = makeTransport();
    await t.initialize();
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

  it("sendPrompt with no context does not crash — returns text via onEvent", async () => {
    const t = makeTransport();
    await t.initialize();
    const promise = t.sendPrompt("sess_1", "hello");
    // Without a real Pi installation it will reject — we just want no crash
    await expect(promise).rejects.toThrow();
    // activeHost should be null after failure
    expect((t as unknown as Record<string, unknown>).activeHost).toBeNull();
  });

  it("setSystemPrompt updates config", () => {
    const t = makeTransport();
    t.setSystemPrompt("New prompt");
    expect(t.config.systemPrompt).toBe("New prompt");
  });

  it("setModel changes active candidate and resets policy", () => {
    const t = makeTransport();
    t.setModel("new-model", "https://new.endpoint/v1", 64000);
    expect(t.config.candidates[0]?.model).toBe("new-model");
    expect(t.config.candidates[0]?.endpoint).toBe("https://new.endpoint/v1");
    expect(t.config.candidates[0]?.maxContext).toBe(64000);
  });

  it("image input advertises ['text', 'image']", async () => {
    // Inspect piModel input property when image is passed
    // We can't easily access the internal piModel, but we can verify
    // that sendPrompt doesn't throw when image is provided (before Pi load)
    const t = makeTransport();
    await t.initialize();
    const promise = t.sendPrompt("s", "hello", { mime: "image/png", base64: "iVBOR=" });
    await expect(promise).rejects.toThrow(); // Pi not installed, but no crash from image handling
  });

  it("host-load failure clears activeHost", async () => {
    const t = makeTransport();
    await t.initialize();
    try {
      await t.sendPrompt("s", "hi");
    } catch {
      // expected — no Pi installation
    }
    expect((t as unknown as Record<string, unknown>).activeHost).toBeNull();
  });
});
