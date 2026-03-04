import { readFileSync } from "node:fs";
import type { MessageRecord } from "../types/index.js";
import { logWarn, logError } from "./logger.js";

const TAG = "transcript-parser";

/**
 * Reads JSONL transcript files back into ordered MessageRecord arrays.
 * Malformed lines are skipped with a warning. File read errors return an empty array.
 */
export class TranscriptParser {
  /** Parse a JSONL file into an ordered array of MessageRecords. */
  parse(filePath: string): MessageRecord[] {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      logError(TAG, `Failed to read transcript file: ${filePath}`, err);
      return [];
    }

    const lines = raw.split("\n");
    const records: MessageRecord[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;

      try {
        const parsed = JSON.parse(trimmed) as MessageRecord;
        records.push(parsed);
      } catch {
        logWarn(TAG, `Skipping malformed line in ${filePath}: ${trimmed.slice(0, 100)}`);
      }
    }

    return records;
  }

  /** Parse only the last N records from a file (for restore). */
  parseTail(filePath: string, count: number): MessageRecord[] {
    const all = this.parse(filePath);
    if (count >= all.length) return all;
    return all.slice(-count);
  }
}
