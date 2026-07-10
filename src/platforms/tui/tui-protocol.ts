/**
 * tui-protocol.ts — Wire protocol for the TUI socket adapter (#1315).
 *
 * Newline-delimited JSON (JSONL), bidirectional over a unix-domain socket.
 * The bridge side speaks TuiServerFrame; the client side speaks TuiClientFrame.
 * Both sides use encodeFrame/createFrameDecoder for symmetric framing.
 *
 * v1 transport: whole-message frames only. `chunk`/`chunk-end` are defined in
 * the protocol but reserved and never sent — see design.md "Streaming (v1)".
 * They exist so #1319 (live mirroring) can extend without a protocol rewrite.
 */

export type TuiAttachMode =
  | { kind: "resume" }                                          // active tui session, or create Main (A)
  | { kind: "session"; index: number }                           // switch to existing tui session #index
  | { kind: "new"; sessionType: "A" | "B" | "C" }                // create a new tui session
  | { kind: "orc" };                                             // attach to the Orc session (query-only)

export type TuiClientFrame =
  | { t: "attach"; mode: TuiAttachMode; cols: number; rows: number }
  | { t: "input"; text: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "steer"; sessionId: string; instructionId: string; text: string };  // #1332: explicit steer intent

export type TuiServerFrame =
  | { t: "ready"; sessionLabel: string; sessionId: string }              // attach accepted
  | { t: "error"; message: string }                                       // attach/route rejected (fatal)
  | { t: "message"; role: "assistant" | "system"; markdown: string }     // v1: whole response
  | { t: "chunk"; id: string; delta: string }                             // RESERVED — see Streaming (v1)
  | { t: "chunk-end"; id: string }                                        // RESERVED — not emitted in v1
  | { t: "typing" }
  | { t: "steer-ack"; status: "queued" | "rejected" | "consumed" | "expired" | "failed"; instructionId: string; message: string };  // #1332: steer lifecycle

export function encodeFrame(f: TuiServerFrame | TuiClientFrame): string {
  return JSON.stringify(f) + "\n";
}

/**
 * Stateful line splitter — handles partial reads across socket chunks.
 * Returns 0+ complete frames per call; the buffer holds the partial remainder.
 *
 * Tolerates stray \r (Windows line endings) and a final partial line that
 * lacks a trailing newline (caller decides what to do with the tail —
 * usually waits for more data or a close).
 */
export function createFrameDecoder<T>(): (chunk: string) => T[] {
  let buffer = "";
  return (chunk: string): T[] => {
    if (chunk.length === 0) return [];
    buffer += chunk;
    const out: T[] = [];
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // Malformed frame — drop it. The protocol is JSONL; a single bad
        // frame must not poison the connection. Surface via a synthetic
        // error frame in callers that need to (the server uses this).
        continue;
      }
    }
    return out;
  };
}

/** True if the parsed frame looks like a TuiServerFrame (narrowing helper). */
export function isServerFrame(x: unknown): x is TuiServerFrame {
  if (typeof x !== "object" || x === null) return false;
  const t = (x as { t?: unknown }).t;
  return t === "ready" || t === "error" || t === "message" ||
         t === "chunk" || t === "chunk-end" || t === "typing" || t === "steer-ack";
}

/** True if the parsed frame looks like a TuiClientFrame (narrowing helper). */
export function isClientFrame(x: unknown): x is TuiClientFrame {
  if (typeof x !== "object" || x === null) return false;
  const t = (x as { t?: unknown }).t;
  return t === "attach" || t === "input" || t === "resize" || t === "steer";
}
