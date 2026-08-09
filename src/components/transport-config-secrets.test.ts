/**
 * transport-config secrets hardening (#1354): schema whitelist, apiKeyEnv
 * validation, serializer boundary, backup safety, and the sentinel invariant
 * (no credential value ever reaches primary, temp, or backup files).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TEST_HOME = "/tmp/abtars-tc-secrets-" + process.pid;
const CONFIG_DIR = join(TEST_HOME, "config");

vi.mock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));

const SENTINEL = "sk-or-SENTINEL-1354-0123456789abcdef";

const SAFE = {
  schemaVersion: 3,
  activeRoute: "pi-ai",
  routes: {
    "pi-ai": {
      agents: { main: { model: "deepseek/deepseek-v4-flash", provider: "openrouter" } },
      fallbacks: [],
    },
  },
  providers: {
    openrouter: { transport: "api", endpoint: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  },
};

const { validateTransportConfig, writeTransportConfig, serializeTransportConfig, restorePrevious, resetToDefaults, clearTransportCache } = await import("./transport-config.js");

describe("#1354 — provider schema whitelist", () => {
  it("rejects raw apiKey field with plaintext_secret_field", () => {
    const r = validateTransportConfig({
      ...SAFE,
      providers: { openrouter: { transport: "api", apiKey: SENTINEL } },
    } as unknown as Record<string, unknown>);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.issues.find(i => i.code === "plaintext_secret_field");
      expect(issue).toBeDefined();
      expect(issue!.path).toBe("providers.openrouter.apiKey");
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    }
  });

  it("rejects token/secret/password variants", () => {
    for (const field of ["api_key", "token", "secret", "password", "clientSecret", "credential"]) {
      const r = validateTransportConfig({
        ...SAFE,
        providers: { openrouter: { transport: "api", [field]: "x" } },
      } as unknown as Record<string, unknown>);
      expect(r.ok, field).toBe(false);
      if (!r.ok) expect(r.issues.some(i => i.code === "plaintext_secret_field"), field).toBe(true);
    }
  });

  it("rejects unknown non-secret fields (schema-whitelisted)", () => {
    const r = validateTransportConfig({
      ...SAFE,
      providers: { openrouter: { transport: "api", typoField: 1 } },
    } as unknown as Record<string, unknown>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some(i => i.code === "invalid_provider_field")).toBe(true);
  });

  it("rejects invalid apiKeyEnv names", () => {
    for (const bad of ["openrouter key", "lower", "A-B", "1X", ""]) {
      const r = validateTransportConfig({
        ...SAFE,
        providers: { openrouter: { transport: "api", apiKeyEnv: bad } },
      } as unknown as Record<string, unknown>);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.issues.some(i => i.path.endsWith("apiKeyEnv")), bad).toBe(true);
    }
  });

  it("accepts apiKeyEnv references (env names only)", () => {
    const r = validateTransportConfig(SAFE as unknown as Record<string, unknown>);
    expect(r.ok).toBe(true);
  });
});

describe("#1354 — serializer boundary", () => {
  it("serializeTransportConfig drops raw credential fields", () => {
    const dirty = {
      ...SAFE,
      providers: {
        openrouter: {
          transport: "api",
          apiKeyEnv: "OPENROUTER_API_KEY",
          apiKey: SENTINEL,
          token: "t",
        },
      },
    } as unknown as Parameters<typeof serializeTransportConfig>[0];
    const out = serializeTransportConfig(dirty);
    expect(out).not.toContain(SENTINEL);
    const parsed = JSON.parse(out);
    expect(parsed.providers.openrouter.apiKey).toBeUndefined();
    expect(parsed.providers.openrouter.token).toBeUndefined();
    expect(parsed.providers.openrouter.apiKeyEnv).toBe("OPENROUTER_API_KEY");
  });
});

describe("#1354 — writer + backup safety", () => {
  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    clearTransportCache();
  });

  afterEach(() => {
    clearTransportCache();
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  function fileNames(): string[] {
    return readdirSync(CONFIG_DIR).filter(f => f.includes("transport"));
  }

  it("refuses to write a candidate containing raw credential fields", () => {
    const dirty = {
      ...SAFE,
      providers: { openrouter: { transport: "api", apiKey: SENTINEL } },
    } as unknown as Parameters<typeof writeTransportConfig>[0];
    const r = writeTransportConfig(dirty, "test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some(i => i.location.includes("apiKey"))).toBe(true);
  });

  it("does not copy an unsafe existing primary into the backup", () => {
    writeFileSync(join(CONFIG_DIR, "transport.json"), JSON.stringify({
      ...SAFE,
      providers: { openrouter: { transport: "api", apiKey: SENTINEL } },
    }));
    const r = writeTransportConfig(SAFE as unknown as Parameters<typeof writeTransportConfig>[0], "replace unsafe");
    expect(r.ok).toBe(true);
    const all = fileNames().map(f => readFileSync(join(CONFIG_DIR, f), "utf-8"));
    expect(all.some(c => c.includes(SENTINEL))).toBe(false);
  });

  it("backup keeps the previous safe config on a normal write", () => {
    writeFileSync(join(CONFIG_DIR, "transport.json"), JSON.stringify(SAFE));
    const r = writeTransportConfig({ ...SAFE, maxTurns: 77 } as unknown as Parameters<typeof writeTransportConfig>[0], "second write");
    expect(r.ok).toBe(true);
    const oldPath = join(CONFIG_DIR, "transport.old.json");
    expect(existsSync(oldPath)).toBe(true);
    const backup = JSON.parse(readFileSync(oldPath, "utf-8"));
    expect(backup.maxTurns).toBeUndefined();
  });

  it("restorePrevious refuses an unsafe backup", () => {
    writeFileSync(join(CONFIG_DIR, "transport.json"), JSON.stringify(SAFE));
    writeFileSync(join(CONFIG_DIR, "transport.old.json"), JSON.stringify({
      ...SAFE,
      providers: { openrouter: { transport: "api", apiKey: SENTINEL } },
    }));
    const r = restorePrevious();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid");
    // primary untouched
    const primary = JSON.parse(readFileSync(join(CONFIG_DIR, "transport.json"), "utf-8"));
    expect(primary.providers.openrouter.apiKey).toBeUndefined();
  });

  it("sentinel invariant: no primary/temp/backup file ever contains the sentinel", () => {
    writeFileSync(join(CONFIG_DIR, "transport.json"), JSON.stringify({
      ...SAFE,
      providers: { openrouter: { transport: "api", apiKey: SENTINEL } },
    }));
    writeTransportConfig(SAFE as unknown as Parameters<typeof writeTransportConfig>[0], "cleanup");
    writeTransportConfig({ ...SAFE, maxTurns: 9 } as unknown as Parameters<typeof writeTransportConfig>[0], "another");
    const all = fileNames().map(f => readFileSync(join(CONFIG_DIR, f), "utf-8")).join("\n");
    expect(all).not.toContain(SENTINEL);
  });

  it("restorePrevious never writes an unsafe previous active into the backup", () => {
    writeFileSync(join(CONFIG_DIR, "transport.json"), JSON.stringify({
      ...SAFE,
      providers: { openrouter: { transport: "api", apiKey: SENTINEL } },
    }));
    writeFileSync(join(CONFIG_DIR, "transport.old.json"), JSON.stringify(SAFE));
    const r = restorePrevious();
    expect(r.ok).toBe(true);
    const all = fileNames().map(f => readFileSync(join(CONFIG_DIR, f), "utf-8")).join("\n");
    expect(all).not.toContain(SENTINEL);
  });

  it("resetToDefaults never backs up an unsafe primary", () => {
    writeFileSync(join(CONFIG_DIR, "transport.default.json"), JSON.stringify(SAFE));
    writeFileSync(join(CONFIG_DIR, "transport.json"), JSON.stringify({
      ...SAFE,
      providers: { openrouter: { transport: "api", apiKey: SENTINEL } },
    }));
    expect(resetToDefaults()).toBe(true);
    const all = fileNames().map(f => readFileSync(join(CONFIG_DIR, f), "utf-8")).join("\n");
    expect(all).not.toContain(SENTINEL);
  });
});
