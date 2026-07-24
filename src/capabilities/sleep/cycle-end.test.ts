import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../components/env-schema.js", () => ({
  getEnv: vi.fn(() => ({ sleepQuality: "normal" })),
}));

vi.mock("../../components/system-event-buffer.js", () => ({
  bufferSystemEvent: vi.fn(),
}));

vi.mock("../../components/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../components/transport/bridge-lock-transport.js", () => ({
  writeSleepStatus: vi.fn(),
}));

import { createSleepHandle } from "./index.js";

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

describe("createSleepHandle — client-backed lifecycle (#1381)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns already_running when sleep is active", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockImplementation(() => new Promise(() => {})); // never resolves

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    const r1 = handle.startScheduled();
    expect(r1.status).toBe("accepted");

    const r2 = handle.startScheduled();
    expect(r2.status).toBe("already_running");
  });

  it("calls client.sleep.start with scheduled mode", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    handle.startScheduled();
    await settle();

    expect(client.sleep.start).toHaveBeenCalledWith("scheduled", "normal", undefined);
  });

  it("calls client.sleep.start with manual mode on /sleep now", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-2" });

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    handle.startManual({ fresh: true, resume: false });
    await settle();

    expect(client.sleep.start).toHaveBeenCalledWith("manual", "ultimate", true);
  });

  it("calls client.sleep.resume when resume=true", async () => {
    const client = makeFakeClient();
    client.sleep.resume.mockResolvedValue({ status: "accepted", runId: "run-3" });

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    handle.startManual({ fresh: false, resume: true });
    await settle();

    expect(client.sleep.resume).toHaveBeenCalled();
  });
});
