/**
 * ws-peer-client.test.ts — tests for durable outbound queue (#1293 Task 7).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set up a fake HOME so paths resolve to a temp dir
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

// The queue is implemented in WsPeerClient but we can exercise it via the class interface.
// We need a mock PeerEntry with a valid signingKey to instantiate WsPeerClient.
// Since network calls would fail in tests, we only test the queue logic.

describe("WsPeerClient durable queue", () => {
  it("enqueues messages when disconnected and reports queued status", async () => {
    // Need a valid signingKey — generate one
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ed25519");
    const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

    // Set up minimal peers.json
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(tmpDir, ".abtars", "config"), { recursive: true });
    const { deriveVerifyKey } = await import("../../components/peer-config.js");
    const verifyKey = deriveVerifyKey(signingKey);
    const peersData = {
      self: { name: "test", signingKey, tribeToken: Buffer.alloc(32).toString("base64") },
      peers: {},
    };
    writeFileSync(join(tmpDir, ".abtars", "config", "peers.json"), JSON.stringify(peersData, null, 2));

    const { clearPeerConfigCache } = await import("../../components/peer-config.js");
    clearPeerConfigCache();

    const { WsPeerClient } = await import("./ws-peer-client.js");

    const client = new WsPeerClient("testpeer", {
      host: "127.0.0.1",
      port: 9999,
      verifyKey,
    });

    // Send while disconnected (ws is null) — should enqueue
    const result = await client.send("callback", { task_id: 1, status: "done" });
    expect((result as { queued: boolean }).queued).toBe(true);

    // Queue should have one entry persisted to disk
    const queuePath = join(tmpDir, ".abtars", "ws-queue-testpeer.json");
    expect(existsSync(queuePath)).toBe(true);

    client.destroy();
    // After destroy, queue file should be removed
    expect(existsSync(queuePath)).toBe(false);
  });

  it("drops oldest when queue exceeds 200 entries", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ed25519");
    const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(tmpDir, ".abtars", "config"), { recursive: true });
    const { deriveVerifyKey } = await import("../../components/peer-config.js");
    const verifyKey = deriveVerifyKey(signingKey);
    const peersData = {
      self: { name: "test", signingKey, tribeToken: Buffer.alloc(32).toString("base64") },
      peers: {},
    };
    writeFileSync(join(tmpDir, ".abtars", "config", "peers.json"), JSON.stringify(peersData, null, 2));

    const { clearPeerConfigCache } = await import("../../components/peer-config.js");
    clearPeerConfigCache();

    const { WsPeerClient } = await import("./ws-peer-client.js");

    const client = new WsPeerClient("testpeer2", {
      host: "127.0.0.1",
      port: 9999,
      verifyKey,
    });

    // Enqueue 201 messages
    for (let i = 0; i < 201; i++) {
      await client.send("test", { i });
    }

    // Access internal queue via any cast
    const queue = (client as any)._queue as Array<{ payload: { i: number } }>;
    expect(queue.length).toBe(200); // capped at 200
    // First message (i=0) was dropped, queue starts at i=1
    expect(queue[0]!.payload.i).toBe(1);

    client.destroy();
  });
});
