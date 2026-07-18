import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, createCipheriv, randomBytes } from "node:crypto";

// Mock abtarsHome to use temp dir
const TEST_DIR = "/tmp/abtars-secrets-test-" + process.pid;
const SECRETS_DIR = join(TEST_DIR, "secret");

vi.mock("../paths.js", () => ({ abtarsHome: () => TEST_DIR }));

// #1216: secrets.ts now imports encrypt/decrypt from utils/crypto.ts. Mock only
// loadKey + deriveKey (return a deterministic master key); let the real
// encrypt/decrypt run. This way the wire format produced by the test matches
// what production code would produce on a real host.
vi.mock("../utils/crypto.js", async (importOriginal) => {
  const master = createHash("sha256").update("test-master-key").digest();
  const real = await importOriginal<typeof import("../utils/crypto.js")>();
  return {
    ...real,
    loadKey: () => master,
    deriveKey: (m: Buffer) => m, // pass-through — master IS the encryption key
  };
});

const { readSecret, writeSecret, initSecretsKey, clearSecretCache } = await import("./secrets.js");

describe("secrets.ts — encryption (#598)", () => {
  beforeEach(() => {
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    clearSecretCache();
    initSecretsKey();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("writeSecret creates ENC: prefixed file", () => {
    writeSecret("MY_KEY", "hello-world");
    const raw = readFileSync(join(SECRETS_DIR, "MY_KEY"), "utf-8");
    expect(raw.startsWith("ENC:")).toBe(true);
    expect(raw).not.toContain("hello-world");
  });

  it("readSecret decrypts ENC: file", () => {
    writeSecret("MY_KEY", "secret-value-123");
    clearSecretCache();
    const val = readSecret("MY_KEY");
    expect(val).toBe("secret-value-123");
  });

  it("readSecret passes through plaintext files", () => {
    writeFileSync(join(SECRETS_DIR, "PLAIN"), "plain-value");
    const val = readSecret("PLAIN");
    expect(val).toBe("plain-value");
  });

  it("readSecret returns undefined for missing files", () => {
    expect(readSecret("NOPE")).toBeUndefined();
  });

  it("readSecret caches the value across calls", () => {
    writeSecret("CACHED", "first-read");
    const first = readSecret("CACHED");
    expect(first).toBe("first-read");
    // Mutate the file on disk; the cached value should still be returned.
    writeFileSync(join(SECRETS_DIR, "CACHED"), "ENC:bogus");
    expect(readSecret("CACHED")).toBe("first-read");
  });
});

describe("secrets.ts — wire-format compatibility (#1216)", () => {
  // #1216: a file written by the OLD algorithm (with its in-file duplicate
  // AES-256-GCM helpers) must decrypt byte-identically under the NEW
  // readSecret. The wire format is unchanged: ENC: + base64([0x01][iv:12][ct][tag:16]).
  beforeEach(() => {
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    clearSecretCache();
    initSecretsKey();
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("decrypts a file written by the OLD algorithm (same wire format)", () => {
    const master = createHash("sha256").update("test-master-key").digest();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", master, iv);
    const ct = Buffer.concat([c.update("legacy-secret", "utf-8"), c.final()]);
    const tag = c.getAuthTag();
    // Identical layout to the pre-#1216 encryptSecret: [0x01][iv:12][ct][tag:16], base64.
    const blob = "ENC:" + Buffer.concat([Buffer.from([0x01]), iv, ct, tag]).toString("base64");
    writeFileSync(join(SECRETS_DIR, "LEGACY"), blob);

    clearSecretCache();
    expect(readSecret("LEGACY")).toBe("legacy-secret");
  });

  it("decrypts a plaintext-passthrough file written by the OLD code", () => {
    // Legacy plaintext (no ENC: prefix) — pre-#1216 supported this too.
    writeFileSync(join(SECRETS_DIR, "LEGACY_PLAIN"), "old-plain-value");
    expect(readSecret("LEGACY_PLAIN")).toBe("old-plain-value");
  });
});
