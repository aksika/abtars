/**
 * jsonl-reader.ts — strict LF-only JSONL framing for the supervised Pi RPC
 * stream (#1406).
 *
 * Pi defines an LF-only JSONL framing contract: records are separated by byte
 * 0x0A. Node's `readline` treats U+2028/U+2029 (valid inside JSON strings) as
 * line terminators, which corrupts framing. This reader:
 *   - splits only on LF (0x0A) at the byte level;
 *   - strips exactly one trailing CR for CRLF input;
 *   - preserves U+2028/U+2029 inside JSON strings;
 *   - retains partial records between stream chunks and accepts multiple
 *     records per chunk;
 *   - enforces a byte bound while accumulating so a partial frame cannot grow
 *     unboundedly;
 *   - discards oversized input through the next LF and resumes cleanly.
 *
 * Multibyte UTF-8 sequences never contain 0x0A, so decoding with
 * StringDecoder and splitting on "\n" is byte-equivalent.
 */

import { StringDecoder } from "node:string_decoder";

export interface JsonlReaderCallbacks {
  /** Deliver one complete, bounded record (trailing CR already stripped). */
  onRecord(record: string): void;
  /** Oversized or malformed frame dropped — bounded reason and byte count. */
  onDiscarded(reason: "oversized" | "partial_overflow" | "incomplete_at_eof", bytes: number): void;
}

export class JsonlReader {
  private readonly decoder = new StringDecoder("utf-8");
  private buffer = "";
  private discardUntilLf = false;
  private readonly callbacks: JsonlReaderCallbacks;
  private readonly maxLineBytes: number;

  constructor(callbacks: JsonlReaderCallbacks, maxLineBytes: number) {
    this.callbacks = callbacks;
    this.maxLineBytes = maxLineBytes;
  }

  /** Feed a stream chunk. Complete LF-terminated records are delivered. */
  push(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    this.buffer += text;

    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (this.discardUntilLf) {
        // Recovering from a previously oversized frame — this record is
        // part of the discarded run.
        this.discardUntilLf = false;
        idx = this.buffer.indexOf("\n");
        continue;
      }

      const bytes = Buffer.byteLength(line, "utf-8");
      if (bytes > this.maxLineBytes) {
        // Complete record already consumed (including its LF) — drop it and
        // continue; only a partial overflow needs discard-until-LF.
        this.callbacks.onDiscarded("oversized", bytes);
      } else if (line.length > 0 || bytes > 0) {
        this.callbacks.onRecord(line);
      }
      idx = this.buffer.indexOf("\n");
    }

    // Bound the partial record: an attacker must not grow the accumulator
    // without a terminator.
    const partialBytes = Buffer.byteLength(this.buffer, "utf-8");
    if (partialBytes > this.maxLineBytes) {
      this.callbacks.onDiscarded("partial_overflow", partialBytes);
      this.buffer = "";
      this.discardUntilLf = true;
    }
  }

  /**
   * Stream end: any incomplete record is dropped (no further data can
   * complete it). Deterministic — call exactly once during close.
   */
  flush(): void {
    this.decoder.end();
    if (this.buffer.length > 0) {
      this.callbacks.onDiscarded("incomplete_at_eof", Buffer.byteLength(this.buffer, "utf-8"));
    }
    this.buffer = "";
    this.discardUntilLf = false;
  }
}
