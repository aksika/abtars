/**
 * spin-coding-teardown.test.ts — #1635 /session end|kill on a coding C
 * envelope runs the generation-fenced coding teardown before finalization.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Spin } from "./spin.js";
import { setUserRegistryOverride, type UserRegistry, type UserEntry } from "./user-registry.js";

function makeUser(userId: string, role: "master" | "user" | "guest", telegram = 100): UserEntry {
  return { userId, role, telegram } as UserEntry;
}

function makeRegistry(users: UserEntry[]): UserRegistry {
  return {
    users,
    byUserId: new Map(users.map(u => [u.userId, u])),
    byTelegramId: new Map(users.map(u => [u.telegram, u])),
  };
}

describe("Spin coding-session teardown (#1635)", () => {
  let spin: Spin;
  let teardown: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spin = new Spin();
    setUserRegistryOverride(makeRegistry([makeUser("aksika", "master", 111)]));
    teardown = vi.fn().mockReturnValue(true);
    spin.setCodingSessionTeardown(teardown);
  });

  afterEach(() => {
    setUserRegistryOverride(null);
  });

  function allocateCodingEnvelope(userId: string, platform: string): import("./spin-types.js").ManagedSession {
    return spin.allocateCodingExternalSession({
      userId,
      platform,
      name: "Coding: repo-a",
      workingDir: "/tmp/ws",
      codingSessionId: "x",
    });
  }

  it("runs the coding teardown before /session end finalizes the envelope", () => {
    const session = allocateCodingEnvelope("aksika", "telegram");
    const idx = session.shortIndex;
    const result = spin.endSession("aksika", "telegram", idx);
    expect(typeof result).not.toBe("string");
    expect(teardown).toHaveBeenCalledWith(session.id);
    expect((result as import("./spin-types.js").ManagedSession).status).toBe("ended");
  });

  it("runs the coding teardown before /session kill", () => {
    const session = allocateCodingEnvelope("aksika", "telegram");
    const idx = session.shortIndex;
    const result = spin.killSession("aksika", "telegram", idx);
    expect(typeof result).not.toBe("string");
    expect(teardown).toHaveBeenCalledWith(session.id);
  });

  it("refuses to finalize while coding teardown is still active", () => {
    teardown.mockReturnValue(false);
    const session = allocateCodingEnvelope("aksika", "telegram");
    const result = spin.endSession("aksika", "telegram", session.shortIndex);
    expect(result).toBe("Coding session is still stopping; retry shortly");
    expect(teardown).toHaveBeenCalledWith(session.id);
    expect(spin.getSessionById(session.id)?.status).not.toBe("ended");
  });

  it("does NOT run the coding teardown for ordinary sessions", () => {
    const session = spin.createSession("aksika", "telegram", "B");
    const idx = (session as import("./spin-types.js").ManagedSession).shortIndex;
    spin.endSession("aksika", "telegram", idx);
    expect(teardown).not.toHaveBeenCalled();
  });

  it("does NOT run the teardown for a /pi run external session (runId metadata)", () => {
    const session = spin.allocateExternalSession({
      type: "C",
      userId: "aksika",
      platform: "pi",
      name: "Pi: goal",
      workingDir: "/tmp/ws",
      metadata: { runId: "run-1", generation: 1, executor: "pi" },
    });
    const idx = session.shortIndex;
    spin.endSession("aksika", "pi", idx);
    expect(teardown).not.toHaveBeenCalled();
  });

  it("endSession without an index resolves the active session", () => {
    allocateCodingEnvelope("aksika", "telegram");
    // a coding envelope is never active; the active A session is the target
    spin.getActiveSession("aksika", "telegram");
    spin.endSession("aksika", "telegram");
    expect(teardown).not.toHaveBeenCalled();
  });
});
