import { describe, it, expect, vi, afterEach } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

import {
  processStartIdentity,
  isPidAlive,
  validateBridgePid,
  validateBridgeLock,
} from "./identity.js";

const SELF_PID = process.pid;
const SELF_IDENTITY = processStartIdentity(SELF_PID);

describe("macOS process identity", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true, writable: true });
    execFileSyncMock.mockReset();
  });

  it("rejects a reused system PID by its ps command", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[3] === "lstart=") return "Sat Aug 22 02:00:00 2026\n";
      return "/usr/libexec/AssetCache/AssetCache\n";
    });

    const result = validateBridgePid(SELF_PID, processStartIdentity(SELF_PID), ["abtars.js", "bundle"]);

    expect(result.status).toBe("wrong-command");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });

  it("accepts a live bridge identified by ps", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[3] === "lstart=") return "Sat Aug 22 02:00:00 2026\n";
      return "/opt/homebrew/bin/node /Users/akos/.abtars/app/bundle/abtars.js\n";
    });

    const result = validateBridgePid(SELF_PID, processStartIdentity(SELF_PID), ["abtars.js", "bundle"]);

    expect(result.status).toBe("valid");
    expect(result.safeToSignal).toBe(true);
    expect(result.safeToAdopt).toBe(true);
  });

  it("rejects an uninspectable macOS PID", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    execFileSyncMock.mockImplementation(() => { throw new Error("ps unavailable"); });

    const result = validateBridgePid(SELF_PID, null, ["abtars.js", "bundle"]);

    expect(result.status).toBe("wrong-command");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });
});

describe("processStartIdentity", () => {
  it("returns a string with pid:starttime for a live process", () => {
    const id = processStartIdentity(SELF_PID);
    expect(id).toMatch(/^\d+:\d+$/);
    expect(id.startsWith(`${SELF_PID}:`)).toBe(true);
  });

  it("returns pid:0 for a nonexistent PID", () => {
    const id = processStartIdentity(999_999_999);
    expect(id).toBe("999999999:0");
  });
});

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(SELF_PID)).toBe(true);
  });

  it("returns false for a nonexistent PID", () => {
    expect(isPidAlive(999_999_999)).toBe(false);
  });
});

describe("validateBridgePid", () => {
  it("returns valid for a live process matching identity and needle", () => {
    const result = validateBridgePid(SELF_PID, SELF_IDENTITY, ["node"]);
    expect(result.status).toBe("valid");
    expect(result.safeToSignal).toBe(true);
    expect(result.safeToAdopt).toBe(true);
  });

  it("returns dead for a nonexistent PID", () => {
    const result = validateBridgePid(999_999_999, null, ["node"]);
    expect(result.status).toBe("dead");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });

  it("returns reused for identity mismatch on a live PID", () => {
    const result = validateBridgePid(SELF_PID, "999999999:999", ["node"]);
    expect(result.status).toBe("reused");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });

  it("returns wrong-command when no needle matches", () => {
    const result = validateBridgePid(SELF_PID, SELF_IDENTITY, [
      "this-cmdline-needle-will-never-match-anything",
    ]);
    expect(result.status).toBe("wrong-command");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });

  it("returns valid when expectedIdentity is null (trusts lock)", () => {
    const result = validateBridgePid(SELF_PID, null, ["node"]);
    expect(result.status).toBe("valid");
  });
});

describe("validateBridgeLock", () => {
  const needle = ["node"];

  it("returns corrupt for null lock", () => {
    const result = validateBridgeLock(null, needle);
    expect(result.status).toBe("corrupt");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });

  it("returns corrupt for missing instanceId", () => {
    const result = validateBridgeLock(
      { pid: SELF_PID, startIdentity: SELF_IDENTITY },
      needle,
    );
    expect(result.status).toBe("corrupt");
  });

  it("returns dead for pid=null", () => {
    const result = validateBridgeLock(
      { pid: null, instanceId: "abc", startIdentity: null },
      needle,
    );
    expect(result.status).toBe("dead");
  });

  it("returns dead for pid <= 0", () => {
    const result = validateBridgeLock(
      { pid: 0, instanceId: "abc", startIdentity: null },
      needle,
    );
    expect(result.status).toBe("dead");
  });

  it("returns valid for a complete matching lock", () => {
    const result = validateBridgeLock(
      {
        pid: SELF_PID,
        instanceId: "abc",
        startIdentity: SELF_IDENTITY,
      },
      needle,
    );
    expect(result.status).toBe("valid");
    expect(result.safeToSignal).toBe(true);
    expect(result.safeToAdopt).toBe(true);
  });

  it("returns reused when pid identity does not match", () => {
    const result = validateBridgeLock(
      {
        pid: SELF_PID,
        instanceId: "abc",
        startIdentity: "999999999:999",
      },
      needle,
    );
    expect(result.status).toBe("reused");
  });

  it("returns wrong-command when no needle matches", () => {
    const result = validateBridgeLock(
      {
        pid: SELF_PID,
        instanceId: "abc",
        startIdentity: SELF_IDENTITY,
      },
      ["this-will-never-match"],
    );
    expect(result.status).toBe("wrong-command");
  });
});
