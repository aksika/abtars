import { describe, it, expect, vi } from "vitest";
import { MemorySearchController } from "./memory-search-controller.js";

function makeController() {
  const runtime = {
    recall: vi.fn(async () => ({
      hits: [{ content: "puppy info", score: 0.95, date: "2026-01-01" }],
      context: "",
    })),
  };
  return { runtime, controller: new MemorySearchController({ memoryRuntime: runtime, defaultUserId: "master" }) };
}

describe("MemorySearchController", () => {
  it("rejects an empty query", async () => {
    const { controller } = makeController();
    expect((await controller.handle(new URLSearchParams())).status).toBe(400);
  });

  it("searches through the daemon-backed runtime and defaults to the master user", async () => {
    const { runtime, controller } = makeController();
    const result = await controller.handle(new URLSearchParams({ keywords: "puppy" }));
    expect(result.status).toBe(200);
    expect(runtime.recall).toHaveBeenCalledWith({ query: "puppy", original: "puppy", userId: "master", limit: 10, timeStart: undefined, timeEnd: undefined, stages: undefined });
    expect((result.body as { results: Array<{ content: string }> }).results[0]?.content).toBe("puppy info");
  });

  it("passes an explicitly selected user to the runtime", async () => {
    const { runtime, controller } = makeController();
    await controller.handle(new URLSearchParams({ keywords: "hello, world", original: "hello world", stages: "Sf,Ss", userId: "alice", timeStart: "1" }));
    expect(runtime.recall).toHaveBeenCalledWith({ query: "hello world", original: "hello world", userId: "alice", limit: 10, timeStart: 1, timeEnd: undefined, stages: ["Sf", "Ss"] });
  });

  it("does not pretend unsupported enumeration is available", () => {
    const { controller } = makeController();
    expect(controller.listChats().status).toBe(501);
    expect(controller.listAll().status).toBe(501);
  });
});
