import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKey, deriveKey, encrypt, decrypt, writeKeyFile, writeKeyVerify, validateKey, deriveFromPassphrase } from "./crypto.js";

const PURPOSE = "abtars-test-v1";

describe("crypto", () => {
  let tmpDir: string;
  let keyPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "abtars-crypto-"));
    keyPath = join(tmpDir, "test.key");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadKey returns 32-byte Buffer from hex file", () => {
    const hex = "a".repeat(64);
    writeFileSync(keyPath, hex + "\n");
    const key = loadKey(keyPath);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(hex);
  });

  it("loadKey returns null for missing file", () => {
    expect(loadKey(keyPath)).toBeNull();
  });

  it("loadKey returns null for invalid hex length", () => {
    writeFileSync(keyPath, "tooshort\n");
    expect(loadKey(keyPath)).toBeNull();
  });

  it("deriveKey produces 32-byte key from master + purpose", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    const key = deriveKey(master, PURPOSE);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("deriveKey produces same key for same master + purpose", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    const k1 = deriveKey(master, PURPOSE);
    const k2 = deriveKey(master, PURPOSE);
    expect(k1.equals(k2)).toBe(true);
  });

  it("deriveKey produces different keys for different purposes", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    const k1 = deriveKey(master, "purpose-a");
    const k2 = deriveKey(master, "purpose-b");
    expect(k1.equals(k2)).toBe(false);
  });

  it("encrypt/decrypt roundtrip", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    const key = deriveKey(master, PURPOSE);
    const plaintext = "sk-proj-abc123-secret-api-key";
    const blob = encrypt(plaintext, key);
    expect(blob).not.toBe(plaintext);
    expect(decrypt(blob, key)).toBe(plaintext);
  });

  it("encrypt produces different ciphertext each time (random IV)", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    const key = deriveKey(master, PURPOSE);
    const text = "same input";
    const a = encrypt(text, key);
    const b = encrypt(text, key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe(text);
    expect(decrypt(b, key)).toBe(text);
  });

  it("decrypt fails with wrong key", () => {
    const master1 = Buffer.from("a".repeat(64), "hex");
    const master2 = Buffer.from("b".repeat(64), "hex");
    const key1 = deriveKey(master1, PURPOSE);
    const key2 = deriveKey(master2, PURPOSE);
    const blob = encrypt("secret", key1);
    expect(decrypt(blob, key2)).toBeNull();
  });

  it("decrypt fails with tampered ciphertext", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    const key = deriveKey(master, PURPOSE);
    const blob = encrypt("secret", key);
    // Flip a byte in the ciphertext portion
    const buf = Buffer.from(blob, "base64");
    if (buf.length > 2) buf[2] ^= 0xff;
    expect(decrypt(buf.toString("base64"), key)).toBeNull();
  });

  it("handles empty string", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    const key = deriveKey(master, PURPOSE);
    const blob = encrypt("", key);
    expect(decrypt(blob, key)).toBe("");
  });

  it("handles unicode content", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    const key = deriveKey(master, PURPOSE);
    const text = "Titkos jelszó: 🔑 パスワード";
    expect(decrypt(encrypt(text, key), key)).toBe(text);
  });
});

describe("passphrase derivation", () => {
  it("deriveFromPassphrase produces deterministic 32-byte key", () => {
    const k1 = deriveFromPassphrase("mypass", "aksika");
    const k2 = deriveFromPassphrase("mypass", "aksika");
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });

  it("different username produces different key", () => {
    const k1 = deriveFromPassphrase("mypass", "aksika");
    const k2 = deriveFromPassphrase("mypass", "other");
    expect(k1.equals(k2)).toBe(false);
  });

  it("different passphrase produces different key", () => {
    const k1 = deriveFromPassphrase("pass1", "user");
    const k2 = deriveFromPassphrase("pass2", "user");
    expect(k1.equals(k2)).toBe(false);
  });
});

describe("key file + verify", () => {
  let tmpDir: string;
  let keyPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "abtars-keyfile-"));
    keyPath = join(tmpDir, "test.key");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writeKeyFile creates file with 64-char hex", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    writeKeyFile(keyPath, master);
    const content = readFileSync(keyPath, "utf-8");
    expect(content.trim()).toBe("a".repeat(64));
  });

  it("writeKeyVerify + validateKey round-trip", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    writeKeyFile(keyPath, master);
    const purposeKey = deriveKey(master, PURPOSE);
    writeKeyVerify(keyPath, purposeKey);
    expect(validateKey(keyPath, purposeKey)).toBe(true);
  });

  it("validateKey returns true when no verify file exists", () => {
    const master = Buffer.from("a".repeat(64), "hex");
    writeKeyFile(keyPath, master);
    const purposeKey = deriveKey(master, PURPOSE);
    expect(validateKey(keyPath, purposeKey)).toBe(true);
  });

  it("validateKey returns false with wrong key", () => {
    const master1 = Buffer.from("a".repeat(64), "hex");
    const master2 = Buffer.from("b".repeat(64), "hex");
    writeKeyFile(keyPath, master1);
    const purposeKey1 = deriveKey(master1, PURPOSE);
    writeKeyVerify(keyPath, purposeKey1);
    const purposeKey2 = deriveKey(master2, PURPOSE);
    expect(validateKey(keyPath, purposeKey2)).toBe(false);
  });
});
