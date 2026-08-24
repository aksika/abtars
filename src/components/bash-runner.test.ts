import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { runBashCommand, STDOUT_CAP_CHARS, STDERR_CAP_CHARS } from "./bash-runner.js";

const FAST_GRACE = 200;

function setsidAvailable(): boolean {
  try {
    execFileSync("which", ["setsid"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("runBashCommand", () => {
  it("captures stdout and exit code for a normal exit", async () => {
    const result = await runBashCommand({ cmd: "echo hello", bin: "bash", args: ["-c", "echo hello"], timeoutMs: 5000 });
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.stdout).toContain("hello");
    expect(result.cleanup_incomplete).toBeUndefined();
  });

  it("preserves non-zero exit codes", async () => {
    const result = await runBashCommand({ cmd: "exit 3", bin: "bash", args: ["-c", "exit 3"], timeoutMs: 5000 });
    expect(result.exit_code).toBe(3);
    expect(result.timed_out).toBe(false);
  });

  it("reports spawn errors via process_error_code", async () => {
    const result = await runBashCommand({ cmd: "whatever", bin: "/nonexistent-binary-#1716", args: [], timeoutMs: 5000 });
    expect(result.process_error_code).toBe("ENOENT");
    expect(result.exit_code).toBeNull();
  });

  it("settles at deadline even when the leader ignores completion (#1716 incident shape)", async () => {
    const start = Date.now();
    const result = await runBashCommand({
      cmd: "sleep infinity",
      bin: "bash",
      args: ["-c", "sleep infinity"],
      timeoutMs: 300,
      graceMs: FAST_GRACE,
    });
    const elapsed = Date.now() - start;
    expect(result.timed_out).toBe(true);
    expect(elapsed).toBeLessThan(300 + FAST_GRACE + 1500);
    expect(result.command_fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("kills the whole process group so pipe-holding descendants do not wedge settlement", async () => {
    const start = Date.now();
    const result = await runBashCommand({
      cmd: "sleep infinity | cat",
      bin: "bash",
      args: ["-c", "sleep infinity | cat"],
      timeoutMs: 300,
      graceMs: FAST_GRACE,
    });
    const elapsed = Date.now() - start;
    expect(result.timed_out).toBe(true);
    expect(elapsed).toBeLessThan(300 + FAST_GRACE + 1500);
  });

  it("marks cleanup_incomplete when an out-of-group descendant holds the pipe past grace", async () => {
    if (!setsidAvailable()) return;
    const start = Date.now();
    const result = await runBashCommand({
      cmd: "setsid sleep 30 & sleep infinity",
      bin: "bash",
      args: ["-c", "setsid sleep 30 & sleep infinity"],
      timeoutMs: 300,
      graceMs: FAST_GRACE,
    });
    const elapsed = Date.now() - start;
    expect(result.timed_out).toBe(true);
    expect(result.cleanup_incomplete).toBe(true);
    expect(elapsed).toBeLessThan(300 + FAST_GRACE + 1500);
  }, 10_000);

  it("returns an aborted result without spawning when the signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runBashCommand({
      cmd: "echo nope",
      bin: "bash",
      args: ["-c", "echo nope"],
      signal: controller.signal,
      timeoutMs: 5000,
    });
    expect(result.aborted).toBe(true);
    expect(result.timed_out).toBe(false);
    expect(result.stdout).toBeUndefined();
  });

  it("aborts a running command on signal", async () => {
    const controller = new AbortController();
    const pending = runBashCommand({
      cmd: "sleep infinity",
      bin: "bash",
      args: ["-c", "sleep infinity"],
      signal: controller.signal,
      timeoutMs: 60_000,
      graceMs: FAST_GRACE,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timed_out).toBe(false);
  }, 10_000);

  it("stops appending stdout at the capture cap", async () => {
    const result = await runBashCommand({
      cmd: "yes abtars-flood | head -c 200000",
      bin: "bash",
      args: ["-c", "yes abtars-flood | head -c 200000"],
      timeoutMs: 10_000,
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout?.length).toBe(STDOUT_CAP_CHARS);
  });

  it("stops appending stderr at its smaller cap", async () => {
    const result = await runBashCommand({
      cmd: 'head -c 40000 /dev/zero | tr "\\0" "e" >&2',
      bin: "bash",
      args: ["-c", 'head -c 40000 /dev/zero | tr "\\0" "e" >&2'],
      timeoutMs: 10_000,
    });
    expect(result.exit_code).toBe(0);
    expect(result.stderr?.length).toBe(STDERR_CAP_CHARS);
  });

  it("retains the old maxBuffer termination for output floods", async () => {
    const start = Date.now();
    const result = await runBashCommand({
      cmd: "yes output-flood",
      bin: "bash",
      args: ["-c", "yes output-flood"],
      timeoutMs: 10_000,
      graceMs: FAST_GRACE,
    });
    const elapsed = Date.now() - start;
    expect(result.process_error_code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(result.timed_out).toBe(false);
    expect(result.stdout?.length).toBe(STDOUT_CAP_CHARS);
    expect(elapsed).toBeLessThan(3000);
  });

  it("rejects an invalid timeout configuration", async () => {
    await expect(
      runBashCommand({ cmd: "echo x", bin: "bash", args: ["-c", "echo x"], timeoutMs: 0 }),
    ).rejects.toThrow(/invalid timeoutMs/);
  });

  it("never signals the bridge's own process group on containment", async () => {
    const before = process.kill(process.pid, 0);
    await runBashCommand({
      cmd: "trap '' TERM; sleep infinity",
      bin: "bash",
      args: ["-c", "trap '' TERM; sleep infinity"],
      timeoutMs: 200,
      graceMs: 150,
    });
    expect(process.kill(process.pid, 0)).toBe(before);
  }, 10_000);
});
