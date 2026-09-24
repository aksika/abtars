import { describe, it, expect, vi } from "vitest";
import {
  normalizeInstallType,
  decideStandbyResumeAction,
  createStandbyResumeHandler,
} from "./phase-heartbeat.js";

describe("normalizeInstallType", () => {
  it("defaults missing input to server", () => {
    expect(normalizeInstallType(undefined)).toBe("server");
  });

  it("accepts server and notebook case-insensitively with whitespace", () => {
    expect(normalizeInstallType("server")).toBe("server");
    expect(normalizeInstallType("  NOTEBOOK  ")).toBe("notebook");
  });

  it("fails safe to server on unrecognized values", () => {
    expect(normalizeInstallType("laptop")).toBe("server");
    expect(normalizeInstallType("")).toBe("server");
  });
});

describe("decideStandbyResumeAction", () => {
  it("exits only for daemon + server + attached supervisor", () => {
    expect(decideStandbyResumeAction({ installMode: "daemon", installType: "server", supervised: true })).toBe("exit");
  });

  it("continues when any single condition is missing", () => {
    expect(decideStandbyResumeAction({ installMode: "daemon", installType: "server", supervised: false })).toBe("continue");
    expect(decideStandbyResumeAction({ installMode: "daemon", installType: "notebook", supervised: true })).toBe("continue");
    expect(decideStandbyResumeAction({ installMode: "simple", installType: "server", supervised: true })).toBe("continue");
    expect(decideStandbyResumeAction({ installMode: "simple", installType: "notebook", supervised: false })).toBe("continue");
  });
});

describe("createStandbyResumeHandler wiring", () => {
  const gapMs = 7 * 60 * 1000;

  function effects() {
    return { exit: vi.fn(), writeReason: vi.fn() };
  }

  it("dark resume never exits and writes no restart reason", () => {
    const { exit, writeReason } = effects();
    const handler = createStandbyResumeHandler({
      installMode: "daemon", installType: "server", supervised: true,
      classify: () => "dark", exit, writeReason,
    });
    handler(gapMs);
    expect(exit).not.toHaveBeenCalled();
    expect(writeReason).not.toHaveBeenCalled();
  });

  it("full resume on daemon+server+supervisor exits with restart reason", () => {
    const { exit, writeReason } = effects();
    const handler = createStandbyResumeHandler({
      installMode: "daemon", installType: "server", supervised: true,
      classify: () => "full", exit, writeReason,
    });
    handler(gapMs);
    expect(writeReason).toHaveBeenCalledWith("resume after 7min suspend");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("full resume continues without exit or restart reason otherwise", () => {
    const cases = [
      { installMode: "daemon", installType: "notebook" as const, supervised: true },
      { installMode: "daemon", installType: "server" as const, supervised: false },
      { installMode: "simple", installType: "server" as const, supervised: false },
    ];
    for (const ctx of cases) {
      const { exit, writeReason } = effects();
      const handler = createStandbyResumeHandler({ ...ctx, classify: () => "full", exit, writeReason });
      handler(gapMs);
      expect(exit).not.toHaveBeenCalled();
      expect(writeReason).not.toHaveBeenCalled();
    }
  });
});
