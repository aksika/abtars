/**
 * peer-auth.test.ts — unit tests for peer-auth crypto core (#1293).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  signRequest,
  verifyRequest,
  signWsRequest,
  verifyWsRequest,
  macTribe,
  signEnroll,
  verifyEnroll,
  signAck,
  verifyAck,
  generateTlsCert,
  verifyServerCert,
  isNonceSeen,
  recordNonce,
} from "./peer-auth.js";
import { deriveVerifyKey } from "../peer-config.js";

// ── Key helpers ────────────────────────────────────────────────────────────────

function makeKey(): { signingKey: string; verifyKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const verifyKey = deriveVerifyKey(signingKey);
  return { signingKey, verifyKey };
}

function makeTribeToken(): string {
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  return randomBytes(32).toString("base64");
}

// ── signRequest / verifyRequest ───────────────────────────────────────────────

describe("signRequest / verifyRequest", () => {
  it("round-trip: valid sig accepted", () => {
    const { signingKey, verifyKey } = makeKey();
    const headers = signRequest("POST", "/v1/tasks", '{"goal":"test"}', signingKey, "KP");
    const result = verifyRequest(headers, "POST", "/v1/tasks", '{"goal":"test"}', verifyKey);
    expect(result.ok).toBe(true);
  });

  it("wrong key rejected", () => {
    const { signingKey } = makeKey();
    const { verifyKey: wrongVerifyKey } = makeKey();
    const headers = signRequest("POST", "/v1/tasks", '{"goal":"test"}', signingKey, "KP");
    const result = verifyRequest(headers, "POST", "/v1/tasks", '{"goal":"test"}', wrongVerifyKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_sig");
  });

  it("stale ts rejected (ts > 30s ago)", () => {
    const { signingKey, verifyKey } = makeKey();
    const headers = signRequest("GET", "/v1/tasks/1", "", signingKey, "KP");
    // Backdated timestamp: 60s ago
    const staleTs = String(Math.floor(Date.now() / 1000) - 60);
    const stalHeaders = { ...headers, "x-peer-ts": staleTs };
    const result = verifyRequest(stalHeaders, "GET", "/v1/tasks/1", "", verifyKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale_ts");
  });

  it("nonce replay rejected", () => {
    const { signingKey, verifyKey } = makeKey();
    const headers = signRequest("POST", "/v1/callbacks", '{}', signingKey, "KP");
    // First verify: records nonce
    const r1 = verifyRequest(headers, "POST", "/v1/callbacks", '{}', verifyKey);
    expect(r1.ok).toBe(true);
    // Second verify: replay
    const r2 = verifyRequest(headers, "POST", "/v1/callbacks", '{}', verifyKey);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("nonce_replay");
  });

  it("empty body uses sha256 of empty string", () => {
    const { signingKey, verifyKey } = makeKey();
    const headers = signRequest("GET", "/v1/agent-card", "", signingKey, "KP");
    const result = verifyRequest(headers, "GET", "/v1/agent-card", "", verifyKey);
    expect(result.ok).toBe(true);
  });

  it("body mismatch rejected (different body on verify)", () => {
    const { signingKey, verifyKey } = makeKey();
    const headers = signRequest("POST", "/v1/tasks", '{"goal":"foo"}', signingKey, "KP");
    const result = verifyRequest(headers, "POST", "/v1/tasks", '{"goal":"bar"}', verifyKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_sig");
  });
});

// ── macTribe ──────────────────────────────────────────────────────────────────

describe("macTribe", () => {
  it("produces deterministic HMAC-SHA256", () => {
    const tribeToken = makeTribeToken();
    const mac1 = macTribe(tribeToken, "pubkeyAAA", "nonceRRR");
    const mac2 = macTribe(tribeToken, "pubkeyAAA", "nonceRRR");
    expect(mac1).toBe(mac2);
    expect(mac1).toMatch(/^[0-9a-f]{64}$/); // 32-byte hex
  });

  it("different tokens produce different MACs", () => {
    const t1 = makeTribeToken();
    const t2 = makeTribeToken();
    const mac1 = macTribe(t1, "pubkey", "nonce");
    const mac2 = macTribe(t2, "pubkey", "nonce");
    expect(mac1).not.toBe(mac2);
  });

  it("part concatenation order matters", () => {
    const token = makeTribeToken();
    const mac1 = macTribe(token, "AAA", "BBB");
    const mac2 = macTribe(token, "BBB", "AAA");
    expect(mac1).not.toBe(mac2);
  });
});

// ── signEnroll / verifyEnroll ─────────────────────────────────────────────────

describe("signEnroll / verifyEnroll", () => {
  it("round-trip: valid", () => {
    const { signingKey, verifyKey } = makeKey();
    const pubKeyI = verifyKey;
    const nonceR = "abc123nonce";
    const name = "initiator";
    const sig = signEnroll(signingKey, pubKeyI, nonceR, name);
    expect(verifyEnroll(sig, verifyKey, pubKeyI, nonceR, name)).toBe(true);
  });

  it("wrong key rejected", () => {
    const { signingKey } = makeKey();
    const { verifyKey: wrongKey } = makeKey();
    const pubKeyI = "somepubkey";
    const sig = signEnroll(signingKey, pubKeyI, "nonce", "name");
    expect(verifyEnroll(sig, wrongKey, pubKeyI, "nonce", "name")).toBe(false);
  });

  it("tampered payload rejected", () => {
    const { signingKey, verifyKey } = makeKey();
    const sig = signEnroll(signingKey, "pubkey", "nonce", "name");
    expect(verifyEnroll(sig, verifyKey, "pubkey", "nonce", "differentname")).toBe(false);
  });
});

// ── signAck / verifyAck ───────────────────────────────────────────────────────

describe("signAck / verifyAck", () => {
  it("round-trip: valid", () => {
    const { signingKey, verifyKey } = makeKey();
    const nameR = "responder";
    const pubKeyR = verifyKey;
    const nonceR = "nonce123";
    const sig = signAck(signingKey, nameR, pubKeyR, nonceR);
    expect(verifyAck(sig, verifyKey, nameR, pubKeyR, nonceR)).toBe(true);
  });

  it("wrong key rejected", () => {
    const { signingKey } = makeKey();
    const { verifyKey: wrongKey } = makeKey();
    const sig = signAck(signingKey, "name", "pubkey", "nonce");
    expect(verifyAck(sig, wrongKey, "name", "pubkey", "nonce")).toBe(false);
  });

  it("ackSig != enrollSig (domain separation)", () => {
    // Same key, same inputs — but sign/verifyEnroll and sign/verifyAck must not cross-verify
    const { signingKey, verifyKey } = makeKey();
    const pubKey = "somepubkey";
    const nonce = "nonce";
    const name = "name";
    const enrollSig = signEnroll(signingKey, pubKey, nonce, name);
    // verifyAck with enrollSig should fail (different canonical)
    expect(verifyAck(enrollSig, verifyKey, name, pubKey, nonce)).toBe(false);
  });
});

// ── generateTlsCert / verifyServerCert ───────────────────────────────────────

describe("generateTlsCert / verifyServerCert", () => {
  it("produces valid Ed25519 PEM and verifyServerCert matches", () => {
    const { signingKey, verifyKey } = makeKey();
    const { key, cert } = generateTlsCert(signingKey, "test-peer");
    // key is PEM
    expect(key).toContain("PRIVATE KEY");
    // cert is PEM
    expect(cert).toContain("CERTIFICATE");
    // The cert's public key must match verifyKey
    expect(verifyServerCert(cert, verifyKey)).toBe(true);
  });

  it("verifyServerCert rejects cert from a different key", () => {
    const { signingKey } = makeKey();
    const { verifyKey: otherVerifyKey } = makeKey();
    const { cert } = generateTlsCert(signingKey, "test");
    expect(verifyServerCert(cert, otherVerifyKey)).toBe(false);
  });
});

// ── #1390: signWsRequest / verifyWsRequest ────────────────────────────────────

describe("signWsRequest / verifyWsRequest", () => {
  const peerId = "KP";
  const requestId = "req-123";
  const method = "POST";
  const path = "/v1/tasks";
  const body = '{"goal":"test"}';

  it("round-trip: valid sig accepted", () => {
    const { signingKey, verifyKey } = makeKey();
    const auth = signWsRequest(peerId, requestId, method, path, body, signingKey);
    const result = verifyWsRequest({ ...auth, peerId, requestId }, method, path, body, verifyKey);
    expect(result.ok).toBe(true);
  });

  it("wrong key rejected", () => {
    const { signingKey } = makeKey();
    const { verifyKey: wrongKey } = makeKey();
    const auth = signWsRequest(peerId, requestId, method, path, body, signingKey);
    const result = verifyWsRequest({ ...auth, peerId, requestId }, method, path, body, wrongKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_sig");
  });

  it("stale ts rejected", () => {
    const { signingKey, verifyKey } = makeKey();
    const auth = signWsRequest(peerId, requestId, method, path, body, signingKey);
    const staleTs = String(Math.floor(Date.now() / 1000) - 60);
    const result = verifyWsRequest({ ...auth, peerId, requestId, ts: staleTs }, method, path, body, verifyKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale_ts");
  });

  it("nonce replay rejected", () => {
    const { signingKey, verifyKey } = makeKey();
    const auth = signWsRequest(peerId, requestId, method, path, body, signingKey);
    const fields = { ...auth, peerId, requestId };
    const r1 = verifyWsRequest(fields, method, path, body, verifyKey);
    expect(r1.ok).toBe(true);
    const r2 = verifyWsRequest(fields, method, path, body, verifyKey);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("nonce_replay");
  });

  it("body mismatch rejected", () => {
    const { signingKey, verifyKey } = makeKey();
    const auth = signWsRequest(peerId, requestId, method, path, body, signingKey);
    const result = verifyWsRequest({ ...auth, peerId, requestId }, method, path, '{"goal":"different"}', verifyKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_sig");
  });

  it("wrong peerId rejected", () => {
    const { signingKey, verifyKey } = makeKey();
    const auth = signWsRequest(peerId, requestId, method, path, body, signingKey);
    const result = verifyWsRequest({ ...auth, peerId: "WRONG", requestId }, method, path, body, verifyKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_sig");
  });

  it("wrong requestId rejected", () => {
    const { signingKey, verifyKey } = makeKey();
    const auth = signWsRequest(peerId, requestId, method, path, body, signingKey);
    const result = verifyWsRequest({ ...auth, peerId, requestId: "wrong-id" }, method, path, body, verifyKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_sig");
  });

  it("domain separation from HTTP signRequest", () => {
    const { signingKey, verifyKey } = makeKey();
    // HTTP signature should not verify as WS
    const httpHeaders = signRequest(method, path, body, signingKey, peerId);
    const result = verifyWsRequest(
      { peerId, requestId, ts: httpHeaders["X-Peer-Ts"]!, nonce: httpHeaders["X-Peer-Nonce"]!, sig: httpHeaders["X-Peer-Sig"]! },
      method, path, body, verifyKey,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_sig");
  });
});

// ── isNonceSeen / recordNonce (nonce cache — durable #1390) ───────────────────

describe("nonce cache", () => {
  it("unseen nonce returns false", () => {
    const nonce = "unique-nonce-" + Date.now();
    expect(isNonceSeen(nonce)).toBe(false);
  });

  it("seen nonce returns true after recording", () => {
    const nonce = "seen-nonce-" + Date.now();
    recordNonce(nonce);
    expect(isNonceSeen(nonce)).toBe(true);
  });
});
