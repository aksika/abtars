/**
 * transport-utils.ts — Pure utility functions for the transport layer.
 * No I/O, no state, no side effects (except logging).
 */

import { logWarn } from "../logger.js";
import type { ToolCall } from "./conversation-session.js";

const TAG = "direct-api";

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

/** Extract HTTP status code from error message. Returns 0 if not found. */
export function parseErrorStatus(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /API error (\d+)/.exec(msg);
  return m ? parseInt(m[1]!, 10) : 0;
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
