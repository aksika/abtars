/**
 * install-validate.ts — Post-install healthcheck.
 * Validates minimum viability BEFORE first boot.
 * Runs ONCE at end of install, not on every boot.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate that the installed config has at least one viable operator channel.
 * Returns errors if not — caller decides whether to exit or warn.
 */
export function validateMinimumViability(configDir: string): ValidationResult {
  const errors: string[] = [];

  // Read .env file — if no .env exists, skip validation (not configured yet, onboard will handle)
  const envPath = join(configDir, ".env");
  if (!existsSync(envPath)) return { ok: true, errors: [] };

  const envVars = new Map<string, string>();
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) envVars.set(match[1]!, match[2]!.replace(/^["']|["']$/g, ""));
  }

  const mainChatId = envVars.get("MAIN_CHAT_ID");
  const provider = envVars.get("MAIN_CHAT_PROVIDER") ?? "telegram";
  const tgToken = envVars.get("TELEGRAM_BOT_TOKEN");
  const dcToken = envVars.get("DISCORD_BOT_TOKEN");

  // Must have MAIN_CHAT_ID
  if (!mainChatId) {
    errors.push("MAIN_CHAT_ID not set (operator delivery address)");
  }

  // Must have the matching platform token
  if (provider === "telegram" && !tgToken) {
    errors.push("TELEGRAM_BOT_TOKEN not set (required for MAIN_CHAT_PROVIDER=telegram)");
  } else if (provider === "discord" && !dcToken) {
    errors.push("DISCORD_BOT_TOKEN not set (required for MAIN_CHAT_PROVIDER=discord)");
  }

  // At least one platform token must exist
  if (!tgToken && !dcToken) {
    errors.push("No platform token configured (need TELEGRAM_BOT_TOKEN or DISCORD_BOT_TOKEN)");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Format validation failure as a user-friendly error message.
 */
export function formatValidationError(result: ValidationResult, invocation: string): string {
  const lines = [
    "❌ Install incomplete: no viable operator channel configured.",
    "",
    "Missing:",
    ...result.errors.map(e => `  • ${e}`),
    "",
    "Configure ONE of:",
    "  1. Telegram: TELEGRAM_BOT_TOKEN + MAIN_CHAT_ID",
    "  2. Discord:  DISCORD_BOT_TOKEN + MAIN_CHAT_ID + MAIN_CHAT_PROVIDER=discord",
    "",
    `Then re-run: ${invocation}`,
  ];
  return lines.join("\n");
}
