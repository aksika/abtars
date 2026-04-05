import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";

/** Log levels: OFF = silent, LOW = operational info, DEBUG = everything */
export type LogLevel = "off" | "low" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = { off: 0, low: 1, debug: 2 };
const LOG_DIR = join(agentBridgeHome(), "logs");

/** Get today's log filename: bridge-YYYY-MM-DD.log */
export function getLogFile(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return join(LOG_DIR, `bridge-${date}.log`);
}

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
    appendFileSync(getLogFile(), line + "\n");
  } catch {
    // silently ignore file write errors
  }
}

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

function ts(): string {
  const d = new Date();
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const local = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  return isTest ? `${local} TEST` : local;
}

/** Local ISO-ish timestamp for user-facing messages. */
export function localIso(): string {
  const d = new Date();
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

let logFormat: "text" | "json" = (process.env["LOG_FORMAT"] as "json" | undefined) === "json" ? "json" : "text";

export function setLogFormat(fmt: "text" | "json"): void { logFormat = fmt; }

function formatLine(level: string, tag: string, msg: string): string {
  if (logFormat === "json") {
    return JSON.stringify({ ts: ts(), level, tag, msg });
  }
  return `${ts()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
}

/** LOW: operational milestones — startup, connections, errors */
export function logInfo(tag: string, msg: string): void {
  if (!shouldLog("low")) return;
  const line = formatLine("info", tag, msg);
  console.log(`[${tag}] ${msg}`);
  writeToFile(line);
}

/** LOW: warnings */
export function logWarn(tag: string, msg: string): void {
  if (!shouldLog("low")) return;
  const line = formatLine("warn", tag, msg);
  console.warn(`[${tag}] ${msg}`);
  writeToFile(line);
}

/** LOW: errors (always shown unless OFF) */
export function logError(tag: string, msg: string, err?: unknown): void {
  if (!shouldLog("low")) return;
  const errStr = err instanceof Error ? err.message : String(err ?? "");
  const fullMsg = errStr ? `${msg} — ${errStr}` : msg;
  const line = formatLine("error", tag, fullMsg);
  if (err) console.error(`[${tag}] ${msg}`, err);
  else console.error(`[${tag}] ${msg}`);
  writeToFile(line);
}

/** DEBUG: message content, full payloads, verbose tracing */
export function logDebug(tag: string, msg: string): void {
  if (!shouldLog("debug")) return;
  const line = formatLine("debug", tag, msg);
  console.log(`[${tag}] ${msg}`);
  writeToFile(line);
}
