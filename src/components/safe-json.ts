/**
 * safe-json.ts — Defensive JSON file reader.
 * Returns fallback on any error (missing file, invalid JSON, wrong schema).
 */

import { readFileSync } from "node:fs";
import { logAndSwallow } from "./log-and-swallow.js";

const TAG = "safe_json";

/** Read and parse a JSON file. Returns fallback on any error. */
export function safeReadJson<T>(path: string, fallback: T): T {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return fallback;
    return parsed as T;
  } catch (err) {
    logAndSwallow(TAG, `safeReadJson ${path}`, err);
    return fallback;
  }
}
