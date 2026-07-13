/**
 * peer-health.test.ts — #1360 signed health protocol and store tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateKeyPairSync, randomUUID, createPublicKey } from "node:crypto";

import {
  PeerHealthStore,
  CapabilityRegistry,
  signStatusPayload,
  verifyStatusSignature,
  buildSignedStatus,
  getLocalSnapshot,
  resetHealthStore,
} from "./peer-health.js";

// ── Key helpers (inline, no vi.mock dependency) ──────────────────────────────

function deriveVerifyKeyForTest(signingKey: string): string {
  const pub = createPublicKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" });
  return pub.export({ type: "spki", format: "der" }).toString("base64");
}

function makeKey(): { signingKey: string; verifyKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return { signingKey, verifyKey: deriveVerifyKeyForTest(signingKey) };
}

function makeEnvelope(payload: Record<string, unknown>, signingKey: string): { payload: string; signature: string } {
  const payloadStr = JSON.stringify(payload);
  const signature = signStatusPayload(payloadStr, signingKey);
  return { payload: payloadStr, signature };
}

// Must use vi.hoisted since vi.mock factory is hoisted above all imports
const { ALICE, BOB } = vi.hoisted(() => {
  const crypto = require("node:crypto");
  const gks = crypto.generateKeyPairSync("ed25519");
  const aliceSk = gks.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const bobGks = crypto.generateKeyPairSync("ed25519");
  const bobSk = bobGks.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

  function dvk(sk: string): string {
    const pub = crypto.createPublicKey({ key: Buffer.from(sk, "base64"), format: "der", type: "pkcs8" });
    return pub.export({ type: "spki", format: "der" }).toString("base64");
  }

  return {
    ALICE: { signingKey: aliceSk, verifyKey: dvk(aliceSk) },
    BOB: { signingKey: bobSk, verifyKey: dvk(bobSk) },
  };
});

// ── Mock peer-config ─────────────────────────────────────────────────────────

vi.mock("../peer-config.js", () => ({
  loadPeerConfig: () => ({
    self: { name: "kp", signingKey: ALICE.signingKey },
    peers: {
      bob: { verifyKey: BOB.verifyKey, host: "10.0.0.2", port: 8443 },
    },
  }),
  deriveVerifyKey: (sk: string) => {
    const { createPublicKey: cpk } = require("node:crypto");
    const pub = cpk({ key: Buffer.from(sk, "base64"), format: "der", type: "pkcs8" });
    return pub.export({ type: "spki", format: "der" }).toString("base64");
  },
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("signStatusPayload / verifyStatusSignature", () => {
  it("round-trip accepted", () => {
    const payload = JSON.stringify({ version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] });
    const sig = signStatusPayload(payload, BOB.signingKey);
    expect(verifyStatusSignature(payload, sig, BOB.verifyKey)).toBe(true);
  });

  it("wrong key rejected", () => {
    const payload = JSON.stringify({ version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] });
    const sig = signStatusPayload(payload, BOB.signingKey);
    expect(verifyStatusSignature(payload, sig, ALICE.verifyKey)).toBe(false);
  });

  it("tampered payload rejected", () => {
    const payload = JSON.stringify({ version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] });
    const sig = signStatusPayload(payload, BOB.signingKey);
    expect(verifyStatusSignature(payload + "x", sig, BOB.verifyKey)).toBe(false);
  });

  it("empty signature rejected", () => {
    const payload = JSON.stringify({ version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] });
    expect(verifyStatusSignature(payload, "", BOB.verifyKey)).toBe(false);
  });
});

describe("PeerHealthStore — ingestSignedStatus", () => {
  let store: PeerHealthStore;

  beforeEach(() => {
    store = new PeerHealthStore();
  });

  it("accepts valid status", () => {
    const payload = { version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash", "node"] };
    const envelope = makeEnvelope(payload, BOB.signingKey);
    const result = store.ingestSignedStatus("wss", "bob", envelope);
    expect(result.ok).toBe(true);
    expect(store.size).toBe(1);
  });

  it("rejects self status", () => {
    const payload = { version: 1, peer: "kp", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    const envelope = makeEnvelope(payload, ALICE.signingKey);
    const result = store.ingestSignedStatus("wss", "kp", envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("self");
  });

  it("rejects identity mismatch", () => {
    const payload = { version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    const envelope = makeEnvelope(payload, BOB.signingKey);
    const result = store.ingestSignedStatus("wss", "alice", envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("identity_mismatch");
  });

  it("rejects unknown peer", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const unknownSk = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    const payload = { version: 1, peer: "unknown", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    const envelope = makeEnvelope(payload, unknownSk);
    const result = store.ingestSignedStatus("wss", "unknown", envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_peer");
  });

  it("rejects bad signature", () => {
    const payload = { version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    const envelope = { payload: JSON.stringify(payload), signature: "AAAA" };
    const result = store.ingestSignedStatus("wss", "bob", envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });

  it("rejects stale status", () => {
    const payload = { version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000) - 200, epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    const envelope = makeEnvelope(payload, BOB.signingKey);
    const result = store.ingestSignedStatus("wss", "bob", envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale");
  });

  it("rejects future-skewed status", () => {
    const payload = { version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000) + 60, epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    const envelope = makeEnvelope(payload, BOB.signingKey);
    const result = store.ingestSignedStatus("wss", "bob", envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("future");
  });

  it("rejects source replay (same fingerprint)", () => {
    const payload = { version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    const envelope = makeEnvelope(payload, BOB.signingKey);
    const r1 = store.ingestSignedStatus("wss", "bob", envelope);
    expect(r1.ok).toBe(true);
    const r2 = store.ingestSignedStatus("wss", "bob", envelope);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("replay_source");
  });

  it("accepts same snapshot from different sources", () => {
    const payload = { version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    const envelope = makeEnvelope(payload, BOB.signingKey);
    const r1 = store.ingestSignedStatus("wss", "bob", envelope);
    expect(r1.ok).toBe(true);
    const r2 = store.ingestSignedStatus("udp", "bob", envelope);
    expect(r2.ok).toBe(true);
    expect(store.size).toBe(1);
    const record = store.getRecord("bob");
    expect(record?.observations["wss"]).toBeDefined();
    expect(record?.observations["udp"]).toBeDefined();
  });

  it("accepts in-sequence updates within same epoch", () => {
    const epoch = randomUUID();
    const baseTs = Math.floor(Date.now() / 1000);
    const p1 = { version: 1, peer: "bob", sentAt: baseTs, epoch, sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    expect(store.ingestSignedStatus("wss", "bob", makeEnvelope(p1, BOB.signingKey)).ok).toBe(true);

    const p2 = { ...p1, sequence: 2, load: 0.7 };
    expect(store.ingestSignedStatus("wss", "bob", makeEnvelope(p2, BOB.signingKey)).ok).toBe(true);

    const table = store.getPeerTable();
    expect(table[0]?.load).toBe(0.7);
  });

  it("rejects out-of-sequence within same epoch", () => {
    const epoch = randomUUID();
    const baseTs = Math.floor(Date.now() / 1000);
    const p1 = { version: 1, peer: "bob", sentAt: baseTs, epoch, sequence: 2, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    expect(store.ingestSignedStatus("wss", "bob", makeEnvelope(p1, BOB.signingKey)).ok).toBe(true);

    const p2 = { ...p1, sequence: 1 };
    const r = store.ingestSignedStatus("wss", "bob", makeEnvelope(p2, BOB.signingKey));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("out_of_sequence");
  });

  it("accepts new epoch with newer sentAt", () => {
    const baseTs = Math.floor(Date.now() / 1000);
    const p1 = { version: 1, peer: "bob", sentAt: baseTs, epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    expect(store.ingestSignedStatus("wss", "bob", makeEnvelope(p1, BOB.signingKey)).ok).toBe(true);

    const p2 = { ...p1, sentAt: baseTs + 5, epoch: randomUUID(), sequence: 1, load: 0.7 };
    expect(store.ingestSignedStatus("wss", "bob", makeEnvelope(p2, BOB.signingKey)).ok).toBe(true);

    const table = store.getPeerTable();
    expect(table[0]?.load).toBe(0.7);
  });

  it("rejects old epoch after newer epoch accepted", () => {
    const baseTs = Math.floor(Date.now() / 1000);
    const epoch1 = randomUUID();
    const epoch2 = randomUUID();
    const p1 = { version: 1, peer: "bob", sentAt: baseTs, epoch: epoch1, sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    expect(store.ingestSignedStatus("wss", "bob", makeEnvelope(p1, BOB.signingKey)).ok).toBe(true);

    const p2 = { ...p1, sentAt: baseTs + 5, epoch: epoch2, sequence: 1, load: 0.7 };
    expect(store.ingestSignedStatus("wss", "bob", makeEnvelope(p2, BOB.signingKey)).ok).toBe(true);

    // Replay of the exact epoch1 payload (same payload = same fingerprint) → rejected as source replay
    const r = store.ingestSignedStatus("wss", "bob", makeEnvelope(p1, BOB.signingKey));
    expect(r.ok).toBe(false);
  });

  it("rejects oversized payload", () => {
    const bigCaps = new Array(200).fill("x").map((_, i) => `cap${i}`);
    const payload = { version: 1, peer: "bob", sentAt: Math.floor(Date.now() / 1000), epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: bigCaps };
    const envelope = makeEnvelope(payload, BOB.signingKey);
    const result = store.ingestSignedStatus("wss", "bob", envelope);
    expect(result.ok).toBe(false);
  });

  it("rejects malformed JSON", () => {
    const envelope = { payload: "not json", signature: "AAAA" };
    const result = store.ingestSignedStatus("wss", "bob", envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_json");
  });
});

describe("PeerHealthStore — getPeerTable / findCapablePeer", () => {
  let store: PeerHealthStore;

  beforeEach(() => {
    store = new PeerHealthStore();
    const baseTs = Math.floor(Date.now() / 1000);
    const payload = { version: 1, peer: "bob", sentAt: baseTs, epoch: randomUUID(), sequence: 1, load: 0.3, sessions: 2, abtarsVersion: "1.0.0", capabilities: ["bash", "node", "pi-executor"] };
    store.ingestSignedStatus("wss", "bob", makeEnvelope(payload, BOB.signingKey));
  });

  it("returns peer in getPeerTable", () => {
    const table = store.getPeerTable();
    expect(table).toHaveLength(1);
    expect(table[0]!.name).toBe("bob");
    expect(table[0]!.load).toBe(0.3);
    expect(table[0]!.capabilities).toContain("pi-executor");
    expect(table[0]!.alive).toBe(true);
  });

  it("findCapablePeer matches capability", () => {
    const found = store.findCapablePeer(["pi-executor"]);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("bob");
  });

  it("findCapablePeer rejects mismatch", () => {
    const found = store.findCapablePeer(["nonexistent"]);
    expect(found).toBeNull();
  });
});

describe("CapabilityRegistry", () => {
  let reg: CapabilityRegistry;

  beforeEach(() => {
    reg = new CapabilityRegistry();
  });

  it("register and getValues", () => {
    reg.register("host", ["bash", "node"]);
    const values = reg.getValues();
    expect(values).toContain("bash");
    expect(values).toContain("node");
  });

  it("disposer removes capabilities", () => {
    const disposer = reg.register("host", ["bash", "node"]);
    expect(reg.getValues()).toHaveLength(2);
    disposer();
    expect(reg.getValues()).toHaveLength(0);
  });

  it("disposer is generation-bound (replacement invalidates old)", () => {
    const d1 = reg.register("owner", ["v1"]);
    const d2 = reg.register("owner", ["v2"]);
    d1();
    const values = reg.getValues();
    expect(values).toContain("v2");
    expect(values).not.toContain("v1");
    d2();
    expect(reg.getValues()).toHaveLength(0);
  });

  it("unhealthy capabilities excluded", () => {
    reg.register("host", ["bash"]);
    reg.setHealth("host", false);
    expect(reg.getValues()).not.toContain("bash");
  });

  it("recovery after setHealth", () => {
    reg.register("host", ["bash"]);
    reg.setHealth("host", false);
    expect(reg.getValues()).not.toContain("bash");
    reg.setHealth("host", true);
    expect(reg.getValues()).toContain("bash");
  });

  it("deduplicates and sorts", () => {
    reg.register("a", ["z", "a"]);
    reg.register("b", ["m", "z"]);
    const values = reg.getValues();
    expect(values).toEqual(["a", "m", "z"]);
  });

  it("caps at MAX_CAPABILITIES", () => {
    const big = new Array(100).fill("x").map((_, i) => `cap-${i}`);
    reg.register("host", big);
    expect(reg.getValues().length).toBeLessThanOrEqual(64);
  });
});

describe("getLocalSnapshot / buildSignedStatus", () => {
  beforeEach(() => {
    resetHealthStore();
  });

  it("produces valid snapshot", () => {
    const snapshot = getLocalSnapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.peer).toBe("kp");
    expect(typeof snapshot.sentAt).toBe("number");
    expect(typeof snapshot.epoch).toBe("string");
    expect(snapshot.sequence).toBeGreaterThan(0);
    expect(typeof snapshot.load).toBe("number");
    expect(snapshot.load).toBeGreaterThanOrEqual(0);
    expect(snapshot.sessions).toBeGreaterThanOrEqual(0);
  });

  it("buildSignedStatus produces verifiable envelope", () => {
    const signed = buildSignedStatus(ALICE.signingKey);
    expect(typeof signed.payload).toBe("string");
    expect(typeof signed.signature).toBe("string");

    const parsed = JSON.parse(signed.payload);
    expect(parsed.peer).toBe("kp");

    expect(verifyStatusSignature(signed.payload, signed.signature, ALICE.verifyKey)).toBe(true);
  });

  it("sequence increments", () => {
    resetHealthStore();
    const s1 = getLocalSnapshot();
    const s2 = getLocalSnapshot();
    expect(s2.sequence).toBe(s1.sequence + 1);
  });
});

describe("PeerHealthStore — source merge rules", () => {
  let store: PeerHealthStore;

  beforeEach(() => {
    store = new PeerHealthStore();
  });

  it("identical snapshot from both sources creates two observations", () => {
    const baseTs = Math.floor(Date.now() / 1000);
    const epoch = randomUUID();
    const payload = { version: 1, peer: "bob", sentAt: baseTs, epoch, sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    const envelope = makeEnvelope(payload, BOB.signingKey);
    expect(store.ingestSignedStatus("udp", "bob", envelope).ok).toBe(true);
    expect(store.ingestSignedStatus("wss", "bob", envelope).ok).toBe(true);

    const record = store.getRecord("bob");
    expect(record?.observations["udp"]).toBeDefined();
    expect(record?.observations["wss"]).toBeDefined();
  });

  it("newer logical snapshot via WSS takes precedence over older UDP", () => {
    const baseTs = Math.floor(Date.now() / 1000);
    const epoch = randomUUID();

    const oldPayload = { version: 1, peer: "bob", sentAt: baseTs, epoch, sequence: 1, load: 0.3, sessions: 2, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    expect(store.ingestSignedStatus("udp", "bob", makeEnvelope(oldPayload, BOB.signingKey)).ok).toBe(true);

    const newPayload = { ...oldPayload, sequence: 2, load: 0.7 };
    expect(store.ingestSignedStatus("wss", "bob", makeEnvelope(newPayload, BOB.signingKey)).ok).toBe(true);

    const table = store.getPeerTable();
    expect(table[0]!.load).toBe(0.7);
  });

  it("reports source and age in routing record", () => {
    const baseTs = Math.floor(Date.now() / 1000);
    const payload = { version: 1, peer: "bob", sentAt: baseTs, epoch: randomUUID(), sequence: 1, load: 0.5, sessions: 3, abtarsVersion: "1.0.0", capabilities: ["bash"] };
    expect(store.ingestSignedStatus("wss", "bob", makeEnvelope(payload, BOB.signingKey)).ok).toBe(true);

    const table = store.getPeerTable();
    expect(table[0]!.source).toBe("wss");
    expect(table[0]!.sourceAge).toBeGreaterThanOrEqual(0);
  });
});
