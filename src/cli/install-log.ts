/**
 * install-log.ts — Append-only install/onboard log at ~/.abtars/logs/install.log
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let logPath: string | null = null;

export function initInstallLog(abtarsHome: string): void {
  const logsDir = join(abtarsHome, "logs");
  mkdirSync(logsDir, { recursive: true });
  logPath = join(logsDir, "install.log");
}

export function logInstall(line: string): void {
  if (!logPath) return;
  appendFileSync(logPath, line + "\n");
}

export function logInstallHeader(command: string): void {
  if (!logPath) return;
  appendFileSync(logPath, `\n=== abtars ${command} ${new Date().toISOString().slice(0, 16)} ===\n`);
}
