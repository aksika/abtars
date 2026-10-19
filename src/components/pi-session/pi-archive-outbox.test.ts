import { describe, expect, it, vi } from "vitest";
import { PiArchiveOutbox } from "./pi-archive-outbox.js";

function record(sessionId = "1_A_01", operationKey = "op-1") {
  return {
    role: "assistant" as const,
    content: "delivered answer",
    timestamp: 1000,
    userId: "u1",
    sessionId,
    operationKey,
  };
}

describe("pi-archive-outbox", () => {
  it("holds a terminal write until durable confirmation, then clears", async () => {
    const outbox = new PiArchiveOutbox();
    expect(outbox.has("1_A_01")).toBe(false);
    outbox.note(record());
    expect(outbox.has("1_A_01")).toBe(true);

    const seenKeys: string[] = [];
    const recordFn = async (_input: unknown, key: string) => {
      seenKeys.push(key);
      return { id: 42 };
    };
    await expect(outbox.flush("1_A_01", recordFn)).resolves.toBe(true);
    expect(seenKeys).toEqual(["op-1"]);
    expect(outbox.has("1_A_01")).toBe(false);
  });

  it("keeps the obligation when confirmation is missing or the write throws", async () => {
    const outbox = new PiArchiveOutbox();
    outbox.note(record());
    await expect(outbox.flush("1_A_01", async () => ({ id: null }))).resolves.toBe(false);
    expect(outbox.has("1_A_01")).toBe(true);
    await expect(outbox.flush("1_A_01", async () => { throw new Error("owner down"); })).resolves.toBe(false);
    expect(outbox.has("1_A_01")).toBe(true);
  });

  it("flush with nothing held admits without recording", async () => {
    const outbox = new PiArchiveOutbox();
    const recordFn = vi.fn(async () => ({ id: 7 }));
    await expect(outbox.flush("1_A_01", recordFn)).resolves.toBe(true);
    expect(recordFn).not.toHaveBeenCalled();
  });

  it("replaces the held payload for the same session", () => {
    const outbox = new PiArchiveOutbox();
    outbox.note(record("1_A_01", "op-old"));
    outbox.note(record("1_A_01", "op-new"));
    expect(outbox.peek("1_A_01")?.operationKey).toBe("op-new");
    expect(outbox.size).toBe(1);
  });

  it("bounds unacknowledged sessions with loud oldest-first eviction", () => {
    const outbox = new PiArchiveOutbox();
    for (let i = 0; i < 256; i++) outbox.note(record(`s_${i}`, `op-${i}`));
    expect(outbox.size).toBe(256);
    outbox.note(record("s_new", "op-new"));
    expect(outbox.size).toBe(256);
    expect(outbox.has("s_0")).toBe(false);
    expect(outbox.has("s_new")).toBe(true);
  });
});
