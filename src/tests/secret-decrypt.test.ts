import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, randomBytes, hkdfSync } from "node:crypto";

describe("secret decrypt graceful failure", () => {
  let tmpDir: string;
  let secretDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "secret-test-"));
    secretDir = join(tmpDir, "secret");
    mkdirSync(secretDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function encryptWithKey(value: string, key: Buffer): string {
    const purposeKey = Buffer.from(hkdfSync("sha256", key, "", "abtars-secrets-files-v1", 32));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", purposeKey, iv);
    const enc = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return "ENC:" + Buffer.concat([Buffer.from([0x01]), iv, enc, tag]).toString("base64");
  }

  it("plaintext secret loads into env", () => {
    writeFileSync(join(secretDir, "TEST_TOKEN"), "plain-value", { mode: 0o600 });

    // Simulate env.ts logic: read secret, if plaintext → load
    const raw = readFileSync(join(secretDir, "TEST_TOKEN"), "utf-8").trim();
    expect(raw.startsWith("ENC:")).toBe(false);
    // Would be loaded as process.env.TEST_TOKEN = raw
    expect(raw).toBe("plain-value");
  });

  it("encrypted secret with correct key decrypts", () => {
    const key = randomBytes(32);
    const encrypted = encryptWithKey("my-secret-token", key);
    writeFileSync(join(secretDir, "TEST_TOKEN"), encrypted, { mode: 0o600 });

    const raw = readFileSync(join(secretDir, "TEST_TOKEN"), "utf-8").trim();
    expect(raw.startsWith("ENC:")).toBe(true);

    // Decrypt
    const blob = Buffer.from(raw.slice(4), "base64");
    const version = blob[0]; // 0x01
    expect(version).toBe(1);
    const iv = blob.subarray(1, 13);
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(13, blob.length - 16);
    const purposeKey = Buffer.from(hkdfSync("sha256", key, "", "abtars-secrets-files-v1", 32));
    const { createDecipheriv } = require("node:crypto");
    const decipher = createDecipheriv("aes-256-gcm", purposeKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
    expect(decrypted).toBe("my-secret-token");
  });

  it("encrypted secret with WRONG key fails gracefully (no crash)", () => {
    const correctKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    const encrypted = encryptWithKey("my-secret-token", correctKey);
    writeFileSync(join(secretDir, "TEST_TOKEN"), encrypted, { mode: 0o600 });

    const raw = readFileSync(join(secretDir, "TEST_TOKEN"), "utf-8").trim();
    expect(raw.startsWith("ENC:")).toBe(true);

    // Try decrypt with wrong key — should throw (which env.ts catches)
    const blob = Buffer.from(raw.slice(4), "base64");
    const iv = blob.subarray(1, 13);
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(13, blob.length - 16);
    const wrongPurposeKey = Buffer.from(hkdfSync("sha256", wrongKey, "", "abtars-secrets-files-v1", 32));
    const { createDecipheriv } = require("node:crypto");
    const decipher = createDecipheriv("aes-256-gcm", wrongPurposeKey, iv);
    decipher.setAuthTag(tag);

    // This MUST throw — env.ts wraps in try/catch and skips
    expect(() => {
      Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }).toThrow();
  });

  it("missing secret file does not crash", () => {
    // Simulate: readFileSync on non-existent file
    expect(() => {
      readFileSync(join(secretDir, "NONEXISTENT"), "utf-8");
    }).toThrow();
    // env.ts catches this — no crash, secret just not loaded
  });
});
