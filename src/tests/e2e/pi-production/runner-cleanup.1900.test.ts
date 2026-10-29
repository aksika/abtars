/**
 * runner-cleanup.1900.test.ts — #1900 R3 focused regression.
 *
 * Exercises the real runner ownership/finalization path with a short injected
 * deadline: a real held provider socket plus a small owned child must both be
 * stopped by cleanupLane within seconds (not the child's 30s sleep), and
 * per-lane provider evidence must be preserved.
 *
 * Expensive fixture startup (owner daemon, built bridge, TUI) is substituted
 * with nulls; the held socket + owned child are real.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedProvider } from "./scripted-provider.js";
import { SpawnedChild } from "./child-process.js";
import { ResultWriter } from "./result-writer.js";
import { cleanupLane } from "./runner.js";

describe("#1900 lane cleanup owns held sockets and child processes", () => {
  it("stops a held provider connection and an owned child within a short deadline", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pi-1900-cleanup-"));
    const logDir = join(repoRoot, "logs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(logDir, { recursive: true });
    const writer = new ResultWriter({ repoRoot, runId: "run-1900-cleanup" });

    const provider = new ScriptedProvider();
    await provider.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.enqueue({
      candidate: "fixture-model-b",
      expectation: undefined,
      action: { kind: "hold", release: gate },
    });
    // Open a real held generation (headers received, body pending).
    const bodyPromise = fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-model-b", messages: [{ role: "user", content: "held" }] }),
    }).then((res) => res.text().then(() => undefined, () => undefined), () => undefined);
    const waitDeadline = Date.now() + 5_000;
    while (provider.requestCount === 0 && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(provider.requestCount).toBe(1);

    // Small owned child that would sleep 30s if left alone.
    const child = new SpawnedChild({
      execPath: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      cwd: repoRoot,
      env: process.env,
      logDir,
      name: "owned-child",
    });
    expect(child.exited).toBe(false);

    const started = Date.now();
    await Promise.race([
      cleanupLane({ provider, owner: null, bridge: child, tui: null }, writer, "local-unix"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup did not settle within 10s")), 10_000)),
    ]);
    const elapsed = Date.now() - started;
    // Cleanup must have stopped the 30s child in seconds, not after its sleep.
    expect(elapsed).toBeLessThan(10_000);
    expect(child.exited).toBe(true);
    // Held body settles once the provider is gone.
    await Promise.race([
      bodyPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("held body did not settle")), 5_000)),
    ]);
    // Per-lane evidence preserved without overwriting.
    const summariesPath = join(repoRoot, "test-results/pi-production-e2e/run-1900-cleanup/local-unix-provider-summaries.json");
    expect(existsSync(summariesPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(summariesPath, "utf-8")) as { summaries: Array<{ action: string }> };
    expect(parsed.summaries.some((s) => s.action === "hold")).toBe(true);

    release();
    rmSync(repoRoot, { recursive: true, force: true });
  });
});
