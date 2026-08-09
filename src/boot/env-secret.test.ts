import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isolatedChildEnv } from "../test-support/runtime-isolation.js";

const TEST_HOME = mkdtempSync(join(tmpdir(), "abtars-env-secret-test-"));
const CONFIG_DIR = join(TEST_HOME, "config");
const SECRET_DIR = join(TEST_HOME, "secret");
const CWD = join(__dirname, "../..");

describe("boot/env.ts — secret file loading", () => {
  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(CONFIG_DIR, ".env"), "");
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  function run(keys: string[]): { stdout: string; stderr: string } {
    // Always exercise the SOURCE env.ts — a stale dist/ build would test
    // pre-#1354 behavior and silently hide migration bugs.
    const args = ["--import", "tsx/esm", "--import", "./src/boot/env.ts"];
    const probe = keys.map(k => `${k}: process.env[${JSON.stringify(k)}] || null`).join(", ");
    const r = spawnSync("node", [
      ...args,
      "-e", `console.log(JSON.stringify({ ${probe} }))`,
    ], {
      encoding: "utf-8",
      env: isolatedChildEnv({ ABTARS_HOME: TEST_HOME }),
      timeout: 10000,
      cwd: CWD,
    });
    return { stdout: r.stdout, stderr: r.stderr };
  }

  it("loads secret file into process.env", () => {
    writeFileSync(join(SECRET_DIR, "MY_KEY"), "super-secret-value\n");
    const { stdout } = run(["MY_KEY"]);
    expect(JSON.parse(stdout.trim())).toEqual({ MY_KEY: "super-secret-value" });
  });

  it("skips missing secret files silently", () => {
    const { stdout, stderr } = run(["MY_KEY"]);
    expect(JSON.parse(stdout.trim())).toEqual({ MY_KEY: null });
    expect(stderr).not.toContain("Error");
  });

  it("skips empty secret files", () => {
    writeFileSync(join(SECRET_DIR, "MY_KEY"), "   \n");
    const { stdout } = run(["MY_KEY"]);
    expect(JSON.parse(stdout.trim())).toEqual({ MY_KEY: null });
  });

  it("does not touch env vars with normal values in .env", () => {
    writeFileSync(join(CONFIG_DIR, ".env"), "MY_KEY=normal-value\n");
    const { stdout } = run(["MY_KEY"]);
    expect(JSON.parse(stdout.trim())).toEqual({ MY_KEY: "normal-value" });
  });
});

describe("boot/env.ts — #1354 migration", () => {
  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(CONFIG_DIR, ".env"), "");
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  function run(keys: string[]): { stdout: string; stderr: string } {
    // Always exercise the SOURCE env.ts — a stale dist/ build would test
    // pre-#1354 behavior and silently hide migration bugs.
    const args = ["--import", "tsx/esm", "--import", "./src/boot/env.ts"];
    const probe = keys.map(k => `${k}: process.env[${JSON.stringify(k)}] || null`).join(", ");
    const r = spawnSync("node", [
      ...args,
      "-e", `console.log(JSON.stringify({ ${probe} }))`,
    ], {
      encoding: "utf-8",
      env: isolatedChildEnv({ ABTARS_HOME: TEST_HOME }),
      timeout: 10000,
      cwd: CWD,
    });
    return { stdout: r.stdout, stderr: r.stderr };
  }

  it("migrates a credential-shaped .env assignment into secret/ and removes it from the file", () => {
    writeFileSync(join(CONFIG_DIR, ".env"), [
      "DEFAULT_PROVIDER=openrouter",
      "OPENAI_API_KEY=sk-migrate-me-1234567890",
      "LOG_LEVEL=debug",
      "",
    ].join("\n"));
    const { stdout, stderr } = run(["OPENAI_API_KEY", "DEFAULT_PROVIDER", "LOG_LEVEL"]);
    expect(JSON.parse(stdout.trim())).toEqual({
      OPENAI_API_KEY: "sk-migrate-me-1234567890",
      DEFAULT_PROVIDER: "openrouter",
      LOG_LEVEL: "debug",
    });
    // secret committed
    expect(existsSync(join(SECRET_DIR, "OPENAI_API_KEY"))).toBe(true);
    // plaintext removed from .env, unrelated lines preserved
    const remaining = readFileSync(join(CONFIG_DIR, ".env"), "utf-8");
    expect(remaining).not.toContain("sk-migrate-me-1234567890");
    expect(remaining).toContain("DEFAULT_PROVIDER=openrouter");
    expect(remaining).toContain("LOG_LEVEL=debug");
    // redacted log: names but never values
    expect(stderr).toContain("OPENAI_API_KEY");
    expect(stderr).not.toContain("sk-migrate-me-1234567890");
  });

  it("supports quoted values", () => {
    writeFileSync(join(CONFIG_DIR, ".env"), 'GROQ_API_KEY="gsk-quoted-value-12345"\n');
    const { stdout } = run(["GROQ_API_KEY"]);
    expect(JSON.parse(stdout.trim())).toEqual({ GROQ_API_KEY: "gsk-quoted-value-12345" });
    // without an abtars.key the compatible payload is plaintext (boot
    // auto-encrypts once a key exists); the .env line must be gone
    expect(readFileSync(join(SECRET_DIR, "GROQ_API_KEY"), "utf-8")).toBe("gsk-quoted-value-12345");
    expect(readFileSync(join(CONFIG_DIR, ".env"), "utf-8")).not.toContain("GROQ_API_KEY");
  });

  it("conflicting plaintext disables the provider: no env value, files unchanged", () => {
    writeFileSync(join(CONFIG_DIR, ".env"), "OPENAI_API_KEY=sk-value-a-123456\n");
    writeFileSync(join(CONFIG_DIR, ".env.skills"), "OPENAI_API_KEY=sk-value-b-123456\n");
    const { stdout, stderr } = run(["OPENAI_API_KEY"]);
    // value must NOT be usable this boot
    expect(JSON.parse(stdout.trim())).toEqual({ OPENAI_API_KEY: null });
    // files untouched for recovery
    expect(readFileSync(join(CONFIG_DIR, ".env"), "utf-8")).toContain("sk-value-a-123456");
    expect(readFileSync(join(CONFIG_DIR, ".env.skills"), "utf-8")).toContain("sk-value-b-123456");
    expect(stderr).toContain("Conflicting");
    expect(stderr).not.toContain("sk-value-a-123456");
    expect(stderr).not.toContain("sk-value-b-123456");
  });

  it("existing secret wins over differing plaintext (kept, cleaned, warning)", () => {
    writeFileSync(join(SECRET_DIR, "OPENAI_API_KEY"), "sk-stored-1234567890");
    writeFileSync(join(CONFIG_DIR, ".env"), "OPENAI_API_KEY=sk-plaintext-1234567890\n");
    const { stdout, stderr } = run(["OPENAI_API_KEY"]);
    expect(JSON.parse(stdout.trim())).toEqual({ OPENAI_API_KEY: "sk-stored-1234567890" });
    expect(readFileSync(join(CONFIG_DIR, ".env"), "utf-8")).not.toContain("sk-plaintext-1234567890");
    expect(stderr).toContain("Existing secret");
    expect(stderr).not.toContain("sk-plaintext-1234567890");
  });

  it("does not follow a symlinked secret file", () => {
    const outside = join(TEST_HOME, "outside-secret");
    writeFileSync(outside, "sk-outside-1234567890");
    try {
      symlinkSync(outside, join(SECRET_DIR, "OPENAI_API_KEY"));
    } catch {
      return; // symlinks unavailable on this platform
    }
    const { stdout } = run(["OPENAI_API_KEY"]);
    expect(JSON.parse(stdout.trim())).toEqual({ OPENAI_API_KEY: null });
    expect(readFileSync(outside, "utf-8")).toBe("sk-outside-1234567890");
  });

  it("keeps WEB_AUTH in .env untouched (documented exception)", () => {
    writeFileSync(join(CONFIG_DIR, ".env"), "WEB_AUTH=web-dashboard-token-123456\n");
    const { stdout } = run(["WEB_AUTH"]);
    expect(JSON.parse(stdout.trim())).toEqual({ WEB_AUTH: "web-dashboard-token-123456" });
    expect(existsSync(join(SECRET_DIR, "WEB_AUTH"))).toBe(false);
    expect(readFileSync(join(CONFIG_DIR, ".env"), "utf-8")).toContain("WEB_AUTH=web-dashboard-token-123456");
  });

  it("leaves pre-existing process.env credentials untouched when migration fails closed", () => {
    // R2.5: environment values that existed before dotenv loading (launchd /
    // shell overrides) must remain untouched even when migration rejects.
    writeFileSync(join(CONFIG_DIR, ".env"), "OPENAI_API_KEY=sk-file-1234567890\n");
    writeFileSync(join(CONFIG_DIR, ".env.skills"), "OPENAI_API_KEY=sk-file-other-1234567\n");
    const r = spawnSync("node", [
      "--import", "tsx/esm", "--import", "./src/boot/env.ts",
      "-e", `console.log(JSON.stringify({ OPENAI_API_KEY: process.env.OPENAI_API_KEY || null }))`,
    ], {
      encoding: "utf-8",
      env: isolatedChildEnv({
        ABTARS_HOME: TEST_HOME,
        OPENAI_API_KEY: "sk-operator-1234567890", // operator/service-manager override
      }),
      timeout: 10000,
      cwd: CWD,
    });
    // operator value survives; neither file value leaks into env
    expect(JSON.parse(r.stdout.trim())).toEqual({ OPENAI_API_KEY: "sk-operator-1234567890" });
  });

  it("does not migrate non-credential or malformed lines", () => {
    writeFileSync(join(CONFIG_DIR, ".env"), [
      "DEFAULT_PROVIDER=openrouter",
      "HA_URL=http://home.local",
      "BROKEN LINE no equals",
      "",
    ].join("\n"));
    const { stdout, stderr } = run(["DEFAULT_PROVIDER", "HA_URL"]);
    expect(JSON.parse(stdout.trim())).toEqual({ DEFAULT_PROVIDER: "openrouter", HA_URL: "http://home.local" });
    expect(readFileSync(join(CONFIG_DIR, ".env"), "utf-8")).toContain("BROKEN LINE no equals");
    expect(stderr).not.toContain("Migrated");
  });

  it("suppresses the value when the source rewrite fails (R3.6)", () => {
    // Secret commit succeeds (secret/ writable) but the .env rewrite fails
    // (config/ read-only) — the value must NOT be usable this boot.
    writeFileSync(join(CONFIG_DIR, ".env"), "OPENAI_API_KEY=sk-writefail-1234567890\n");
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(CONFIG_DIR, 0o500);
    let stdout = "";
    try {
      const r = spawnSync("node", [
        "--import", "tsx/esm", "--import", "./src/boot/env.ts",
        "-e", `console.log(JSON.stringify({ OPENAI_API_KEY: process.env.OPENAI_API_KEY || null }))`,
      ], {
        encoding: "utf-8",
        env: isolatedChildEnv({ ABTARS_HOME: TEST_HOME }),
        timeout: 10000,
        cwd: CWD,
      });
      stdout = r.stdout;
      // secret was committed for a later boot
      expect(existsSync(join(SECRET_DIR, "OPENAI_API_KEY"))).toBe(true);
      // plaintext still present (rewrite failed) — recovery possible
      expect(readFileSync(join(CONFIG_DIR, ".env"), "utf-8")).toContain("sk-writefail-1234567890");
    } finally {
      chmodSync(CONFIG_DIR, 0o700);
    }
    // R3.6: affected file-loaded credential unavailable this boot
    expect(JSON.parse(stdout.trim())).toEqual({ OPENAI_API_KEY: null });
  });
});
