import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let mod: typeof import("./pi-client-registry.js");

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `pi-reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  mod = await import("./pi-client-registry.js");
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("pi-client-registry", () => {
  it("generatePiKeypair produces valid Ed25519 keys", () => {
    const kp = mod.generatePiKeypair();
    expect(kp.signingKey).toBeTruthy();
    expect(kp.verifyKey).toBeTruthy();
    expect(kp.keyId).toBeTruthy();
    expect(kp.keyId.length).toBe(16);
    expect(kp.signingKey).not.toBe(kp.verifyKey);
  });

  it("piAuthorize creates credential and registration files", () => {
    const cred = mod.piAuthorize();
    expect(cred.clientId).toBe("pi-local");
    expect(cred.version).toBe(1);
    expect(cred.signingKey).toBeTruthy();
    expect(cred.keyId).toBeTruthy();

    expect(existsSync(mod.PI_CREDENTIAL_PATH)).toBe(true);
    expect(existsSync(mod.PI_CONFIG_PATH)).toBe(true);

    const state = mod.getPiClientState();
    expect(state.exists).toBe(true);
    expect(state.credential).toBeTruthy();
    expect(state.registration).toBeTruthy();
    expect(state.registration!.revokedAt).toBeUndefined();
  });

  it("readPiCredential returns null when file missing", () => {
    expect(mod.readPiCredential()).toBeNull();
  });

  it("readPiRegistration returns null when file missing", () => {
    expect(mod.readPiRegistration()).toBeNull();
  });

  it("readPiCredential returns null for corrupt JSON", () => {
    const { PI_CREDENTIAL_DIR, PI_CREDENTIAL_PATH } = mod;
    mkdirSync(PI_CREDENTIAL_DIR, { recursive: true });
    require("node:fs").writeFileSync(PI_CREDENTIAL_PATH, "not-json");
    expect(mod.readPiCredential()).toBeNull();
  });

  it("readPiCredential rejects invalid schema (wrong version)", () => {
    mod.piAuthorize();
    const { PI_CREDENTIAL_PATH } = mod;
    const raw = JSON.parse(readFileSync(PI_CREDENTIAL_PATH, "utf-8"));
    raw.version = 99;
    require("node:fs").writeFileSync(PI_CREDENTIAL_PATH, JSON.stringify(raw));
    expect(mod.readPiCredential()).toBeNull();
  });

  it("piRevoke marks registration as revoked", () => {
    mod.piAuthorize();
    const revoked = mod.piRevoke();
    expect(revoked.revokedAt).toBeTruthy();

    const state = mod.getPiClientState();
    expect(state.registration!.revokedAt).toBeTruthy();
    expect(state.credential).toBeTruthy();
  });

  it("piRevoke throws when no registration exists", () => {
    expect(() => mod.piRevoke()).toThrow("No Pi client credential found");
  });

  it("piRotate replaces keypair and keeps both files valid", () => {
    const original = mod.piAuthorize();
    const rotated = mod.piRotate();

    expect(rotated.keyId).not.toBe(original.keyId);
    expect(rotated.signingKey).not.toBe(original.signingKey);

    const state = mod.getPiClientState();
    expect(state.credential!.keyId).toBe(rotated.keyId);
    expect(state.registration!.keyId).toBe(rotated.keyId);
  });

  it("isPiClientActive returns true after authorize, false after revoke", () => {
    expect(mod.isPiClientActive()).toBe(false);
    mod.piAuthorize();
    expect(mod.isPiClientActive()).toBe(true);
    mod.piRevoke();
    expect(mod.isPiClientActive()).toBe(false);
  });

  it("getPiClientState reflects absence when no files exist", () => {
    const state = mod.getPiClientState();
    expect(state.exists).toBe(false);
    expect(state.credential).toBeNull();
    expect(state.registration).toBeNull();
  });
});
