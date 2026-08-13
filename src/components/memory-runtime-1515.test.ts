/**
 * memory-runtime-1515.test.ts — #1515 dreamQuestions capability projection
 * and normalized runtime methods.
 */

import { describe, expect, it, vi } from "vitest";
import { createClientRuntime, createDisabledRuntime, createUnavailableRuntime } from "./memory-runtime.js";

function mockClient(overrides: Record<string, unknown> = {}) {
  const dreamQuestions = {
    nextPending: vi.fn().mockResolvedValue({
      id: "q-1", memoryAId: 10, memoryBId: 20, question: "test question?", status: "pending",
      createdAt: 1000, expiresAt: 605800000,
    }),
    list: vi.fn().mockResolvedValue({ questions: [] }),
    markAsked: vi.fn().mockResolvedValue({ status: "asked" }),
    dismiss: vi.fn().mockResolvedValue({ status: "dismissed" }),
    ...(overrides.dreamQuestions ?? {}),
  };
  return {
    capabilities: { version: 1, methods: ["private.dreamQuestions.nextPending", "private.dreamQuestions.list", "private.dreamQuestions.markAsked", "private.dreamQuestions.dismiss"], features: {} },
    privateMemory: { ...(overrides.privateMemory ?? {}), dreamQuestions },
    sleep: { status: vi.fn().mockResolvedValue({ state: "idle" }) },
    routeSnapshot: { version: 1, state: "ready", generation: 1, retryEligible: 0, terminalUnknown: 0 },
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as import("abmind").AbmindClient;
}

describe("dreamQuestions capability projection", () => {
  it("adds the dreamQuestions capability only when all four methods are negotiated", () => {
    const full = createClientRuntime(mockClient());
    expect(full.supports("dreamQuestions")).toBe(true);

    const partial = createClientRuntime(mockClient({
      capabilities: {
        version: 1,
        methods: ["private.dreamQuestions.nextPending", "private.dreamQuestions.list"],
        features: {},
      },
    }));
    expect(partial.supports("dreamQuestions")).toBe(false);

    const none = createClientRuntime(mockClient({ capabilities: { version: 1, methods: [], features: {} } }));
    expect(none.supports("dreamQuestions")).toBe(false);
  });

  it("disabled and unavailable runtimes never support dream questions", () => {
    expect(createDisabledRuntime().supports("dreamQuestions")).toBe(false);
    expect(createUnavailableRuntime().supports("dreamQuestions")).toBe(false);
  });
});

describe("dreamQuestions runtime methods", () => {
  it("nextPending normalizes and returns the wire projection", async () => {
    const client = mockClient();
    const rt = createClientRuntime(client);
    const pending = await rt.dreamQuestions.nextPending("master");
    expect(pending).toEqual({
      id: "q-1", memoryAId: 10, memoryBId: 20, question: "test question?", status: "pending",
      createdAt: 1000, expiresAt: 605800000,
    });
    expect(client.privateMemory.dreamQuestions.nextPending).toHaveBeenCalledWith("master");
  });

  it("nextPending returns null for an empty result", async () => {
    const client = mockClient({ dreamQuestions: { nextPending: vi.fn().mockResolvedValue(null) } });
    const rt = createClientRuntime(client);
    expect(await rt.dreamQuestions.nextPending("master")).toBeNull();
  });

  it("markAsked derives a stable idempotency key from question id and delivery key", async () => {
    const client = mockClient();
    const rt = createClientRuntime(client);
    const result = await rt.dreamQuestions.markAsked("master", "q-1", "delivery-1");
    expect(result.status).toBe("asked");
    expect(client.privateMemory.dreamQuestions.markAsked).toHaveBeenCalledWith(
      { userId: "master", questionId: "q-1", deliveryKey: "delivery-1" },
      "dream-question-ask-q-1-delivery-1",
    );
  });

  it("markAsked returns conflict and not_found as data", async () => {
    const conflict = createClientRuntime(mockClient({ dreamQuestions: { markAsked: vi.fn().mockResolvedValue({ status: "conflict" }) } }));
    expect((await conflict.dreamQuestions.markAsked("master", "q-1", "d")).status).toBe("conflict");
    const notFound = createClientRuntime(mockClient({ dreamQuestions: { markAsked: vi.fn().mockResolvedValue({ status: "not_found" }) } }));
    expect((await notFound.dreamQuestions.markAsked("master", "q-1", "d")).status).toBe("not_found");
  });

  it("dismiss uses a stable per-question idempotency key", async () => {
    const client = mockClient();
    const rt = createClientRuntime(client);
    await rt.dreamQuestions.dismiss("master", "q-1");
    expect(client.privateMemory.dreamQuestions.dismiss).toHaveBeenCalledWith(
      { userId: "master", questionId: "q-1" },
      "dream-question-dismiss-q-1",
    );
  });

  it("list passes the status filter and bounded limit through", async () => {
    const client = mockClient({ dreamQuestions: { list: vi.fn().mockResolvedValue({ questions: [] }) } });
    const rt = createClientRuntime(client);
    await rt.dreamQuestions.list("master", "pending", 5);
    expect(client.privateMemory.dreamQuestions.list).toHaveBeenCalledWith("master", "pending", 5);
  });

  it("malformed responses fail closed instead of fabricating data", async () => {
    const bad = createClientRuntime(mockClient({ dreamQuestions: { nextPending: vi.fn().mockResolvedValue({ id: 42 }) } }));
    await expect(bad.dreamQuestions.nextPending("master")).rejects.toThrow();
    const badStatus = createClientRuntime(mockClient({ dreamQuestions: { markAsked: vi.fn().mockResolvedValue({ status: "bogus" }) } }));
    await expect(badStatus.dreamQuestions.markAsked("master", "q-1", "d")).rejects.toThrow();
  });
});
