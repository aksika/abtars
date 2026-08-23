/**
 * Focused harness self-tests: process-registry cleanup invariants and
 * PID-reuse refusal (#1712 Task 1). These spawn only short-lived helpers —
 * never the watchdog.
 */
import { describe, expect, it } from "vitest";
import { ProcessRegistry, PidReuseError, UnknownProcessError } from "./process-registry.ts";
import { processStartIdentityOf, procGone } from "./proc-observers.ts";

async function waitGone(_registry: ProcessRegistry, pid: number): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (procGone(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return procGone(pid);
}

describe("ProcessRegistry", () => {
  it("cleans up after an assertion-style failure leaves processes registered", async () => {
    const registry = new ProcessRegistry();
    const pid = await registry.spawn({ cmd: "sleep", args: ["30"], role: "helper", home: "/tmp" });
    expect(registry.size()).toBe(1);
    // Simulate a scenario failure followed by finally-cleanup.
    await registry.cleanupAll("simulated assertion failure");
    expect(await waitGone(registry, pid)).toBe(true);
    registry.assertEmpty();
  }, 20000);

  it("refuses to signal a PID whose start identity changed (reuse guard)", async () => {
    const registry = new ProcessRegistry();
    const sleeper = await registry.spawn({ cmd: "sleep", args: ["30"], role: "helper", home: "/tmp" });
    const realIdentity = processStartIdentityOf(sleeper);
    // Forge registration as if we had recorded a DIFFERENT identity for this
    // live PID — exactly what a recycled PID looks like.
    (registry as unknown as { procs: Map<number, { startIdentity: string }> }).procs.get(sleeper)!.startIdentity =
      `${sleeper}:999999`;
    expect(() => registry.signal(sleeper, "SIGTERM")).toThrow(PidReuseError);
    // Restore and verify normal signalling works on valid identities.
    (registry as unknown as { procs: Map<number, { startIdentity: string }> }).procs.get(sleeper)!.startIdentity = realIdentity;
    registry.signalPidOnly(sleeper, "SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    await registry.cleanupAll("done");
  }, 20000);

  it("refuses to signal unregistered PIDs", () => {
    const registry = new ProcessRegistry();
    expect(() => registry.signal(process.pid, "SIGTERM")).toThrow(UnknownProcessError);
  });

  it("escalates to SIGKILL when a helper ignores SIGTERM", async () => {
    const registry = new ProcessRegistry();
    const pid = await registry.spawn({
      cmd: process.execPath,
      args: ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      role: "helper",
      home: "/tmp",
    });
    await new Promise((r) => setTimeout(r, 400));
    await registry.cleanupAll("term-ignorer");
    expect(await waitGone(registry, pid)).toBe(true);
  }, 20000);

  it("reaps exited registrations so assertEmpty reflects only leaks", async () => {
    const registry = new ProcessRegistry();
    await registry.spawn({ cmd: "true", args: [], role: "helper", home: "/tmp" });
    await new Promise((r) => setTimeout(r, 400));
    registry.reapExited();
    registry.assertEmpty();
  }, 20000);
});
