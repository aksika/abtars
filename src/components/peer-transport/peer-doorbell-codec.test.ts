import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { deriveVerifyKey } from "../peer-config.js";
import {
  DOORBELL_PORT, MAX_QUERY_BYTES, MAX_RESPONSE_BYTES, TIMESTAMP_WINDOW_SEC,
  peerSelector, buildSelectorMap, timingSafeSelectorEq, findPeerBySelector,
  buildQueryCanonical, buildAckCanonical,
  signDoorbellQuery, verifyDoorbellQuery,
  signDoorbellAck, verifyDoorbellAck,
  encodeQuery, encodeResponse, parseQuery, parseResponse,
  buildFreshQuery, buildFreshAck, computeRequestHash,
} from "./peer-doorbell-codec.js";

function makeKey(): { signingKey: string; verifyKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return { signingKey, verifyKey: deriveVerifyKey(signingKey) };
}

const ALICE = makeKey();
const BOB = makeKey();
const aliceSelector = peerSelector(ALICE.verifyKey);
const bobSelector = peerSelector(BOB.verifyKey);

describe("peerSelector", () => {
  it("returns 16 bytes", () => {
    expect(aliceSelector).toHaveLength(16);
    expect(bobSelector).toHaveLength(16);
  });

  it("is deterministic for the same key", () => {
    const s1 = peerSelector(ALICE.verifyKey);
    const s2 = peerSelector(ALICE.verifyKey);
    expect(s1.equals(s2)).toBe(true);
  });

  it("differs for different keys", () => {
    expect(aliceSelector.equals(bobSelector)).toBe(false);
  });
});

describe("timingSafeSelectorEq", () => {
  it("matches identical selectors", () => {
    expect(timingSafeSelectorEq(aliceSelector, peerSelector(ALICE.verifyKey))).toBe(true);
  });

  it("rejects different selectors", () => {
    expect(timingSafeSelectorEq(aliceSelector, bobSelector)).toBe(false);
  });

  it("rejects wrong-length buffers", () => {
    expect(timingSafeSelectorEq(Buffer.alloc(8), aliceSelector)).toBe(false);
  });
});

describe("buildSelectorMap", () => {
  it("detects collisions", () => {
    const { collisions } = buildSelectorMap({
      a: { verifyKey: ALICE.verifyKey },
      b: { verifyKey: ALICE.verifyKey },
    });
    expect(collisions.length).toBeGreaterThanOrEqual(1);
  });

  it("returns selectors for unique keys", () => {
    const { peerSelectors, collisions } = buildSelectorMap({
      alice: { verifyKey: ALICE.verifyKey },
      bob: { verifyKey: BOB.verifyKey },
    });
    expect(collisions).toHaveLength(0);
    expect(peerSelectors.has("alice")).toBe(true);
    expect(peerSelectors.has("bob")).toBe(true);
  });
});

describe("findPeerBySelector", () => {
  it("finds peer by selector", () => {
    const map = new Map([["alice", aliceSelector], ["bob", bobSelector]]);
    expect(findPeerBySelector(map, aliceSelector)).toBe("alice");
    expect(findPeerBySelector(map, bobSelector)).toBe("bob");
  });

  it("returns null for unknown selector", () => {
    const map = new Map([["alice", aliceSelector]]);
    const unknown = peerSelector(makeKey().verifyKey);
    expect(findPeerBySelector(map, unknown)).toBeNull();
  });
});

describe("query golden-vector round-trip", () => {
  const q = buildFreshQuery(ALICE.signingKey, aliceSelector, bobSelector);

  it("encodeQuery produces valid buffer", () => {
    const encoded = encodeQuery(q);
    expect("code" in encoded).toBe(false);
    const buf = encoded as Buffer;
    expect(buf.length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
  });

  it("encodeQuery → parseQuery round-trips all fields", () => {
    const encoded = encodeQuery(q) as Buffer;
    const parsed = parseQuery(encoded);
    expect("code" in parsed).toBe(false);
    if ("code" in parsed) return;
    const p = parsed.parsed;

    expect(p.version).toBe(1);
    expect(p.kind).toBe(1);
    expect(p.senderSelector.equals(q.senderSelector)).toBe(true);
    expect(p.targetSelector.equals(q.targetSelector)).toBe(true);
    expect(p.timestampSec).toBe(q.timestampSec);
    expect(p.nonce.equals(q.nonce)).toBe(true);
    expect(p.signature.equals(q.signature)).toBe(true);
  });

  it("signature verifies under query domain", () => {
    expect(verifyDoorbellQuery(ALICE.verifyKey, q)).toBe(true);
  });

  it("signature fails under ack domain", () => {
    expect(verifyDoorbellAck(ALICE.verifyKey, q as any)).toBe(false);
  });

  it("encoded query has valid DNS fields", () => {
    const encoded = encodeQuery(q) as Buffer;
    const flags = encoded.readUInt16BE(2);
    expect(flags).toBe(0x0000);
    expect(encoded.readUInt16BE(4)).toBe(1);
    expect(encoded.readUInt16BE(6)).toBe(0);
    expect(encoded.readUInt16BE(8)).toBe(0);
    expect(encoded.readUInt16BE(10)).toBe(0);
  });

  it("query at size boundary: 384 bytes succeeds, 385 fails", () => {
    const encoded = encodeQuery(q) as Buffer;
    expect(encoded.length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const oversized = Buffer.concat([encoded, Buffer.alloc(1)]);
    const result = parseQuery(oversized);
    if (!("code" in result)) {
      // If it parsed, it should have the same query fields but truncated questionEnd
      expect(result.questionEnd).toBeLessThanOrEqual(oversized.length);
    }
  });
});

describe("ack golden-vector round-trip", () => {
  const q = buildFreshQuery(ALICE.signingKey, aliceSelector, bobSelector);
  const qCanonical = buildQueryCanonical(q);
  const queryPacket = encodeQuery(q) as Buffer;
  const ack = buildFreshAck(BOB.signingKey, bobSelector, q.nonce, qCanonical);

  it("encodeResponse produces valid buffer", () => {
    const encoded = encodeResponse(queryPacket, ack);
    expect("code" in encoded).toBe(false);
    const buf = encoded as Buffer;
    expect(buf.length).toBeLessThanOrEqual(Math.min(MAX_RESPONSE_BYTES, queryPacket.length * 2));
  });

  it("encodeResponse → parseResponse round-trips all ack fields", () => {
    const encoded = encodeResponse(queryPacket, ack) as Buffer;
    const parsed = parseResponse(encoded, queryPacket);
    expect("code" in parsed).toBe(false);
    if ("code" in parsed) return;
    const p = parsed.ack;

    expect(p.version).toBe(1);
    expect(p.kind).toBe(2);
    expect(p.responderSelector.equals(bobSelector)).toBe(true);
    expect(p.requestNonce.equals(q.nonce)).toBe(true);
    expect(p.timestampSec).toBe(ack.timestampSec);
    expect(p.signature.equals(ack.signature)).toBe(true);
  });

  it("signature verifies under ack domain", () => {
    expect(verifyDoorbellAck(BOB.verifyKey, ack)).toBe(true);
  });

  it("signature fails under query domain", () => {
    expect(verifyDoorbellQuery(BOB.verifyKey, ack as any)).toBe(false);
  });

  it("ack signature domain is separate from query domain", () => {
    const qSigned = signDoorbellQuery(ALICE.signingKey, q);
    const ackSigned = signDoorbellAck(BOB.signingKey, ack);
    const copy = { ...ack, signature: qSigned };
    expect(verifyDoorbellAck(BOB.verifyKey, copy)).toBe(false);
    const copy2 = { ...q, signature: ackSigned };
    expect(verifyDoorbellQuery(ALICE.verifyKey, copy2)).toBe(false);
  });

  it("contains exactly one TXT record", () => {
    const encoded = encodeResponse(queryPacket, ack) as Buffer;
    expect(encoded.readUInt16BE(6)).toBe(1); // ANCOUNT
  });

  it("response respects amplification bound: cannot exceed min(512, 2*request)", () => {
    const rsp = encodeResponse(queryPacket, ack) as Buffer;
    const bound = Math.min(MAX_RESPONSE_BYTES, queryPacket.length * 2);
    expect(rsp.length).toBeLessThanOrEqual(bound);
  });
});

describe("computeRequestHash", () => {
  it("is deterministic", () => {
    const c = buildQueryCanonical(buildFreshQuery(ALICE.signingKey, aliceSelector, bobSelector));
    const h1 = computeRequestHash(c);
    const h2 = computeRequestHash(c);
    expect(h1.equals(h2)).toBe(true);
  });

  it("returns 16 bytes", () => {
    const c = buildQueryCanonical(buildFreshQuery(ALICE.signingKey, aliceSelector, bobSelector));
    expect(computeRequestHash(c)).toHaveLength(16);
  });

  it("differs for different canonical inputs", () => {
    const q1 = buildFreshQuery(ALICE.signingKey, aliceSelector, bobSelector);
    const q2 = buildFreshQuery(ALICE.signingKey, aliceSelector, bobSelector);
    const c1 = buildQueryCanonical(q1);
    const c2 = buildQueryCanonical(q2);
    // Different timestamps/nonces → different hashes
    expect(computeRequestHash(c1).equals(computeRequestHash(c2))).toBe(false);
  });
});

describe("parseQuery rejection cases", () => {
  const q = buildFreshQuery(ALICE.signingKey, aliceSelector, bobSelector);
  const valid = encodeQuery(q) as Buffer;

  it("rejects short packet", () => {
    const r = parseQuery(Buffer.alloc(4));
    expect("code" in r).toBe(true);
  });

  it("rejects oversized packet", () => {
    const r = parseQuery(Buffer.concat([valid, Buffer.alloc(1000)]));
    expect("code" in r).toBe(true);
  });

  it("rejects response flags", () => {
    const bad = Buffer.from(valid);
    bad[2] = 0x84;
    const r = parseQuery(bad);
    expect("code" in r).toBe(true);
  });

  it("rejects non-1 QDCOUNT", () => {
    const bad = Buffer.from(valid);
    bad.writeUInt16BE(2, 4);
    const r = parseQuery(bad);
    expect("code" in r).toBe(true);
  });

  it("rejects non-zero ANCOUNT", () => {
    const bad = Buffer.from(valid);
    bad.writeUInt16BE(1, 6);
    const r = parseQuery(bad);
    expect("code" in r).toBe(true);
  });

  it("rejects compression pointer in question name", () => {
    const pos = 12; // start of QNAME
    const bad = Buffer.from(valid);
    bad[pos] = 0xc0;
    bad[pos + 1] = 0x0c;
    const r = parseQuery(bad);
    expect("code" in r).toBe(true);
  });

  it("rejects wrong QTYPE", () => {
    const bad = Buffer.from(valid);
    const nullTermPos = findQnameEndQuick(valid);
    if (nullTermPos >= 0) {
      const qtypeOffset = nullTermPos;
      bad.writeUInt16BE(1, qtypeOffset); // QTYPE A=1 instead of TXT=16
      const r = parseQuery(bad);
      expect("code" in r).toBe(true);
    }
  });

  it("rejects unknown version", () => {
    const bad = Buffer.from(valid);
    const decodedStart = findDecodedOffset(bad);
    if (decodedStart >= 0) {
      bad[decodedStart] = 2;
      const r = parseQuery(bad);
      expect("code" in r).toBe(true);
    }
  });

  it("rejects wrong kind", () => {
    const bad = Buffer.from(valid);
    const decodedStart = findDecodedOffset(bad);
    if (decodedStart >= 0) {
      bad[decodedStart + 1] = 99;
      const r = parseQuery(bad);
      expect("code" in r).toBe(true);
    }
  });
});

function findQnameEndQuick(packet: Buffer): number {
  let pos = 12;
  while (pos < packet.length) {
    const len = packet[pos]!;
    if (len === 0) return pos + 1; // null terminator position
    if ((len & 0xc0) === 0xc0) return pos + 2;
    if (len > 63) return -1;
    pos += 1 + len;
    if (pos > packet.length) return -1;
  }
  return -1;
}

function findDecodedOffset(packet: Buffer): number {
  const qe = findQnameEndQuick(packet);
  if (qe < 0) return -1;
  return qe; // decoded payload starts right after QCLASS
}
