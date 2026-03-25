import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IdleSave } from "./idle-save.js";
import type { IKiroTransport } from "./kiro-transport.js";

function mockTransport(): IKiroTransport {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("saved"),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    get isReady() { return true; },
  };
}

describe("IdleSave", () => {
  let transport: IKiroTransport;
  let idle: IdleSave;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = mockTransport();
    idle = new IdleSave(transport, "/tmp/mem", true);
  });

  afterEach(() => {
    idle.clearAll();
    vi.useRealTimers();
  });

  it("save sends /chat save command to transport", async () => {
    await idle.save("s1", 100);
    expect(transport.sendPrompt).toHaveBeenCalledWith("s1", expect.stringContaining("/chat save"));
  });

  it("save is no-op when disabled", async () => {
    const disabled = new IdleSave(transport, "/tmp/mem", false);
    await disabled.save("s1", 100);
    expect(transport.sendPrompt).not.toHaveBeenCalled();
  });

  it("reset sets a timer that triggers save", async () => {
    idle.reset("s1", 100);
    expect(idle.getTimers().has("s1")).toBe(true);

    // Advance past the 10-min idle timeout
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
    expect(transport.sendPrompt).toHaveBeenCalled();
    expect(idle.getTimers().has("s1")).toBe(false);
  });

  it("reset replaces existing timer", () => {
    idle.reset("s1", 100);
    const t1 = idle.getTimers().get("s1");
    idle.reset("s1", 200);
    const t2 = idle.getTimers().get("s1");
    expect(t1).not.toBe(t2);
  });

  it("clearAll removes all timers", () => {
    idle.reset("s1", 100);
    idle.reset("s2", 200);
    idle.clearAll();
    expect(idle.getTimers().size).toBe(0);
  });
});
