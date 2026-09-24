import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRestartCheckTask } from "./phase-heartbeat.js";

const mocks = vi.hoisted(() => ({ readAndClearRestartRequested: vi.fn() }));

vi.mock("../components/transport/bridge-lock-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/transport/bridge-lock-transport.js")>();
  return { ...actual, readAndClearRestartRequested: mocks.readAndClearRestartRequested };
});

describe("restart-check task", () => {
  beforeEach(() => { mocks.readAndClearRestartRequested.mockReset(); });

  function effects() {
    return { requestShutdownWithCode: vi.fn(), exit: vi.fn() };
  }

  it("supervised restart flag exits hard so the supervisor respawns cleanly", async () => {
    mocks.readAndClearRestartRequested.mockReturnValue("restart");
    const { requestShutdownWithCode, exit } = effects();
    const task = createRestartCheckTask({ requestShutdownWithCode }, { supervised: true, exit });
    expect(await task.execute()).toEqual({ state: "idle" });
    expect(exit).toHaveBeenCalledWith(0);
    expect(requestShutdownWithCode).not.toHaveBeenCalled();
  });

  it("unsupervised restart flag uses the in-process restart loop", async () => {
    mocks.readAndClearRestartRequested.mockReturnValue("restart");
    const { requestShutdownWithCode, exit } = effects();
    const task = createRestartCheckTask({ requestShutdownWithCode }, { supervised: false, exit });
    await task.execute();
    expect(exit).not.toHaveBeenCalled();
    expect(requestShutdownWithCode).toHaveBeenCalledWith(0);
  });

  it("no pending request is a no-op", async () => {
    mocks.readAndClearRestartRequested.mockReturnValue(null);
    const { requestShutdownWithCode, exit } = effects();
    const task = createRestartCheckTask({ requestShutdownWithCode }, { supervised: false, exit });
    await task.execute();
    expect(exit).not.toHaveBeenCalled();
    expect(requestShutdownWithCode).not.toHaveBeenCalled();
  });

  it("keeps the registered task name", () => {
    const { requestShutdownWithCode } = effects();
    expect(createRestartCheckTask({ requestShutdownWithCode }, { supervised: true }).name).toBe("restart-check");
  });
});
