import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { signMessage, verifyMessage, stripSigTag } from "./digital-signature.js";

function generateTestKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

describe("irc-signature", () => {
  const keys = generateTestKeypair();

  it("sign and verify round-trip", () => {
    const { tag } = signMessage(keys.privateKey, "kp-bot", "#test", "hello world");
    const raw = `hello world ${tag}`;
    const result = verifyMessage(keys.publicKey, "kp-bot", "#test", raw);
    expect(result.valid).toBe(true);
    expect(result.text).toBe("hello world");
  });

  it("rejects tampered message", () => {
    const { tag } = signMessage(keys.privateKey, "kp-bot", "#test", "hello world");
    const raw = `hello TAMPERED ${tag}`;
    const result = verifyMessage(keys.publicKey, "kp-bot", "#test", raw);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad-signature");
  });

  it("rejects wrong nick", () => {
    const { tag } = signMessage(keys.privateKey, "kp-bot", "#test", "hello");
    const raw = `hello ${tag}`;
    const result = verifyMessage(keys.publicKey, "imposter", "#test", raw);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad-signature");
  });

  it("rejects wrong channel", () => {
    const { tag } = signMessage(keys.privateKey, "kp-bot", "#test", "hello");
    const raw = `hello ${tag}`;
    const result = verifyMessage(keys.publicKey, "kp-bot", "#other", raw);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad-signature");
  });

  it("rejects missing signature", () => {
    const result = verifyMessage(keys.publicKey, "kp-bot", "#test", "hello no sig");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("no-signature");
  });

  it("rejects expired timestamp", () => {
    // Manually craft an old signature by monkey-patching Date.now
    const realNow = Date.now;
    Date.now = () => realNow() - 60_000; // 60s in the past
    const { tag } = signMessage(keys.privateKey, "kp-bot", "#test", "old msg");
    Date.now = realNow;
    const raw = `old msg ${tag}`;
    const result = verifyMessage(keys.publicKey, "kp-bot", "#test", raw);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("expired");
  });

  it("rejects wrong key", () => {
    const otherKeys = generateTestKeypair();
    const { tag } = signMessage(keys.privateKey, "kp-bot", "#test", "hello");
    const raw = `hello ${tag}`;
    const result = verifyMessage(otherKeys.publicKey, "kp-bot", "#test", raw);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad-signature");
  });

  it("stripSigTag removes tag", () => {
    expect(stripSigTag("hello [sig:123:abc=]")).toBe("hello");
    expect(stripSigTag("no tag here")).toBe("no tag here");
  });
});
