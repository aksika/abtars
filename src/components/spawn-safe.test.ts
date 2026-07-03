/**
 * Unit tests for spawnDetached (#1281).
 * Verifies that a missing binary (ENOENT) does not throw or crash the process.
 */

import { describe, it, expect, vi } from "vitest";
import { spawnDetached } from "./spawn-safe.js";

describe("spawnDetached", () => {
  it("does not throw when binary does not exist", () => {
    // Must not throw synchronously
    expect(() => {
      spawnDetached("nonexistent-binary-xyz-abc-1281", [], "test");
    }).not.toThrow();
  });

  it("does not emit an unhandled error event when binary does not exist", async () => {
    // The error event fires asynchronously after the call returns.
    // We verify no unhandled rejection or uncaught exception is emitted by
    // waiting a tick and checking the process is still alive.
    let threw = false;
    const origListeners = process.listeners("uncaughtException");
    const guard = () => { threw = true; };
    process.once("uncaughtException", guard);

    spawnDetached("nonexistent-binary-xyz-abc-1281", [], "test");

    // Allow error event to fire
    await new Promise<void>(r => setTimeout(r, 50));

    // Remove our guard if it wasn't triggered (clean up)
    process.removeListener("uncaughtException", guard);

    expect(threw, "spawnDetached ENOENT must not reach uncaughtException").toBe(false);
    // Sanity: original listeners were not removed
    expect(process.listenerCount("uncaughtException")).toBeGreaterThanOrEqual(origListeners.length);
  });
});
