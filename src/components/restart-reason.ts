import { localISO } from "../utils/local-time.js";
/**
 * Restart reason tracking — writes/reads `.last-restart-reason` so the agent
 * knows why the previous session ended.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";

const REASON_FILE = join(agentBridgeHome(), ".last-restart-reason");

export type RestartCause =
  | "daily-cycle"
  | "deploy"
  | "user-reset"
  | "watchdog-silent"
  | "watchdog-endless"
  | "ctx-overflow"
  | "manual";

export function writeRestartReason(reason: string): void {
  writeFileSync(REASON_FILE, `${localISO()} ${reason}\n`);
}

export function readAndClearRestartReason(): string | null {
  if (!existsSync(REASON_FILE)) return null;
  try {
    const content = readFileSync(REASON_FILE, "utf-8").trim();
    unlinkSync(REASON_FILE);
    return content;
  } catch { return null; }
}
