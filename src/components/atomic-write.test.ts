/**
 * atomic-write.test.ts — #1632.
 *
 * Protects three behaviors that an outage and a security comment depend on:
 *  1. a temp file orphaned by a killed process must not brick the path forever
 *     (Molty 2026-08-10: an orphan bridge.lock.tmp killed lock creation and
 *     every per-tick heartbeat write, so the watchdog declared a live bridge
 *     dead and respawned it in a loop);
 *  2. a FRESH temp file belongs to a live writer — bridge.lock has two writer
 *     processes — and must never be deleted to make our own write succeed;
 *  3. a symlink planted at the predictable temp path must never be written
 *     through, stale or fresh. This is the invariant the `wx` flag exists for.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, symlinkSync, statSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { atomicWriteSync } from "./atomic-write.js";

const STALE_SECONDS = 120; // comfortably past ORPHAN_TMP_STALE_MS (30s)

describe("atomicWriteSync", () => {
  let dir: string;
  let target: string;
  let tmpPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "abtars-atomic-"));
    target = join(dir, "bridge.lock");
    tmpPath = target + ".tmp";
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Backdate a path's mtime so the orphan discriminator sees it as stale. */
  function backdate(path: string, seconds = STALE_SECONDS): void {
    const past = new Date(Date.now() - seconds * 1000);
    utimesSync(path, past, past);
  }

  it("writes content with owner-only permissions", () => {
    atomicWriteSync(target, '{"pid":1}');

    expect(readFileSync(target, "utf-8")).toBe('{"pid":1}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("recovers from a stale orphan temp file instead of failing forever", () => {
    // Exactly the Molty state: a killed write left its temp file behind.
    writeFileSync(tmpPath, "half-written garbage from a killed process");
    backdate(tmpPath);

    atomicWriteSync(target, '{"pid":31071}');

    expect(readFileSync(target, "utf-8")).toBe('{"pid":31071}');
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("keeps succeeding on every later write once an orphan has been cleared", () => {
    writeFileSync(tmpPath, "orphan");
    backdate(tmpPath);

    atomicWriteSync(target, "first");
    atomicWriteSync(target, "second");
    atomicWriteSync(target, "third");

    // The heartbeat path calls this every tick; one recovery must not be a
    // one-shot that re-bricks on the next write.
    expect(readFileSync(target, "utf-8")).toBe("third");
  });

  it("refuses to delete a FRESH temp file — another process may be mid-write", () => {
    // bridge.lock is written by both the bridge and the watchdog. Deleting a
    // live writer's temp file would make its rename fail with ENOENT.
    writeFileSync(tmpPath, "in-flight write by another process");
    const before = readFileSync(tmpPath, "utf-8");

    expect(() => atomicWriteSync(target, "should not win")).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );

    expect(existsSync(tmpPath)).toBe(true);
    expect(readFileSync(tmpPath, "utf-8")).toBe(before);
    expect(existsSync(target)).toBe(false);
  });

  it("never writes through a stale symlink at the temp path", () => {
    const secret = join(dir, "victim-secret");
    writeFileSync(secret, "ORIGINAL SECRET");
    symlinkSync(secret, tmpPath);
    backdate(tmpPath); // lstat/utimes act on the link itself, not the target

    // Either the symlink is removed and a real file is created, or the call
    // throws. What must never happen is the payload landing in the target.
    try {
      atomicWriteSync(target, "ATTACKER PAYLOAD");
    } catch { /* acceptable outcome — the assertion below is the contract */ }

    expect(readFileSync(secret, "utf-8")).toBe("ORIGINAL SECRET");
  });

  it("never writes through a fresh symlink at the temp path", () => {
    const secret = join(dir, "victim-secret");
    writeFileSync(secret, "ORIGINAL SECRET");
    symlinkSync(secret, tmpPath);

    expect(() => atomicWriteSync(target, "ATTACKER PAYLOAD")).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );

    expect(readFileSync(secret, "utf-8")).toBe("ORIGINAL SECRET");
    expect(lstatSync(tmpPath).isSymbolicLink()).toBe(true);
  });

  it("propagates a non-EEXIST open failure unchanged", () => {
    // A missing parent directory yields ENOENT from the first openSync; the
    // orphan branch must not swallow or reinterpret it.
    const unreachable = join(dir, "no-such-dir", "file");

    expect(() => atomicWriteSync(unreachable, "x")).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("leaves no temp file behind when the write itself fails", () => {
    // A directory at the target path makes renameSync fail after the temp file
    // was successfully created — the pre-existing cleanup path must still run.
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(target);

    expect(() => atomicWriteSync(target, "x")).toThrow();
    expect(existsSync(tmpPath)).toBe(false);
  });
});
