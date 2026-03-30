import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadAndValidateConfig } from "./config.js";
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
  process.env["ALLOWED_USER_IDS"] = "111,222";
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
  delete process.env["DISCORD_ALLOWED_USER_IDS"];
  delete process.env["DISCORD_ALLOWED_CHANNEL_IDS"];
  delete process.env["DISCORD_A2A_CHANNEL_ID"];
  delete process.env["DISCORD_A2A_PEER_BOT_ID"];
  delete process.env["DISCORD_A2A_RATE_LIMIT_MS"];
}

describe("loadAndValidateConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setValidEnv();
    // Default: stat returns a directory
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
  });

  it("returns a valid Config with all required fields", async () => {
    const config = await loadAndValidateConfig();
    expect(config.telegramBotToken).toBe("123456:ABC-DEF_ghi");
    expect(config.allowedUserIds).toEqual(new Set([111, 222]));
    expect(config.agentCliPath).toBe("kiro-cli");
    expect(config.workingDir).toBe(process.cwd());
    expect(config.trustMode).toBe(false);
    expect(config.permissionTimeoutMs).toBe(60_000);
    expect(config.pollTimeoutS).toBe(30);
  });

  // --- TELEGRAM_BOT_TOKEN ---

  it("throws when TELEGRAM_BOT_TOKEN is missing", async () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];
    await expect(loadAndValidateConfig()).rejects.toThrow("TELEGRAM_BOT_TOKEN");
  });

  it("throws when TELEGRAM_BOT_TOKEN has invalid format", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "not-a-valid-token";
    await expect(loadAndValidateConfig()).rejects.toThrow("TELEGRAM_BOT_TOKEN");
  });

  it("accepts a well-formed bot token", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "9876:xYz_123-abc";
    const config = await loadAndValidateConfig();
    expect(config.telegramBotToken).toBe("9876:xYz_123-abc");
  });

  // --- ALLOWED_USER_IDS ---

  it("throws when ALLOWED_USER_IDS is missing", async () => {
    delete process.env["ALLOWED_USER_IDS"];
    await expect(loadAndValidateConfig()).rejects.toThrow("ALLOWED_USER_IDS");
  });

  it("throws when ALLOWED_USER_IDS has no valid numeric IDs", async () => {
    process.env["ALLOWED_USER_IDS"] = "abc, , xyz";
    await expect(loadAndValidateConfig()).rejects.toThrow("ALLOWED_USER_IDS");
  });

  it("trims whitespace and ignores empty segments in user IDs", async () => {
    process.env["ALLOWED_USER_IDS"] = " 42 , , 99 ";
    const config = await loadAndValidateConfig();
    expect(config.allowedUserIds).toEqual(new Set([42, 99]));
  });

  // --- KIRO_CLI_PATH ---

  it("throws when AGENT_CLI_PATH points to a non-executable file", async () => {
    process.env["AGENT_CLI_PATH"] = "/usr/local/bin/kiro-cli";
    vi.mocked(fs.access).mockRejectedValue(new Error("EACCES"));
    await expect(loadAndValidateConfig()).rejects.toThrow("CLI binary");
  });

  it("accepts bare command names without filesystem check", async () => {
    process.env["AGENT_CLI_PATH"] = "kiro-cli";
    // access should NOT be called for bare commands
    const config = await loadAndValidateConfig();
    expect(config.agentCliPath).toBe("kiro-cli");
  });

  // --- WORKING_DIR ---

  it("throws when WORKING_DIR does not exist", async () => {
    process.env["WORKING_DIR"] = "/nonexistent/path";
    vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT"));
    await expect(loadAndValidateConfig()).rejects.toThrow("WORKING_DIR");
  });

  it("throws when WORKING_DIR is a file, not a directory", async () => {
    process.env["WORKING_DIR"] = "/some/file.txt";
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
    await expect(loadAndValidateConfig()).rejects.toThrow("WORKING_DIR");
  });

  // --- TRUST_MODE ---

  it("parses TRUST_MODE=true", async () => {
    process.env["TRUST_MODE"] = "true";
    const config = await loadAndValidateConfig();
    expect(config.trustMode).toBe(true);
  });

  it("parses TRUST_MODE=1 as true", async () => {
    process.env["TRUST_MODE"] = "1";
    const config = await loadAndValidateConfig();
    expect(config.trustMode).toBe(true);
  });

  it("parses TRUST_MODE=false as false", async () => {
    process.env["TRUST_MODE"] = "false";
    const config = await loadAndValidateConfig();
    expect(config.trustMode).toBe(false);
  });

  // --- PERMISSION_TIMEOUT_MS ---

  it("parses PERMISSION_TIMEOUT_MS as a number", async () => {
    process.env["PERMISSION_TIMEOUT_MS"] = "30000";
    const config = await loadAndValidateConfig();
    expect(config.permissionTimeoutMs).toBe(30_000);
  });

  it("falls back to default when PERMISSION_TIMEOUT_MS is not a number", async () => {
    process.env["PERMISSION_TIMEOUT_MS"] = "abc";
    const config = await loadAndValidateConfig();
    expect(config.permissionTimeoutMs).toBe(60000);
  });

  // --- POLL_TIMEOUT_S ---

  it("parses POLL_TIMEOUT_S as a number", async () => {
    process.env["POLL_TIMEOUT_S"] = "60";
    const config = await loadAndValidateConfig();
    expect(config.pollTimeoutS).toBe(60);
  });

  it("falls back to default when POLL_TIMEOUT_S is not a number", async () => {
    process.env["POLL_TIMEOUT_S"] = "nope";
    const config = await loadAndValidateConfig();
    expect(config.pollTimeoutS).toBe(30);
  });
});
