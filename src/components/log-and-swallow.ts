/**
 * log-and-swallow.ts — Visible error swallowing.
 * Replaces silent `} catch { }` blocks with a trace-level log.
 */

import { logTrace, logWarn, logError } from "./logger.js";

type SwallowLevel = "trace" | "warn" | "error";

/** Log a swallowed error and return undefined. Default level: trace. */
export function logAndSwallow(tag: string, context: string, err?: unknown, level: SwallowLevel = "trace"): undefined {
  const msg = `[swallowed] ${context}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ""}`;
  if (level === "error") logError(tag, msg);
  else if (level === "warn") logWarn(tag, msg);
  else logTrace(tag, msg);
  return undefined;
}
