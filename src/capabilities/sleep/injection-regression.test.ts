import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSleepHandle } from "./index.js";

vi.mock("../../components/env-schema.js", () => ({
  getEnv: vi.fn(() => ({ sleepQuality: "normal" })),
}));

vi.mock("../../components/system-event-buffer.js", () => ({
  bufferSystemEvent: vi.fn(),
}));

vi.mock("../../components/transport/bridge-lock-transport.js", () => ({
  writeSleepStatus: vi.fn(),
}));

function makeFakeClient(): any {
  return {
    sleep: {
      start: vi.fn(),
      status: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      events: vi.fn(),
      runtime: { open: vi.fn(), next: vi.fn(), complete: vi.fn(), fail: vi.fn(), close: vi.fn() },
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
}

describe("client-backed sleep handle lifetime (#1381)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("manual start calls client.sleep.start with fresh mode", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });

    const handle = createSleepHandle({
      client, memoryEnabled: false, onComplete: () => {},
      sessionManager: { spin: vi.fn() }, bufferSystemEvent: vi.fn(),
    });

    const result = handle.startManual({ fresh: true, resume: false });
    expect(result.status).toBe("accepted");
    expect(client.sleep.start).toHaveBeenCalledWith("manual", "ultimate", true);
    await settle();
  });

  it("scheduled start calls client.sleep.start with scheduled mode", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-2" });

    const handle = createSleepHandle({
      client, memoryEnabled: false, onComplete: () => {},
      sessionManager: { spin: vi.fn() }, bufferSystemEvent: vi.fn(),
    });

    const result = handle.startScheduled();
    expect(result.status).toBe("accepted");
    expect(client.sleep.start).toHaveBeenCalled();
    await settle();
  });

  it("handle does not call abmind() after construction", async () => {
    const lazy = await import("../../utils/abmind-lazy.js");
    const abmindSpy = vi.spyOn(lazy, "abmind");

    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-3" });

    const handle = createSleepHandle({
      client, memoryEnabled: false, onComplete: () => {},
      sessionManager: { spin: vi.fn() }, bufferSystemEvent: vi.fn(),
    });

    handle.startManual({ fresh: true, resume: false });
    handle.startScheduled();

    expect(abmindSpy).not.toHaveBeenCalled();
    await settle();
  });
});
