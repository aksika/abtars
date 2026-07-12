/**
 * ws-peer-client.test.ts — tests for durable outbox (#1401).
 *
 * Uses WsOutboxStore directly for storage-focused tests and WsPeerClient for
 * lifecycle tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsOutboxStore } from "./ws-outbox-store.js";

const originalHome = process.env["HOME"];
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ws-peer-test-"));
  process.env["HOME"] = tmpDir;
});

afterEach(() => {
  process.env["HOME"] = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("WsOutboxStore", () => {
  it("accepts and persists entries", () => {
    const path = join(tmpDir, "outbox.json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });

    expect(store.length).toBe(0);
    const entry = store.append("delegate", { goal: "hello" });
    expect(store.length).toBe(1);
    expect(store.peek()!.id).toBe(entry.id);

    // Survives reload
    const store2 = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });
    expect(store2.length).toBe(1);
    expect(store2.peek()!.id).toBe(entry.id);
  });

  it("acknowledge removes entry", () => {
    const path = join(tmpDir, "outbox.json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });

    const e1 = store.append("delegate", { goal: "a" });
    store.append("delegate", { goal: "b" });
    expect(store.length).toBe(2);

    store.acknowledge(e1.id);
    expect(store.length).toBe(1);
    expect(store.peek()!.payload).toEqual({ goal: "b" });
  });

  it("rejects unsupported methods", () => {
    const path = join(tmpDir, "outbox.json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });
    expect(() => store.append("unknown", {})).toThrow("Unsupported WSS method");
  });

  it("rejects when full", () => {
    const path = join(tmpDir, "outbox.json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 3,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });
    store.append("delegate", { i: 0 });
    store.append("delegate", { i: 1 });
    store.append("delegate", { i: 2 });
    expect(() => store.append("delegate", { i: 3 })).toThrow("Outbox full");
  });

  it("quarantines corrupt files", () => {
    const path = join(tmpDir, "outbox.json");
    // Write garbage
    require("node:fs").writeFileSync(path, "not json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });
    expect(store.length).toBe(0);
    expect(store.isDegraded).toBe(true);
    // Corrupt file should have been renamed
    const dirFiles = require("node:fs").readdirSync(tmpDir);
    expect(dirFiles.some(f => f.includes(".corrupt"))).toBe(true);
  });

  it("purge clears everything", () => {
    const path = join(tmpDir, "outbox.json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });
    store.append("delegate", { goal: "test" });
    expect(store.length).toBe(1);
    expect(existsSync(path)).toBe(true);

    store.purge();
    expect(store.length).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});
