import { describe, expect, it } from "vitest";
import { startDaemonService } from "./start.js";

describe("startDaemonService", () => {
  it("reports a Linux service-manager failure", () => {
    const calls: string[][] = [];
    const execFile = ((command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (args[1] === "start") throw new Error("unit failed to start");
    }) as any;

    const result = startDaemonService("linux", execFile);

    expect(result).toEqual({ ok: false, error: "start watchdog unit: unit failed to start" });
    expect(calls).toEqual([
      ["systemctl", "--user", "unmask", "abtars-watchdog"],
      ["systemctl", "--user", "enable", "abtars-watchdog"],
      ["systemctl", "--user", "start", "abtars-watchdog"],
    ]);
  });

  it("accepts an already-loaded macOS service but reports other bootstrap failures", () => {
    const alreadyLoaded = startDaemonService("darwin", ((() => {
      throw new Error("domain is already bootstrapped");
    }) as any));
    expect(alreadyLoaded).toEqual({ ok: true });

    const failed = startDaemonService("darwin", ((() => {
      throw new Error("permission denied");
    }) as any));
    expect(failed).toEqual({ ok: false, error: "launchctl bootstrap: permission denied" });
  });
});
