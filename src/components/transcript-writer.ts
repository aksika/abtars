import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { MessageRecord } from "../types/index.js";
import { logError } from "./logger.js";

const TAG = "transcript-writer";

/**
 * Appends MessageRecord objects as JSON lines to JSONL transcript files on disk.
 * Files are organized as {baseDir}/transcripts/{chatId}/{sessionId}.jsonl.
 * All I/O errors are caught and logged — this class never throws.
 */
export class TranscriptWriter {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Append a message record as a single JSON line to the transcript file. */
  append(record: MessageRecord): void {
    try {
      const filePath = this.getPath(record.chatId, record.sessionId);
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, JSON.stringify(record) + "\n");
    } catch (err) {
      logError(TAG, "Failed to append transcript record", err);
    }
  }

  /** Get the file path for a given chat/session transcript. */
  getPath(chatId: number, sessionId: string): string {
    return resolve(this.baseDir, "transcripts", String(chatId), `${sessionId}.jsonl`);
  }
}
