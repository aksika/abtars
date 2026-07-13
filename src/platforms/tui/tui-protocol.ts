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

// ── Wire limits (#1400) ─────────────────────────────────────────────────

/** Maximum encoded JSONL frame size (excluding newline). Matches outbound cap. */
export const MAX_TUI_FRAME_BYTES = 256 * 1024;

/** Maximum input text field size (UTF-8 bytes). */
export const MAX_INPUT_BYTES = 64 * 1024;

/** Maximum terminal dimension (cols, rows). */
export const MAX_TERMINAL_DIM = 1024;

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
  | { t: "chunk-end"; id: string; reason?: "complete" | "error" | "cancelled" | "truncated" }  // RESERVED — not emitted in v1
  | { t: "tool-start"; id: string; name: string }                       // #1338: bounded tool-start name
  | { t: "typing" }
  | { t: "steer-ack"; status: "queued" | "rejected" | "consumed" | "expired" | "failed"; instructionId: string; message: string }  // #1332: steer lifecycle
  // #1319: Orc activity
  | { t: "activity-snapshot"; sequence: number; snapshot: import("../components/orc-activity-snapshot.js").OrcActivitySnapshot }
  | { t: "activity"; sequence: number; event: import("../components/orc-activity-feed.js").OrcActivityEvent }
  | { t: "status"; status: import("./runtime-status.js").TuiRuntimeStatus };

export function encodeFrame(f: TuiServerFrame | TuiClientFrame): string {
  return JSON.stringify(f) + "\n";
}

// ── #1400: Bounded byte-oriented decoder ─────────────────────────────────

export type TuiFrameDecodeErrorCode = "overflow" | "internal";

export interface TuiFrameDecodeError {
  code: TuiFrameDecodeErrorCode;
  message: string;
  maxBytes: number;
}

export interface FrameDecoderOptions {
  maxFrameBytes?: number;
  onFatal?: (error: TuiFrameDecodeError) => void;
}

export interface FrameDecoder<T> {
  push(chunk: Buffer | Uint8Array): T[];
  close(): void;
  readonly failed: boolean;
  readonly bufferedBytes: number;
}

/**
 * Stateful bounded JSONL decoder. Accepts raw byte chunks, retains at most
 * `maxFrameBytes` between newlines, and invokes `onFatal` once on overflow.
 * After a fatal error no more frames are returned and all pushes are no-ops.
 */
export function createFrameDecoder<T>(options?: FrameDecoderOptions): FrameDecoder<T> {
  const maxBytes = options?.maxFrameBytes ?? MAX_TUI_FRAME_BYTES;
  let _failed = false;
  let _fatalCalled = false;
  let _remainder: Buffer | null = null;

  const decoder: FrameDecoder<T> = {
    get failed(): boolean { return _failed; },
    get bufferedBytes(): number { return _remainder?.length ?? 0; },

    close(): void {
      _remainder = null;
    },

    push(chunk: Buffer | Uint8Array): T[] {
      if (_failed) return [];
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      const combined = _remainder ? Buffer.concat([_remainder, buf]) : buf;
      _remainder = null;
      return processChunk(combined);
    },
  };

  function processChunk(chunk: Buffer): T[] {
    if (_failed) return [];
    const out: T[] = [];

    // Scan for newlines
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) {
        const lineLen = i - start;
        let end = i;
        if (end > start && chunk[end - 1] === 0x0d) {
          end--;
        }
        const lineLenNoCr = end - start;

        if (lineLenNoCr > maxBytes) {
          fatal(newLineTooLargeError(lineLenNoCr));
          return out;
        }

        if (lineLenNoCr > 0) {
          const line = chunk.slice(start, end).toString("utf-8");
          try {
            out.push(JSON.parse(line) as T);
          } catch {
            // Malformed bounded JSON — drop this frame
          }
        }
        start = i + 1;
      }
    }

    // Retain trailing remainder
    if (start < chunk.length) {
      _remainder = chunk.slice(start);
      if (_remainder.length > maxBytes) {
        const len = _remainder.length;
        _remainder = null;
        fatal(newLineTooLargeError(len));
        return out;
      }
    }

    return out;
  }

  function newLineTooLargeError(actual: number): TuiFrameDecodeError {
    return { code: "overflow", message: `Frame exceeds ${maxBytes} byte limit (found ${actual})`, maxBytes };
  }

  function fatal(error: TuiFrameDecodeError): void {
    _failed = true;
    _remainder = null;
    if (!_fatalCalled) {
      _fatalCalled = true;
      options?.onFatal?.(error);
    }
  }

  return decoder;
}

// ── #1400: Client-frame field validation ─────────────────────────────────

export interface FrameValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate a parsed client frame's fields before adapter dispatch.
 * Returns `{ ok: true }` or `{ ok: false, error }`.
 */
export function validateClientFrame(frame: TuiClientFrame): FrameValidationResult {
  switch (frame.t) {
    case "attach": {
      if (typeof frame.cols !== "number" || !Number.isFinite(frame.cols) || frame.cols < 1 || frame.cols > MAX_TERMINAL_DIM) {
        return { ok: false, error: `cols must be 1..${MAX_TERMINAL_DIM}` };
      }
      if (typeof frame.rows !== "number" || !Number.isFinite(frame.rows) || frame.rows < 1 || frame.rows > MAX_TERMINAL_DIM) {
        return { ok: false, error: `rows must be 1..${MAX_TERMINAL_DIM}` };
      }
      const mode = frame.mode;
      if (typeof mode !== "object" || mode === null) {
        return { ok: false, error: "mode must be an object" };
      }
      if (mode.kind === "resume" || mode.kind === "orc") {
        return { ok: true };
      }
      if (mode.kind === "session") {
        if (typeof (mode as { kind: "session"; index: unknown }).index !== "number" || !Number.isFinite((mode as { kind: "session"; index: number }).index)) {
          return { ok: false, error: "session mode requires finite index" };
        }
        return { ok: true };
      }
      if (mode.kind === "new") {
        const st = (mode as { kind: "new"; sessionType: unknown }).sessionType;
        if (st !== "A" && st !== "B" && st !== "C") {
          return { ok: false, error: 'new mode sessionType must be "A", "B", or "C"' };
        }
        return { ok: true };
      }
      return { ok: false, error: `unknown attach mode kind: ${(mode as { kind: string }).kind ?? "undefined"}` };
    }
    case "input": {
      if (typeof frame.text !== "string") {
        return { ok: false, error: "input text must be a string" };
      }
      if (Buffer.byteLength(frame.text, "utf8") > MAX_INPUT_BYTES) {
        return { ok: false, error: `input text exceeds ${MAX_INPUT_BYTES} byte limit` };
      }
      return { ok: true };
    }
    case "resize": {
      if (typeof frame.cols !== "number" || !Number.isFinite(frame.cols) || frame.cols < 1 || frame.cols > MAX_TERMINAL_DIM) {
        return { ok: false, error: `cols must be 1..${MAX_TERMINAL_DIM}` };
      }
      if (typeof frame.rows !== "number" || !Number.isFinite(frame.rows) || frame.rows < 1 || frame.rows > MAX_TERMINAL_DIM) {
        return { ok: false, error: `rows must be 1..${MAX_TERMINAL_DIM}` };
      }
      return { ok: true };
    }
    case "steer": {
      if (typeof frame.text !== "string" || !frame.text) {
        return { ok: false, error: "steer text must be a non-empty string" };
      }
      // #1399 limit (must match or be below MAX_INPUT_BYTES)
      if (Buffer.byteLength(frame.text, "utf8") > MAX_INPUT_BYTES) {
        return { ok: false, error: `steer text exceeds ${MAX_INPUT_BYTES} byte limit` };
      }
      if (typeof frame.instructionId !== "string") {
        return { ok: false, error: "steer instructionId must be a string" };
      }
      if (typeof frame.sessionId !== "string") {
        return { ok: false, error: "steer sessionId must be a string" };
      }
      return { ok: true };
    }
  }
}

/** True if the parsed frame looks like a TuiServerFrame (narrowing helper). */
export function isServerFrame(x: unknown): x is TuiServerFrame {
  if (typeof x !== "object" || x === null) return false;
  const t = (x as { t?: unknown }).t;
  return t === "ready" || t === "error" || t === "message" ||
         t === "chunk" || t === "chunk-end" || t === "typing" || t === "steer-ack" ||
         t === "activity-snapshot" || t === "activity" || t === "status";
}

/** True if the parsed frame looks like a TuiClientFrame (narrowing helper). */
export function isClientFrame(x: unknown): x is TuiClientFrame {
  if (typeof x !== "object" || x === null) return false;
  const t = (x as { t?: unknown }).t;
  return t === "attach" || t === "input" || t === "resize" || t === "steer";
}
