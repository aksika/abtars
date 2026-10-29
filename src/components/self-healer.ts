/**
 * self-healer.ts — bounded log cursor/source adapter (#1688 Task 8).
 *
 * The scanner keeps its cursor, rotation, truncation, partial-line, and
 * bounded-read behavior, but no longer owns agent state, clones source trees,
 * dispatches `H` sessions, or executes known commands. Every ERROR record is
 * emitted as a typed `LogFailureEvent` through the injected source callback;
 * classification, admission, and execution belong to the SHA coordinator.
 */
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { getLogFile } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import type { HeartbeatTask, HeartbeatTaskOutcome } from "../types/index.js";
import type { LogFailureEvent } from "./sha/sha-types.js";

const TAG = "self-healer";
const MAX_READ_BYTES = 1_048_576;

type LogCursor = {
  path: string;
  inode: number;
  offset: number;
  partial: string;
};

export type LogSourceCallback = (event: LogFailureEvent) => void;

export function createSelfHealerTask(onSignal: LogSourceCallback): HeartbeatTask {
  let logCursor: LogCursor | null = null;

  const task: HeartbeatTask = {
    name: "self-healer",
    execute: async (): Promise<HeartbeatTaskOutcome> => {
      const logFile = getLogFile();
      try {
        const content = readIncremental(logFile);
        if (!content) return { state: "idle" };

        const lines = content.split("\n");
        let evaluatedCount = 0;
        let lineStart = logCursor?.offset !== undefined
          ? logCursor.offset - content.length
          : 0;
        const baseOffset = logCursor?.offset !== undefined ? logCursor.offset - content.length : 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          lineStart = i === 0 ? baseOffset : lineStart + lines[i - 1]!.length + 1;
          if (line.length < 24 || !line.includes(" ERROR ")) continue;
          if (line.includes("TEST ")) continue;

          const match = line.match(/\[([^\]]+)\] (.+)/);
          if (!match) continue;
          evaluatedCount++;

          const raw = match[2]!;
          onSignal({
            source: "log",
            component: "abtars",
            tag: match[1]!,
            logPath: logFile,
            inode: logCursor?.inode ?? -1,
            lineOffset: lineStart,
            normalizedMessage: raw.slice(0, 512),
            occurredAt: Date.now(),
            evidence: raw.slice(0, 2048),
          });
        }

        return evaluatedCount > 0
          ? { state: "ran", detail: `evaluated ${evaluatedCount} error line(s)` }
          : { state: "idle" };
      } catch (err) {
        logAndSwallow(TAG, "op", err);
        return { state: "idle" };
      }
    },
  };

  function readIncremental(logFile: string): string | null {
    try {
      const st = statSync(logFile);
      if (!logCursor) {
        logCursor = {
          path: logFile,
          inode: st.ino,
          offset: Math.max(0, st.size),
          partial: "",
        };
        return null;
      }
      if (logCursor.path !== logFile || st.ino !== logCursor.inode || st.size < logCursor.offset) {
        logCursor = {
          path: logFile,
          inode: st.ino,
          offset: 0,
          partial: "",
        };
      }

      if (st.size <= logCursor.offset) return null;

      const toRead = Math.min(st.size - logCursor.offset, MAX_READ_BYTES);
      const buf = Buffer.alloc(toRead);
      const fd = openSync(logFile, "r");
      try {
        const bytesRead = readSync(fd, buf, 0, toRead, logCursor.offset);
        logCursor.offset += bytesRead;
        const raw = logCursor.partial + buf.toString("utf-8", 0, bytesRead);
        const lastNewline = raw.lastIndexOf("\n");
        if (lastNewline === -1) {
          logCursor.partial = raw;
          return null;
        }
        const complete = raw.slice(0, lastNewline);
        logCursor.partial = raw.slice(lastNewline + 1);
        return complete;
      } finally {
        try { closeSync(fd); } catch (err) { logAndSwallow(TAG, "close log file descriptor", err); }
      }
    } catch {
      logCursor = null;
      return null;
    }
  }

  return task;
}

/** #1688 R3: recursion-tag suppression happens in the classifier; this helper
 *  exists for tests asserting the source never emits for those tags. */
export function isRecursionTag(tag: string): boolean {
  return tag.includes("self-healer") || tag.includes("self_healer") || tag.includes("sha-") || tag.includes("watchdog");
}