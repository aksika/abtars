import { describe, it, expect, vi } from "vitest";
import { MemorySearchController } from "./memory-search-controller.js";
import type { AbtarsMemoryRuntime } from "./memory-runtime.js";

function makeController() {
  const runtime: Pick<AbtarsMemoryRuntime, "recall"> = {
    recall: vi.fn(async () => ({
      hits: [{ ref: "db:durable:1:master:1", kind: "db" as const, content: "puppy info", date: "2026-01-01" }],
      context: "[1] (db:durable:1:master:1) puppy info",
      status: "evidence",
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
    // #1895 — deliberate dashboard search: parsed keywords cross separately
    // with explicit intent, so this path always searches.
    expect(runtime.recall).toHaveBeenCalledWith({ query: "puppy", profile: "recall_normal", text: "puppy", keywords: ["puppy"], userId: "master", limit: 10, timeStart: undefined, timeEnd: undefined });
    expect((result.body as { results: Array<{ content: string }> }).results[0]?.content).toBe("puppy info");
  });

  it("passes an explicitly selected user to the runtime", async () => {
    const { runtime, controller } = makeController();
    await controller.handle(new URLSearchParams({ keywords: "hello, world", userId: "alice", timeStart: "1" }));
    expect(runtime.recall).toHaveBeenCalledWith({ query: "hello world", profile: "recall_normal", text: "hello world", keywords: ["hello", "world"], userId: "alice", limit: 10, timeStart: 1, timeEnd: undefined });
  });

});
