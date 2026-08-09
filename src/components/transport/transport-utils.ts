/**
 * transport-utils.ts — Pure utility functions for the transport layer.
 * No I/O, no state, no side effects (except logging).
 */

import { logWarn } from "../logger.js";
import type { LegacyToolCall as ToolCall } from "./pi-ai-adapter.js";

const TAG = "pi-ai";

/**
 * Normalize tool calls from models that fragment a single call across multiple entries.
 * Pattern: [name="execute_bash" args="{}"], [name="" args=""], [name="" args='{"command":"..."}']
 * Fix: merge next unnamed entry's args into preceding named entry. Drop remaining unnamed.
 */
export function normalizeToolCalls(raw: ToolCall[]): ToolCall[] {
  if (raw.length <= 1) return raw;

  const result: ToolCall[] = [];
  for (let i = 0; i < raw.length; i++) {
    const tc = raw[i]!;
    if (tc.function.name) {
      if (!tc.function.arguments || tc.function.arguments === "{}") {
        // Look ahead for the next unnamed entry with real args
        for (let j = i + 1; j < raw.length; j++) {
          const next = raw[j]!;
          if (next.function.name) break; // hit another named entry, stop
          if (next.function.arguments && next.function.arguments !== "{}") {
            tc.function.arguments = next.function.arguments;
            i = j; // skip all entries up to and including the merged one
            break;
          }
        }
      }
      result.push(tc);
    }
  }

  if (result.length !== raw.length) {
    logWarn(TAG, `Normalized ${raw.length} tool call entries → ${result.length} (model fragmentation): ${raw.map(tc => `${tc.function.name || "(unnamed)"}(${tc.function.arguments.slice(0, 60)})`).join(", ")}`);
  }
  return result;
}

/**
 * Extract an HTTP status code from provider errors. Returns 0 if not found.
 *
 * Pi-AI emits more than one stable shape depending on the API adapter:
 * `402: <body>`, `OpenAI API error (402): <body>`, and SDK errors carrying a
 * numeric `status`/`statusCode` field. Keep the parsing here so the fallback
 * layer does not need provider-specific knowledge.
 */
export function parseErrorStatus(err: unknown): number {
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    for (const key of ["status", "statusCode"]) {
      const value = record[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
      if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
    }
  }

  const msg = err instanceof Error ? err.message : String(err);
  const patterns = [
    /^\s*(\d{3})\s*:/,
    /\bAPI error\s*\(?\s*(\d{3})\b/i,
    /\bHTTP\s*(\d{3})\b/i,
    /\b(\d{3})\s+status code\b/i,
    /\bstatus(?:Code)?\s*[=:]\s*(\d{3})\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(msg);
    if (match) return Number(match[1]);
  }
  return 0;
}

/** Extract Retry-After from error (seconds or date). Returns ms or undefined. */
export function parseRetryAfter(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const jsonMatch = /retry[_-]after["\s:]+(\d+(?:\.\d+)?)/i.exec(msg);
  if (jsonMatch) return Math.ceil(parseFloat(jsonMatch[1]!) * 1000);
  const resetMatch = /x-ratelimit-reset["\s:]+(\d{10,13})/i.exec(msg);
  if (resetMatch) {
    const ts = parseInt(resetMatch[1]!, 10);
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const delta = ms - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

/** Detect "day/week/month limit" in error message and return cooldown ms. */
export function parseUsageLimitCooldown(message: string): number | undefined {
  const lower = message.toLowerCase();
  if (!lower.includes("limit")) return undefined;
  if (lower.includes("day")) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow.getTime() - Date.now();
  }
  if (lower.includes("week")) {
    const now = new Date();
    const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
    const monday = new Date(now);
    monday.setDate(monday.getDate() + daysUntilMonday);
    monday.setHours(0, 0, 0, 0);
    return monday.getTime() - Date.now();
  }
  if (lower.includes("month")) {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return nextMonth.getTime() - Date.now();
  }
  return undefined;
}
