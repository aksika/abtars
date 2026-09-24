import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptArgs, smokeLauncher } from "./interactive-tui.js";
import { SpawnedChild } from "./child-process.js";

describe("interactive TUI smoke prerequisite (#1842)", () => {
  it("probe command executes successfully on this platform", () => {
    const launcher = smokeLauncher();
    expect(() =>
      execFileSync(launcher.execPath, [...launcher.prefixArgs, ...scriptArgs(":")], {
        stdio: "ignore",
        timeout: 10_000,
      }),
    ).not.toThrow();
  });

  // The socketpair stdin Node gives children is fatal to BSD script
  // (tcgetattr EOPNOTSUPP); the darwin pump must carry a full interactive
  // round trip: spawn, stdin write, pty read-back, clean exit.
  // macOS-only: Linux runs script directly on pipes.
  it("pump carries interactive input through script", async () => {
    if (process.platform !== "darwin") return;
    const launcher = smokeLauncher();
    const dir = mkdtempSync(join(tmpdir(), "pi-tui-test-"));
    const child = new SpawnedChild({
      execPath: launcher.execPath,
      args: [...launcher.prefixArgs, ...scriptArgs("read line; echo got:$line")],
      cwd: dir,
      env: { ...process.env, TERM: "xterm-256color" },
      logDir: dir,
      name: "pump-probe",
      input: true,
    });
    try {
      child.stdin.write("hello-pump\n");
      const deadline = Date.now() + 10_000;
      let out = "";
      while (Date.now() < deadline) {
        out = child.stdoutTail;
        if (out.includes("got:hello-pump")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(out).toContain("got:hello-pump");
      const exit = await child.waitForExit(10_000);
      expect(exit.exitCode).toBe(0);
    } finally {
      if (!child.exited) await child.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
