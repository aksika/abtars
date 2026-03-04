import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

/** Log levels: OFF = silent, LOW = operational info, DEBUG = everything */
export type LogLevel = "off" | "low" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = { off: 0, low: 1, debug: 2 };
const LOG_DIR = resolve(homedir(), ".agentbridge", "logs");
const LOG_FILE = resolve(LOG_DIR, "bridge.log");

let currentLevel: LogLevel = "low";
let fileLogging = true;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setFileLogging(enabled: boolean): void {
  fileLogging = enabled;
}

function shouldLog(minLevel: LogLevel): boolean {
  return LEVEL_ORDER[currentLevel] >= LEVEL_ORDER[minLevel];
}

function writeToFile(line: string): void {
  if (!fileLogging) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // silently ignore file write errors
  }
}

function ts(): string {
  return new Date().toISOString();
}

/** LOW: operational milestones — startup, connections, errors */
export function logInfo(tag: string, msg: string): void {
  if (!shouldLog("low")) return;
  const line = `${ts()} INFO  [${tag}] ${msg}`;
  console.log(`[${tag}] ${msg}`);
  writeToFile(line);
}

/** LOW: warnings */
export function logWarn(tag: string, msg: string): void {
  if (!shouldLog("low")) return;
  const line = `${ts()} WARN  [${tag}] ${msg}`;
  console.warn(`[${tag}] ${msg}`);
  writeToFile(line);
}

/** LOW: errors (always shown unless OFF) */
export function logError(tag: string, msg: string, err?: unknown): void {
  if (!shouldLog("low")) return;
  const errStr = err instanceof Error ? err.message : String(err ?? "");
  const line = `${ts()} ERROR [${tag}] ${msg}${errStr ? " — " + errStr : ""}`;
  if (err) console.error(`[${tag}] ${msg}`, err);
  else console.error(`[${tag}] ${msg}`);
  writeToFile(line);
}

/** DEBUG: message content, full payloads, verbose tracing */
export function logDebug(tag: string, msg: string): void {
  if (!shouldLog("debug")) return;
  const line = `${ts()} DEBUG [${tag}] ${msg}`;
  console.log(`[${tag}] ${msg}`);
  writeToFile(line);
}
