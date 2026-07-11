import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

let TEST_HOME: string;
let authMod: typeof import("./pi-auth.js");
let regMod: typeof import("./pi-client-registry.js");

const FIXED_SIGNING_KEY = "MC4CAQAwBQYDK2VwBCIEIMpFWz2hNcBs246s1mKzY77q922hxHVnP2C+RtQWVi9A";
const FIXED_VERIFY_KEY = "MCowBQYDK2VwAyEAEnYBk7rAepS9a8kipIllQgfhk7CtfZhl3GlWXa9cufU=";
const FIXED_KEY_ID = "eded156be7f98b56";
const FIXED_SCOPES = ["status", "notify:main", "task:create", "task:read", "peer:read", "peer:delegate"];

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `pi-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));

  // Write a valid registration so pi-auth can load it
  const configDir = join(TEST_HOME, "config");
  mkdirSync(configDir, { recursive: true });
  const reg = {
    version: 1,
    clientId: "pi-local",
    keyId: FIXED_KEY_ID,
    verifyKey: FIXED_VERIFY_KEY,
    scopes: FIXED_SCOPES,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(configDir, "pi-clients.json"), JSON.stringify(reg, null, 2), { mode: 0o600 });

  authMod = await import("./pi-auth.js");
  regMod = await import("./pi-client-registry.js");
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function headers(overrides: Record<string, string> = {}): Record<string, string | string[] | undefined> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = "aabbccddee0011223344556677889900";
  const method = overrides["method"] ?? "GET";
  const path = overrides["path"] ?? "/v1/pi/status";
  const body = overrides["body"] ?? "";
  const clientId = overrides["X-Abtars-Pi-Client"] ?? "pi-local";
  const keyId = overrides["X-Abtars-Pi-Key-Id"] ?? FIXED_KEY_ID;
  const ts = overrides["X-Abtars-Pi-Ts"] ?? String(now);
  const n = overrides["X-Abtars-Pi-Nonce"] ?? nonce;
  const canonical = authMod.piCanonical(method, path, clientId, keyId, ts, n, body);
  const privKey = createPrivateKey({ key: Buffer.from(FIXED_SIGNING_KEY, "base64"), format: "der", type: "pkcs8" });
  const sig = cryptoSign(null, Buffer.from(canonical, "utf-8"), privKey).toString("base64");

  return {
    "X-Abtars-Pi-Client": clientId,
    "X-Abtars-Pi-Key-Id": keyId,
    "X-Abtars-Pi-Ts": ts,
    "X-Abtars-Pi-Nonce": n,
    "X-Abtars-Pi-Sig": overrides["X-Abtars-Pi-Sig"] ?? sig,
  };
}

describe("pi-auth", () => {
  describe("piCanonical", () => {
    it("includes domain prefix and all fields", () => {
      const c = authMod.piCanonical("POST", "/v1/pi/notify", "pi-local", "k1", "1000", "n1", '{"a":1}');
      expect(c).toContain("abtars-pi-v1");
      expect(c).toContain("POST");
      expect(c).toContain("/v1/pi/notify");
      expect(c).toContain("pi-local");
      expect(c).toContain("k1");
      expect(c).toContain("1000");
      expect(c).toContain("n1");
    });
  });

  describe("signPiRequest", () => {
    it("returns all 5 auth headers", () => {
      const h = authMod.signPiRequest("GET", "/v1/pi/status", "", FIXED_SIGNING_KEY, "pi-local", FIXED_KEY_ID);
      expect(h["X-Abtars-Pi-Client"]).toBe("pi-local");
      expect(h["X-Abtars-Pi-Key-Id"]).toBe(FIXED_KEY_ID);
      expect(h["X-Abtars-Pi-Ts"]).toBeTruthy();
      expect(h["X-Abtars-Pi-Nonce"]).toBeTruthy();
      expect(h["X-Abtars-Pi-Sig"]).toBeTruthy();
    });
  });

  describe("verifyPiRequest", () => {
    it("accepts a valid request", () => {
      const result = authMod.verifyPiRequest("GET", "/v1/pi/status", "", headers());
      expect(result.ok).toBe(true);
      expect(result.registration).toBeTruthy();
      expect(result.registration!.keyId).toBe(FIXED_KEY_ID);
    });

    it("rejects missing headers", () => {
      const result = authMod.verifyPiRequest("GET", "/v1/pi/status", "", {});
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("missing_headers");
    });

    it("rejects unknown client ID", () => {
      const result = authMod.verifyPiRequest("GET", "/v1/pi/status", "", headers({ "X-Abtars-Pi-Client": "evil" }));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("unknown_client");
    });

    it("rejects when no registration file exists", async () => {
      vi.resetModules();
      TEST_HOME = join(tmpdir(), `pi-auth-noreg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(TEST_HOME, { recursive: true });
      vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
      authMod = await import("./pi-auth.js");
      const result = authMod.verifyPiRequest("GET", "/v1/pi/status", "", headers());
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("no_registration");
    });

  it("rejects revoked registration", { timeout: 5000 }, async () => {
    regMod.piRevoke();
    vi.resetModules();
    vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    const auth = await import("./pi-auth.js");
    const result = auth.verifyPiRequest("GET", "/v1/pi/status", "", headers());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("revoked");
  });

    it("rejects wrong key ID", () => {
      const result = authMod.verifyPiRequest("GET", "/v1/pi/status", "", headers({ "X-Abtars-Pi-Key-Id": "wrong" }));
      expect(result.ok).toBe(false);
    });

    it("rejects stale timestamp (>30s)", () => {
      const oldTs = String(Math.floor(Date.now() / 1000) - 31);
      const result = authMod.verifyPiRequest("GET", "/v1/pi/status", "", headers({ "X-Abtars-Pi-Ts": oldTs }));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("stale_ts");
    });

    it("rejects future timestamp (>30s ahead)", () => {
      const futureTs = String(Math.floor(Date.now() / 1000) + 31);
      const result = authMod.verifyPiRequest("GET", "/v1/pi/status", "", headers({ "X-Abtars-Pi-Ts": futureTs }));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("stale_ts");
    });

    it("rejects bad signature", () => {
      const result = authMod.verifyPiRequest("GET", "/v1/pi/status", "", headers({ "X-Abtars-Pi-Sig": "AAAAAA==" }));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("bad_sig");
    });

    it("rejects nonce replay within 60s", () => {
      const h = headers();
      const r1 = authMod.verifyPiRequest("GET", "/v1/pi/status", "", h);
      expect(r1.ok).toBe(true);
      const r2 = authMod.verifyPiRequest("GET", "/v1/pi/status", "", h);
      expect(r2.ok).toBe(false);
      expect(r2.reason).toBe("nonce_replay");
    });

    it("rejects altered body", () => {
      const h = headers({ body: '{"a":1}' });
      const result = authMod.verifyPiRequest("GET", "/v1/pi/status", '{"b":2}', h);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("bad_sig");
    });

    it("rejects altered path", () => {
      const h = headers({ path: "/v1/pi/status" });
      const result = authMod.verifyPiRequest("GET", "/v1/pi/peers", "", h);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("bad_sig");
    });
  });

  describe("piRouteRequiresScope", () => {
    it("returns status for GET /v1/pi/status", () => {
      expect(authMod.piRouteRequiresScope("/v1/pi/status", "GET")).toBe("status");
    });

    it("returns notify:main for POST /v1/pi/notify", () => {
      expect(authMod.piRouteRequiresScope("/v1/pi/notify", "POST")).toBe("notify:main");
    });

    it("returns task:create for POST /v1/pi/tasks", () => {
      expect(authMod.piRouteRequiresScope("/v1/pi/tasks", "POST")).toBe("task:create");
    });

    it("returns task:read for GET /v1/pi/tasks/42", () => {
      expect(authMod.piRouteRequiresScope("/v1/pi/tasks/42", "GET")).toBe("task:read");
    });

    it("returns peer:read for GET /v1/pi/peers", () => {
      expect(authMod.piRouteRequiresScope("/v1/pi/peers", "GET")).toBe("peer:read");
    });

    it("returns peer:delegate for POST /v1/pi/peers/delegate", () => {
      expect(authMod.piRouteRequiresScope("/v1/pi/peers/delegate", "POST")).toBe("peer:delegate");
    });

    it("returns null for unknown path", () => {
      expect(authMod.piRouteRequiresScope("/v1/pi/hack", "GET")).toBeNull();
    });

    it("returns null for wrong method", () => {
      expect(authMod.piRouteRequiresScope("/v1/pi/status", "POST")).toBeNull();
    });

    it("returns null for non-Pi path", () => {
      expect(authMod.piRouteRequiresScope("/v1/chat/completions", "POST")).toBeNull();
    });
  });

  describe("isLoopbackAddress", () => {
    it("returns true for 127.0.0.1", () => {
      expect(authMod.isLoopbackAddress("127.0.0.1")).toBe(true);
    });

    it("returns true for ::1", () => {
      expect(authMod.isLoopbackAddress("::1")).toBe(true);
    });

    it("returns true for ::ffff:127.0.0.1", () => {
      expect(authMod.isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    });

    it("returns true for undefined", () => {
      expect(authMod.isLoopbackAddress(undefined)).toBe(true);
    });

    it("returns false for external IP", () => {
      expect(authMod.isLoopbackAddress("10.0.0.1")).toBe(false);
    });

    it("returns false for public IP", () => {
      expect(authMod.isLoopbackAddress("203.0.113.1")).toBe(false);
    });
  });
});
