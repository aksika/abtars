import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadAndValidateConfig } from "./config.js";
import { _resetEnv } from "./env-schema.js";
import * as fs from "node:fs/promises";

// Mock fs/promises so we don't hit the real filesystem
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  stat: vi.fn(),
  constants: { F_OK: 0, X_OK: 1 },
}));

// Mock dotenv so the real ~/.agentbridge/.env doesn't override test env vars
vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

/** Set up a valid env baseline; individual tests override specific vars. */
function setValidEnv() {
  process.env["TELEGRAM_BOT_TOKEN"] = "123456:ABC-DEF_ghi";
  process.env["MAIN_CHAT_ID"] = "111";
  process.env["AGENT_CLI_PATH"] = "kiro-cli";
  process.env["WORKING_DIR"] = process.cwd();
  delete process.env["TRUST_MODE"];
  delete process.env["PERMISSION_TIMEOUT_MS"];
  delete process.env["POLL_TIMEOUT_S"];
  delete process.env["AGENT_TRANSPORT"];
  delete process.env["TMUX_SESSION"];
  delete process.env["TMUX_CAPTURE_DELAY_SEC"];
  delete process.env["TMUX_MAX_WAIT_SEC"];
  delete process.env["LOG_LEVEL"];
  delete process.env["GROQ_API_KEY"];
  delete process.env["STT_ENABLED"];
  delete process.env["STT_MODEL"];
  delete process.env["TTS_ENABLED"];
  delete process.env["TTS_VOICE"];
  delete process.env["DISCORD_BOT_TOKEN"];
  delete process.env["DISCORD_A2A_CHANNEL_ID"];
  delete process.env["DISCORD_A2A_PEER_BOT_ID"];
  delete process.env["DISCORD_A2A_RATE_LIMIT_MS"];
}

describe("loadAndValidateConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetEnv();
    setValidEnv();
    // Default: stat returns a directory
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
  });

  it("returns a valid Config with all required fields", async () => {
    const config = await loadAndValidateConfig();
    expect(config.telegram.botToken).toBe("123456:ABC-DEF_ghi");
    expect(config.telegram.allowedUserIds.size).toBeGreaterThanOrEqual(1);
    expect(config.telegram.allowedUserIds.has(111)).toBe(true);
    expect(config.transport.agentCliPath).toBe("kiro-cli");
    expect(config.transport.workingDir).toBe(process.cwd());
    expect(config.transport.trustMode).toBe(false);
    expect(config.transport.permissionTimeoutMs).toBe(60_000);
    expect(config.telegram.pollTimeoutS).toBe(30);
  });

  // --- TELEGRAM_BOT_TOKEN ---

  it("logs error when TELEGRAM_BOT_TOKEN is missing but does not throw", async () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];
    const config = await loadAndValidateConfig();
    expect(config).toBeDefined(); // doesn't throw
  });

  it("logs error when TELEGRAM_BOT_TOKEN has invalid format but does not throw", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "not-a-valid-token";
    const config = await loadAndValidateConfig();
    expect(config).toBeDefined();
  });

  it("accepts a well-formed bot token", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "9876:xYz_123-abc";
    const config = await loadAndValidateConfig();
    expect(config.telegram.botToken).toBe("9876:xYz_123-abc");
  });

  // --- Users ---

  it("logs error when no users configured but does not throw", async () => {
    delete process.env["MAIN_CHAT_ID"];
    const { setUserRegistryOverride } = await import("./user-registry.js");
    setUserRegistryOverride({ users: [], byPlatformId: new Map(), byUserId: new Map() });
    try {
      const config = await loadAndValidateConfig();
      expect(config).toBeDefined();
    } finally {
      setUserRegistryOverride(null);
    }
  });



  // --- KIRO_CLI_PATH ---

  it("logs error when AGENT_CLI_PATH points to a non-executable file but does not throw", async () => {
    process.env["AGENT_CLI_PATH"] = "/usr/local/bin/kiro-cli";
    vi.mocked(fs.access).mockRejectedValue(new Error("EACCES"));
    const config = await loadAndValidateConfig();
    expect(config).toBeDefined();
  });

  it("accepts bare command names without filesystem check", async () => {
    process.env["AGENT_CLI_PATH"] = "kiro-cli";
    // access should NOT be called for bare commands
    const config = await loadAndValidateConfig();
    expect(config.transport.agentCliPath).toBe("kiro-cli");
  });

  // --- WORKING_DIR ---

  it("throws when WORKING_DIR is a file, not a directory", async () => {
    process.env["WORKING_DIR"] = "/some/file.txt";
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
    await expect(loadAndValidateConfig()).rejects.toThrow("WORKING_DIR");
  });

  // --- TRUST_MODE ---

  it("parses TRUST_MODE=true", async () => {
    process.env["TRUST_MODE"] = "true";
    const config = await loadAndValidateConfig();
    expect(config.transport.trustMode).toBe(true);
  });

  it("parses TRUST_MODE=1 as true", async () => {
    process.env["TRUST_MODE"] = "1";
    const config = await loadAndValidateConfig();
    expect(config.transport.trustMode).toBe(true);
  });

  it("parses TRUST_MODE=false as false", async () => {
    process.env["TRUST_MODE"] = "false";
    const config = await loadAndValidateConfig();
    expect(config.transport.trustMode).toBe(false);
  });

  // --- PERMISSION_TIMEOUT_MS ---

  it("parses PERMISSION_TIMEOUT_MS as a number", async () => {
    process.env["PERMISSION_TIMEOUT_MS"] = "30000";
    const config = await loadAndValidateConfig();
    expect(config.transport.permissionTimeoutMs).toBe(30_000);
  });

  it("throws when PERMISSION_TIMEOUT_MS is not a number", async () => {
    process.env["PERMISSION_TIMEOUT_MS"] = "abc";
    _resetEnv();
    await expect(loadAndValidateConfig()).rejects.toThrow("PERMISSION_TIMEOUT_MS");
  });

  // --- POLL_TIMEOUT_S ---

  it("parses POLL_TIMEOUT_S as a number", async () => {
    process.env["POLL_TIMEOUT_S"] = "60";
    const config = await loadAndValidateConfig();
    expect(config.telegram.pollTimeoutS).toBe(60);
  });

  it("throws when POLL_TIMEOUT_S is not a number", async () => {
    process.env["POLL_TIMEOUT_S"] = "nope";
    _resetEnv();
    await expect(loadAndValidateConfig()).rejects.toThrow("POLL_TIMEOUT_S");
  });
});
