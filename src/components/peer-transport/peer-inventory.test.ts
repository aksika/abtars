import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createPublicKey } from "node:crypto";

function deriveVerifyKeyForTest(signingKey: string): string {
  const pub = createPublicKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" });
  return pub.export({ type: "spki", format: "der" }).toString("base64");
}

function makeKey(): { signingKey: string; verifyKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return { signingKey, verifyKey: deriveVerifyKeyForTest(signingKey) };
}

describe("peer-inventory", () => {
  it("buildSignedInventory → verifyAndStoreInventory round-trips", async () => {
    const { buildSignedInventory, verifyAndStoreInventory, getPeerInventory, clearInventory } = await import("./peer-inventory.js");
    const key = makeKey();
    const inv = buildSignedInventory(key.signingKey, "kp", "1.0.0", ["docker", "gpu"], ["wss", "https"]);

    const ok = verifyAndStoreInventory("kp", inv, key.verifyKey);
    expect(ok).toBe(true);

    const stored = getPeerInventory("kp");
    expect(stored).toBeDefined();
    expect(stored?.capabilities).toContain("docker");
    expect(stored?.peer).toBe("kp");

    clearInventory("kp");
  });

  it("rejects tampered payload", async () => {
    const { buildSignedInventory, verifyAndStoreInventory, clearInventory } = await import("./peer-inventory.js");
    const key = makeKey();
    const inv = buildSignedInventory(key.signingKey, "kp", "1.0.0", ["docker"], ["wss"]);
    inv.payload = JSON.stringify({ ...JSON.parse(inv.payload), goal: "tampered" });

    const ok = verifyAndStoreInventory("kp", inv, key.verifyKey);
    expect(ok).toBe(false);
    clearInventory("kp");
  });

  it("rejects tampered signature", async () => {
    const { buildSignedInventory, verifyAndStoreInventory, clearInventory } = await import("./peer-inventory.js");
    const key = makeKey();
    const inv = buildSignedInventory(key.signingKey, "kp", "1.0.0", ["docker"], ["wss"]);
    inv.signature = "bad" + inv.signature.slice(4);

    const ok = verifyAndStoreInventory("kp", inv, key.verifyKey);
    expect(ok).toBe(false);
    clearInventory("kp");
  });

  it("rejects peer name mismatch", async () => {
    const { buildSignedInventory, verifyAndStoreInventory, clearInventory } = await import("./peer-inventory.js");
    const key = makeKey();
    const inv = buildSignedInventory(key.signingKey, "kp", "1.0.0", ["docker"], ["wss"]);

    const ok = verifyAndStoreInventory("molty", inv, key.verifyKey);
    expect(ok).toBe(false);
    clearInventory("kp");
  });

  it("rejects over-size payload", async () => {
    const { verifyAndStoreInventory } = await import("./peer-inventory.js");
    const key = makeKey();
    const envelope = {
      payload: "x".repeat(100_001),
      signature: "sig",
      peer_id: "kp", peer_ts: "1234", peer_nonce: "n1",
    };
    const ok = verifyAndStoreInventory("kp", envelope as any, key.verifyKey);
    expect(ok).toBe(false);
  });

  it("hasAllCapabilities intersection logic", async () => {
    const { buildSignedInventory, verifyAndStoreInventory, hasAllCapabilities, clearInventory } = await import("./peer-inventory.js");
    const key = makeKey();
    const inv = buildSignedInventory(key.signingKey, "kp", "1.0.0", ["docker", "gpu"], ["wss"]);
    verifyAndStoreInventory("kp", inv, key.verifyKey);

    expect(hasAllCapabilities("kp", ["docker", "gpu"])).toBe(true);
    expect(hasAllCapabilities("kp", ["docker", "nonexistent"])).toBe(false);
    expect(hasAllCapabilities("kp", [])).toBe(true);
    expect(hasAllCapabilities("nonexistent", ["docker"])).toBe(false);
    clearInventory("kp");
  });

  it("missing inventory excludes from hasAllCapabilities", async () => {
    const { hasAllCapabilities } = await import("./peer-inventory.js");
    expect(hasAllCapabilities("unknown", ["docker"])).toBe(false);
  });

  it("inventory carries no load/session/queue fields", async () => {
    const { buildSignedInventory, clearInventory } = await import("./peer-inventory.js");
    const key = makeKey();
    const inv = buildSignedInventory(key.signingKey, "kp", "1.0.0", ["docker"], ["wss"]);
    const payload = JSON.parse(inv.payload);
    expect(payload.load).toBeUndefined();
    expect(payload.sessions).toBeUndefined();
    expect(payload.queue_depth).toBeUndefined();
    expect(payload.willingness).toBeUndefined();
    clearInventory("kp");
  });
});
