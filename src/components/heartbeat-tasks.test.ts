import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUserSessionExpiryTask } from "./heartbeat-tasks.js";

describe("createUserSessionExpiryTask", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns idle when no sessions", async () => {
    vi.doMock("./spin.js", () => ({
      spin: { listAllSessions: () => [] },
    }));
    const task = createUserSessionExpiryTask();
    const result = await task.execute();
    expect(result.state).toBe("idle");
  });

  it("returns idle when no expired sessions", async () => {
    vi.doMock("./spin.js", () => ({
      spin: {
        listAllSessions: () => [{
          idleTimeoutMs: 60000,
          status: "ready",
          transport: {},
          lastActiveAt: Date.now(),
          userId: "user", id: "sess1",
        }],
        destroySession: vi.fn(),
      },
    }));
    const task = createUserSessionExpiryTask();
    const result = await task.execute();
    expect(result.state).toBe("idle");
  });
});