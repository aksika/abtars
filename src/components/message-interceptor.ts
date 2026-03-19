/**
 * Large message interception — safety net for A2A / Browsie oversized payloads.
 *
 * If a message exceeds the threshold, the full content is written to a file
 * and the message body is replaced with a truncated preview + file path.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_BRIDGE_HOME } from "./config.js";
import { logInfo } from "./logger.js";

const TAG = "MessageInterceptor";
const OVERFLOW_DIR = join(AGENT_BRIDGE_HOME, "overflow");
const DEFAULT_THRESHOLD = 8000;
const PREVIEW_LENGTH = 500;

export interface InterceptResult {
  text: string;
  intercepted: boolean;
  filePath?: string;
}

/**
 * If `text` exceeds `threshold` chars, write full content to a file and
 * return a truncated preview with the file path. Otherwise return as-is.
 */
export function interceptLargeMessage(
  text: string,
  threshold = DEFAULT_THRESHOLD,
): InterceptResult {
  if (text.length <= threshold) {
    return { text, intercepted: false };
  }

  mkdirSync(OVERFLOW_DIR, { recursive: true });
  const filename = `overflow_${Date.now()}.md`;
  const filePath = join(OVERFLOW_DIR, filename);
  writeFileSync(filePath, text, "utf-8");

  const preview = text.slice(0, PREVIEW_LENGTH);
  const replaced = `${preview}\n\n---\n⚠️ Message truncated (${text.length} chars). Full content saved to: ${filePath}`;

  logInfo(TAG, `Intercepted oversized message (${text.length} chars) → ${filePath}`);
  return { text: replaced, intercepted: true, filePath };
}
