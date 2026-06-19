import { describe, it, expect, vi } from "vitest";
import { releaseBusy } from "./busy-guard.js";

describe("releaseBusy", () => {
  it("clears busy flag", () => {
    const session = { busy: true, queue: [], lastActiveAt: 0 };
    releaseBusy(session, vi.fn());
    expect(session.busy).toBe(false);
    expect(session.lastActiveAt).toBeGreaterThan(0);
  });

  it("drains next queued message", () => {
    const pipeline = vi.fn().mockResolvedValue(undefined);
    const msg = { text: "hello" };
    const adapter = { send: vi.fn() };
    const session = { busy: true, queue: [{ msg, adapter }], lastActiveAt: 0 };
    releaseBusy(session, pipeline);
    expect(session.busy).toBe(false);
    expect(session.queue.length).toBe(0);
    expect(pipeline).toHaveBeenCalledWith(msg, adapter);
  });

  it("does not drain if queue empty", () => {
    const pipeline = vi.fn();
    const session = { busy: true, queue: [], lastActiveAt: 0 };
    releaseBusy(session, pipeline);
    expect(pipeline).not.toHaveBeenCalled();
  });
});
