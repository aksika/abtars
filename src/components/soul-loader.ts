import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logWarn } from "./logger.js";

const TAG = "soul-loader";
const CORE_DIR = join(homedir(), ".agentbridge", "core");

/**
 * Load all core files (SOUL.md, TOOLS.md, user_profile.md, agent_notes.md)
 * and concatenate into a single injection string.
 * Logs warning for missing files but never throws.
 */
export function loadSoulBundle(): string | null {
  try {
    const files = readdirSync(CORE_DIR).filter(f => f.endsWith(".md")).sort();
    if (files.length === 0) {
      logWarn(TAG, `No .md files in ${CORE_DIR}`);
      return null;
    }
    const parts: string[] = [];
    for (const f of files) {
      try {
        parts.push(readFileSync(join(CORE_DIR, f), "utf-8").trim());
      } catch (err) {
        logWarn(TAG, `Failed to read ${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
  } catch (err) {
    logWarn(TAG, `Core dir not found (${CORE_DIR}): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
