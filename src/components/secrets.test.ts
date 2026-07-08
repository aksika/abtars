import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Mock abtarsHome to use temp dir
const TEST_DIR = "/tmp/abtars-secrets-test-" + process.pid;
const SECRETS_DIR = join(TEST_DIR, "secret");

vi.mock("../paths.js", () => ({ abtarsHome: () => TEST_DIR }));
vi.mock("../utils/crypto.js", () => {
  const { createHash } = require("node:crypto");
  // Deterministic test master key
  const master = createHash("sha256").update("test-master-key").digest();
  return {
    loadKey: () => master,
    deriveKey: (m: Buffer) => m, // pass-through for tests
  };
});

import { vi } from "vitest";
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
});
