/**
 * tui-ui.ts — abtars-owned TUI render shell for `abtars tui` (#1612).
 *
 * Composes PUBLIC presentation components from the installed
 * `@earendil-works/pi-coding-agent` package (theme, user/assistant message
 * roles, dynamic borders) with abtars-owned `pi-tui` containers, and feeds
 * them data from the JSONL socket. Pi never receives an abtars session or
 * transport object; the bridge remains headless and never imports these
 * packages (enforced by the daemon-side module boundary).
 *
 * TuiApp owns:
 *   - the render tree regions (header, activity, busy, transcript, editor,
 *     footer) built under the command-owned `TUI` root;
 *   - attachment-local stream/execution grouping and whole-result
 *     reconciliation (bounded: 4 executions, 20 streams, 64 KiB text);
 *   - safe activity projection (IDs/kinds/status only, 100-row bound);
 *   - footer updates from the already-sanitized `TuiRuntimeStatus`; and
 *   - lifecycle reset on authoritative `ready` and idempotent `dispose`.
 *
 * Terminal/socket/exit ownership stays in `tui.ts` (design §6).
 */

import type { OrcActivitySnapshot, ActivityCard } from "../../components/orc-activity-snapshot.js";
import type { OrcActivityEvent } from "../../components/orc-activity-feed.js";
import type { TuiServerFrame } from "../../platforms/tui/tui-protocol.js";
import type { TuiRuntimeStatus, TuiUsageSnapshot } from "../../platforms/tui/runtime-status.js";

// ── Public module seam (design §1.2) ─────────────────────────────────────
//
// Pi 0.84: the runtime `TUI` constructor no longer exists — `TUI` is a
// TypeScript interface only. The concrete renderer is `TuiMainScreen`; the
// `TUI` type remains the structural contract for the root UI below.

export interface TuiPresentationModules {
  tui: Pick<typeof import("@earendil-works/pi-tui"),
    "ProcessTerminal" | "TuiMainScreen" | "Container" | "Editor" | "Text" |
    "Markdown" | "Loader" | "matchesKey">;
  codingAgent: Pick<typeof import("@earendil-works/pi-coding-agent"),
    "initTheme" | "getMarkdownTheme" | "getSelectListTheme" |
    "UserMessageComponent" | "AssistantMessageComponent" | "DynamicBorder">;
}

// ── Bounds (design §2) ───────────────────────────────────────────────────

const MAX_EXECUTION_GROUPS = 4;
const MAX_STREAMS_PER_EXECUTION = 20;
const MAX_COMPARISON_BYTES = 64 * 1024;
const MAX_ACTIVITY_ROWS = 100;
const MAX_SYSTEM_TEXT_BYTES = 2 * 1024;
/** #1319 R5: discussion keeps its own newest bounded window. */
const MAX_DISCUSSION_ROWS = 50;

// ── Footer formatting (#1355 contract) ───────────────────────────────────

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function formatUsage(usage?: TuiUsageSnapshot): string[] {
  if (!usage) return [];
  const parts = [`↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`];
  if (usage.cacheRead !== undefined) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite !== undefined) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cacheHitPercent !== undefined) parts.push(`CH${usage.cacheHitPercent.toFixed(1)}%`);
  return parts;
}

/** Pure, width-aware footer formatting; unknown metrics are never shown as zero. */
export function formatRuntimeStatus(status: TuiRuntimeStatus, width: number): string {
  const ctx = status.contextPercent !== undefined
    ? `${status.contextPercent.toFixed(1)}%/${status.contextWindow !== undefined ? formatTokens(status.contextWindow) : "?"}`
    : `?/${status.contextWindow !== undefined ? formatTokens(status.contextWindow) : "?"}`;
  const left = [...formatUsage(status.sessionUsage ?? status.lastTurnUsage), `${ctx}${status.autoCompaction ? " (auto)" : ""}`];
  const model = status.model ?? "model ?";
  const provider = status.provider ? `(${status.provider}) ` : "";
  const reasoning = status.reasoning ? ` • ${status.reasoning}` : "";
  const right = `${provider}${model}${reasoning}`;
  const raw = `${left.join(" ")}    ${right}`.trim();
  if (width <= 0 || raw.length <= width) return raw;
  if (width <= right.length) return right.slice(0, Math.max(0, width - 1)) + (width > 0 ? "…" : "");
  return raw.slice(0, Math.max(0, width - 1)) + "…";
}

/** Strip ANSI/control characters before any safe-surface rendering. */
function stripControls(text: string): string {
  return text
    .replace(/\u001b\]\d+;\u0007/g, "")       // OSC payload terminators
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "") // CSI/ANSI color sequences
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "");
}

/** Normalize text for suppression comparison — CRLF→LF only. */
function normalizeComparison(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** UTF-8-safe byte-bounded slice of control-stripped text. */
function boundText(text: string, maxBytes: number): string {
  let res = "";
  let bytes = 0;
  for (const ch of stripControls(text)) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > maxBytes) break;
    res += ch;
    bytes += b;
  }
  return res;
}

/** UTF-8-safe byte-bounded slice of already-sanitized text (no re-stripping). */
function boundUtf8(text: string, maxBytes: number): string {
  let res = "";
  let bytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > maxBytes) break;
    res += ch;
    bytes += b;
  }
  return res;
}

/**
 * #1319 R4: complete terminal-escape + control stripping for untrusted
 * channel text. Removes complete CSI/OSC/DCS/SOS/PM/APC sequences (both
 * C0 ESC and C1 forms), then remaining C0/C1 controls, then normalizes
 * embedded CR/LF/tab to a single visible space, then trims. Never strips
 * only the ESC byte while leaving a printable control-sequence tail.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  [
    "\u001b\\[[0-9:;<=>?]*[ -/]*[@-~]",                    // CSI (ESC [ … final)
    "\u009b[0-9:;<=>?]*[ -/]*[@-~]",                       // CSI (C1 0x9B)
    "\u001b\\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)",      // OSC → BEL | ST
    "\u009d[^\u0007\u001b]*(?:\u0007|\u001b\\\\)",         // OSC (C1)
    "\u001b[PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\\\)",   // DCS/SOS/PM/APC → ST
    "[\u0090\u0098\u009e\u009f][^\u0007\u001b]*(?:\u0007|\u001b\\\\)", // C1 DCS/SOS/PM/APC
    "\u001b[ -/]*[@-~]",                                   // remaining two-char ESC forms
  ].join("|"),
  "g",
);

export function sanitizeDiscussionText(text: string): string {
  let s = text.replace(ANSI_ESCAPE_SEQUENCE, "");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  s = s.replace(/[\t\n\r]+/g, " ");
  return s.trim();
}

/** Native-colored editor theme (border + select list) for the abtars shell,
 *  built from the loaded Pi theme through PUBLIC exports only. Must be passed
 *  at Editor construction — the editor renders with `theme.borderColor` and
 *  any render before the shell build crashes if it is undefined (#1612
 *  regression: Loader construction triggers an early render).
 *
 *  The `theme` instance is not a root export on the pinned line, so colors
 *  come from the public theme functions: `getSelectListTheme()` for accent/
 *  muted, and the markdown theme's `hr` (gray) as the closest public match
 *  for the editor's `borderMuted` border. */
export function nativeEditorTheme(
  codingAgent: TuiPresentationModules["codingAgent"],
): import("@earendil-works/pi-tui").EditorTheme {
  const selectList = codingAgent.getSelectListTheme();
  return {
    borderColor: codingAgent.getMarkdownTheme().hr,
    selectList,
  };
}

// ── Safe activity projection (design §5.1) ───────────────────────────────

export interface SafeActivityRow {
  key: string;
  label: string;
  state: string;
  kind: string;
}

const KNOWN_EVENT_KINDS = new Set([
  "card.created", "card.running", "card.queued", "card.completed",
  "card.failed", "card.delivered", "execution.started",
  "execution.completed", "execution.failed",
]);

/**
 * Project a server activity snapshot/event into safe display rows. Only card
 * IDs, bounded event kinds, and bounded status values survive. Titles,
 * channel/message payloads, prompt-like text, and all unstructured object
 * fields are deliberately ignored (design §5.1, #1338 security boundary).
 */
export function projectSafeActivity(input: unknown): SafeActivityRow | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as { kind?: unknown; cardId?: unknown; status?: unknown };
  const kind = typeof obj.kind === "string" && KNOWN_EVENT_KINDS.has(obj.kind) ? obj.kind : "";
  if (!kind) return null;
  const hasCard = typeof obj.cardId === "number" && Number.isFinite(obj.cardId);
  const state = typeof obj.status === "string" ? boundText(obj.status, 40) : "";
  return {
    key: hasCard ? `card:${obj.cardId}` : `kind:${kind}`,
    label: hasCard ? `card #${obj.cardId}` : "execution",
    state,
    kind,
  };
}

export function projectActivitySnapshot(snapshot: OrcActivitySnapshot): SafeActivityRow[] {
  const rows: SafeActivityRow[] = [];
  if (!snapshot || typeof snapshot !== "object") return rows;
  const seen = new Set<number>();
  const add = (card: ActivityCard | undefined, kind: string, label: string): void => {
    if (!card || seen.has(card.id)) return;
    if (rows.length >= MAX_ACTIVITY_ROWS) return;
    seen.add(card.id);
    rows.push({ key: `card:${card.id}`, label, state: boundText(card.status, 40), kind });
  };
  // #1319: consume the canonical snapshot shape directly — root first, then
  // active descendants, then recent direct terminal children not already
  // represented by identity. Active state wins over a recent-terminal entry.
  add(snapshot.root, "root", `root #${snapshot.root?.id ?? 0}`);
  for (const card of snapshot.activeChildren) add(card, "card.running", `card #${card.id}`);
  for (const card of snapshot.recentDirectChildren) add(card, "card.completed", `card #${card.id}`);
  return rows;
}

// ── Safe untrusted discussion projection (design §5.1, R4) ───────────────

export interface SafeDiscussionRow {
  /** Sequence-based identity — never card-based (R5: no replace-in-place). */
  key: string;
  /** Sanitized, bounded `[from -> to]` provenance. */
  provenance: string;
  /** Sanitized, bounded message body. */
  message: string;
}

const MAX_DISCUSSION_FROM_BYTES = 64;
const MAX_DISCUSSION_TO_BYTES = 64;
const MAX_DISCUSSION_MESSAGE_BYTES = 512;

/**
 * #1319 R4: project ONLY a typed `channel.message` event into a bounded
 * plain-text discussion row. Reads exactly `from`, `to`, and `message`; all
 * other unstructured fields stay rejected under the #1338 boundary. The
 * result is never fed to Markdown or message components — the renderer uses
 * plain `Text` with the dedicated untrusted-discussion style.
 */
export function projectSafeDiscussion(input: unknown): SafeDiscussionRow | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as { kind?: unknown; from?: unknown; to?: unknown; message?: unknown; sequence?: unknown };
  if (obj.kind !== "channel.message") return null;
  if (typeof obj.from !== "string" || typeof obj.message !== "string") return null;

  const from = sanitizeDiscussionText(boundUtf8(obj.from, MAX_DISCUSSION_FROM_BYTES));
  const to = typeof obj.to === "string"
    ? sanitizeDiscussionText(boundUtf8(obj.to, MAX_DISCUSSION_TO_BYTES))
    : "";
  const message = sanitizeDiscussionText(boundUtf8(obj.message, MAX_DISCUSSION_MESSAGE_BYTES));
  if (!message) return null;

  const sequence = typeof obj.sequence === "number" ? obj.sequence : 0;
  return {
    key: `seq:${sequence}`,
    provenance: to ? `[${from} -> ${to}]` : `[${from}]`,
    message,
  };
}

// ── Assistant-message factory (design §2.1) ──────────────────────────────

export type AssistantStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

/** #1619: ordered bounded content blocks for native thinking/text rendering. */
export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string };

/**
 * Minimal pi-compatible assistant message assembled from wire content. The
 * only place that adapts wire blocks to Pi's AssistantMessage shape. Usage is
 * zero/unknown rather than fabricated from the socket; provider/model
 * metadata is never copied into transcript text (design §2.1).
 */
export function makeAssistantMessage(
  blocks: readonly AssistantBlock[],
  stopReason: AssistantStopReason,
): import("@earendil-works/pi-ai").AssistantMessage {
  return {
    role: "assistant",
    content: blocks.map((b) => b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "thinking", thinking: b.thinking }),
    api: "custom",
    provider: "unknown",
    model: "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      totalTokens: 0,
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/** #1619: append a typed delta to an ordered bounded block list. Adjacent
 *  deltas of the same kind merge into one block; transitions open a new one. */
export function appendAssistantBlock(
  blocks: AssistantBlock[],
  kind: "text" | "thinking",
  delta: string,
  maxBlockBytes: number,
): AssistantBlock[] {
  if (!delta) return blocks;
  const last = blocks[blocks.length - 1];
  if (kind === "text") {
    const bounded = boundText(delta, maxBlockBytes);
    if (last && last.type === "text") {
      last.text = boundText(last.text + bounded, maxBlockBytes);
    } else {
      blocks.push({ type: "text", text: bounded });
    }
  } else {
    const bounded = boundText(delta, maxBlockBytes);
    if (last && last.type === "thinking") {
      last.thinking = boundText(last.thinking + bounded, maxBlockBytes);
    } else {
      blocks.push({ type: "thinking", thinking: bounded });
    }
  }
  return blocks;
}

// ── Attachment-local stream state (design §2) ────────────────────────────

export interface StreamState {
  id: string;
  executionId?: string;
  /** #1619: ordered typed content blocks (text/thinking). */
  blocks: AssistantBlock[];
  /** Bounded text-only accumulator for whole-result correlation. */
  text: string;
  ended: boolean;
  reason?: "complete" | "error" | "cancelled" | "truncated";
  row: unknown;
}

export interface ExecutionState {
  id: string;
  streamIds: string[];
  rows: unknown[];
  active: boolean;
  lastActivityAt: number;
}

const STREAM_END_NOTE: Record<Exclude<NonNullable<StreamState["reason"]>, "complete">, string> = {
  error: "[stream failed]",
  cancelled: "[stream cancelled]",
  truncated: "[output truncated — connect a live terminal for the full stream]",
};

// ── TuiApp ───────────────────────────────────────────────────────────────

export interface TuiAppOptions {
  modules: TuiPresentationModules;
  terminal: import("@earendil-works/pi-tui").ProcessTerminal;
  ui: import("@earendil-works/pi-tui").TUI;
  editor: import("@earendil-works/pi-tui").Editor;
  /** Route any render-tree failure to the command-level error boundary. */
  onRenderError: (err: Error) => void;
}

/**
 * Client-only render shell. All public component construction/mutation runs
 * inside `_guarded` so a renderer regression cannot crash the process.
 * `tui.ts` owns the socket, terminal, and exit semantics.
 */
export class TuiApp {
  private readonly _m: TuiPresentationModules;
  private readonly _terminal: import("@earendil-works/pi-tui").ProcessTerminal;
  private readonly _ui: import("@earendil-works/pi-tui").TUI;
  private readonly _editor: import("@earendil-works/pi-tui").Editor;
  private readonly _onRenderError: (err: Error) => void;

  private _markdownTheme: import("@earendil-works/pi-tui").MarkdownTheme;
  private _busy: import("@earendil-works/pi-tui").Loader;

  private _headerText: import("@earendil-works/pi-tui").Text | null = null;
  private _activity: import("@earendil-works/pi-tui").Container | null = null;
  private _discussion: import("@earendil-works/pi-tui").Container | null = null;
  private _transcript: import("@earendil-works/pi-tui").Container | null = null;
  private _footer: import("@earendil-works/pi-tui").Text | null = null;

  private _built = false;
  private _disposed = false;
  private _ready = false;
  private _sessionId: string | null = null;
  private _sessionLabel: string | null = null;

  /** streamId → stream state */
  private readonly _streams = new Map<string, StreamState>();
  /** executionId → execution group */
  private readonly _executions = new Map<string, ExecutionState>();
  private readonly _executionOrder: string[] = [];

  private _busyActive = false;
  private _busyInTree = false;
  private _toolLabel: string | null = null;

  /** Activity sequence guards (#1319 semantics). */
  private _activitySequence = 0;
  private readonly _activityRows = new Map<string, import("@earendil-works/pi-tui").Text>();

  /** #1319 R5: ordered, append-only discussion rows — newest bounded window. */
  private readonly _discussionRows: Array<{ key: string; text: import("@earendil-works/pi-tui").Text }> = [];
  private _discussionGapCount = 0;

  private _latestStatus: TuiRuntimeStatus | null = null;

  constructor(opts: TuiAppOptions) {
    this._m = opts.modules;
    this._terminal = opts.terminal;
    this._ui = opts.ui;
    this._editor = opts.editor;
    this._onRenderError = opts.onRenderError;

    this._m.codingAgent.initTheme();
    this._markdownTheme = this._m.codingAgent.getMarkdownTheme();

    // Pi-native colors via public theme functions: accent spinner + muted
    // message (same functions Pi's getSelectListTheme uses).
    const selectListTheme = this._m.codingAgent.getSelectListTheme();
    // #1619: native Loader defaults (Braille frames) — no custom ASCII frames.
    this._busy = new this._m.tui.Loader(
      this._ui,
      (s: string) => selectListTheme.selectedPrefix(s),
      (s: string) => selectListTheme.description(s),
      "Working",
    );
    this._busy.stop();
  }

  // ── Public surface ─────────────────────────────────────────────────

  get ready(): boolean { return this._ready; }
  get sessionId(): string | null { return this._sessionId; }

  /**
   * Authoritative `ready`: first call builds the shell and starts the TUI
   * exactly once; later calls reset all attachment-local state before
   * applying the new session label (design R5.1/R5.2).
   */
  resetForReady(sessionLabel: string, sessionId: string): void {
    this._guarded(() => {
      this._clearAttachmentState();
      this._sessionLabel = sessionLabel;
      this._sessionId = sessionId;
      this._ready = true;
      if (!this._built) {
        this._buildShell();
        this._built = true;
      }
      this._renderHeader();
      this._ui.requestRender();
    });
  }

  /** Route every server frame through the single render-state entry point. */
  handleFrame(frame: TuiServerFrame): void {
    this._guarded(() => {
      switch (frame.t) {
        case "ready":
          this.resetForReady(frame.sessionLabel, frame.sessionId);
          return;
        case "message":
          if (frame.role === "assistant") {
            this._handleAssistantMessage(frame.markdown, frame.executionId);
          } else {
            this._appendSystemRow(frame.markdown);
          }
          return;
        case "stream-start":
          this._handleStreamStart(frame.id, frame.executionId);
          return;
        case "chunk":
          this._handleChunk(frame.id, frame.executionId, frame.kind, frame.delta);
          return;
        case "tool-start":
          this._handleToolStart(frame.name);
          return;
        case "chunk-end":
          this._handleChunkEnd(frame.id, frame.reason);
          return;
        case "typing":
          this._setBusy(true);
          return;
        case "steer-ack":
          this._appendSystemRow(
            `${frame.status === "queued" ? "Steer queued" : `Steer ${frame.status}`}: ${frame.message}`,
          );
          return;
        case "activity-snapshot":
          this._handleActivitySnapshot(frame.sequence, frame.snapshot);
          return;
        case "activity":
          this._handleActivityEvent(frame.sequence, frame.event);
          return;
        case "activity-gap":
          this._handleActivityGap();
          return;
        case "status":
          this._handleStatus(frame.status);
          return;
        case "error":
          return; // command-level lifecycle owns error handling
      }
    });
  }

  /** Echo submitted input through the native user role (R2.2). */
  submitUserText(text: string): void {
    this._guarded(() => {
      this._appendUserRow(text);
      this._ui.requestRender();
    });
  }

  requestRender(): void {
    if (this._disposed) return;
    this._ui.requestRender();
  }

  /** Idempotent: stop the loader and release app-owned rows/listeners. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    try { this._busy.stop(); } catch { /* best effort */ }
    this._streams.clear();
    this._executions.clear();
    this._executionOrder.length = 0;
    this._activityRows.clear();
    this._discussionRows.length = 0;
  }

  // ── Frame handlers ─────────────────────────────────────────────────

  private _handleAssistantMessage(markdown: string, executionId?: string): void {
    // #1619: correlated whole result. When the execution's streams completed
    // with all text delivered (exact text or streamed-prefix/suffix match), the native rows — including
    // thinking blocks — stay and the redundant whole result is dropped.
    // On truncation/error/mismatch the whole result is the correctness
    // fallback and replaces the streamed rows (design R3.5).
    if (executionId !== undefined) {
      const exec = this._executions.get(executionId);
      if (exec && exec.rows.length > 0) {
        const allComplete = exec.streamIds.every((id) => {
          const s = this._streams.get(id);
          return s !== undefined && s.ended && (s.reason === undefined || s.reason === "complete");
        });
        const streamedText = exec.streamIds.map((id) => this._streams.get(id)?.text ?? "").join("");
        const normalizedStream = normalizeComparison(streamedText);
        const normalizedWhole = normalizeComparison(markdown);
        const wholeIsStreamed = normalizedStream === normalizedWhole
          || (normalizedStream.length > normalizedWhole.length && normalizedStream.endsWith(normalizedWhole));
        if (allComplete && streamedText && wholeIsStreamed) {
          this._releaseExecution(executionId);
          this._clearBusyIfIdle();
          this._ui.requestRender();
          return;
        }
        this._removeStreamRows(exec);
        this._releaseExecution(executionId);
        this._appendAssistantRow(markdown, "stop");
        this._clearBusyIfIdle();
        this._ui.requestRender();
        return;
      }
    }
    this._appendAssistantRow(markdown, "stop");
    this._clearBusyIfIdle();
    this._ui.requestRender();
  }

  private _handleStreamStart(id: string, executionId: string): void {
    this._ensureStream(id, executionId);
    this._setBusy(true);
  }

  private _handleChunk(id: string, executionId: string | undefined, kind: "text" | "thinking", delta: string): void {
    let stream = this._streams.get(id);
    if (!stream) {
      // Missing/evicted stream-start: create state from a correlated chunk.
      stream = this._ensureStream(id, executionId);
    }
    if (stream.ended) return;
    if (kind === "thinking") {
      // #1619: thinking never enters the text-only comparison accumulator.
      appendAssistantBlock(stream.blocks, "thinking", delta, MAX_COMPARISON_BYTES);
    } else {
      stream.text = boundText(stream.text + delta, MAX_COMPARISON_BYTES);
      appendAssistantBlock(stream.blocks, "text", delta, MAX_COMPARISON_BYTES);
    }
    this._updateStreamRow(stream);
    this._setBusy(true);
    this._ui.requestRender();
  }

  private _handleToolStart(name: string): void {
    // Control-stripped, bounded tool label only — never args/results.
    this._toolLabel = boundText(name, 80);
    this._setBusy(true);
    this._ui.requestRender();
  }

  private _handleChunkEnd(id: string, reason?: "complete" | "error" | "cancelled" | "truncated"): void {
    const stream = this._streams.get(id);
    if (stream) {
      stream.ended = true;
      stream.reason = reason;
      if (reason !== undefined && reason !== "complete") {
        this._appendSystemRow(STREAM_END_NOTE[reason]);
      }
      const execId = stream.executionId;
      if (execId !== undefined) {
        const exec = this._executions.get(execId);
        if (exec) exec.active = false;
      }
    }
    this._clearBusyIfIdle();
    this._ui.requestRender();
  }

  private _handleStatus(status: TuiRuntimeStatus): void {
    // Session guard + revision monotonicity (#1355 semantics).
    if (this._sessionId !== null && status.sessionId !== this._sessionId) return;
    if (this._latestStatus && status.revision <= this._latestStatus.revision) return;
    this._latestStatus = status;
    this._renderFooter();
    this._ui.requestRender();
  }

  private _handleActivitySnapshot(sequence: number, snapshot: OrcActivitySnapshot): void {
    if (sequence < this._activitySequence) return;
    this._activitySequence = sequence;
    this._renderActivity(projectActivitySnapshot(snapshot));
    this._ui.requestRender();
  }

  private _handleActivityEvent(sequence: number, event: OrcActivityEvent): void {
    if (sequence < this._activitySequence) return;
    this._activitySequence = sequence;

    // #1319 R4: channel discussion is its own collection — sanitized plain
    // text with provenance, never a card-progress replacement.
    if (event.kind === "channel.message") {
      const row = projectSafeDiscussion(event);
      if (row && this._discussion) {
        this._appendDiscussionRow(row.key, row.provenance, row.message);
      }
      this._ui.requestRender();
      return;
    }

    const row = projectSafeActivity(event);
    if (!row || !this._activity) return;
    const existing = this._activityRows.get(row.key);
    if (existing) {
      existing.setText(`${row.label} ${row.state}`);
    } else {
      if (this._activityRows.size >= MAX_ACTIVITY_ROWS) return;
      const text = new this._m.tui.Text(`${row.label} ${row.state}`, 0, 0);
      this._activityRows.set(row.key, text);
      this._activity.addChild(text);
    }
    this._ui.requestRender();
  }

  /** #1319 R5: truthful signal that writer pressure omitted discussion. */
  private _handleActivityGap(): void {
    this._discussionGapCount++;
    this._appendDiscussionRow(`gap:${this._discussionGapCount}`, "", "[some worker/Orc messages omitted]");
    this._ui.requestRender();
  }

  /** Append one bounded plain-text discussion row (newest window). */
  private _appendDiscussionRow(key: string, provenance: string, message: string): void {
    if (!this._discussion) return;
    const text = new this._m.tui.Text(
      provenance ? `${provenance} ${message}` : message,
      0,
      0,
      this._discussionStyle,
    );
    this._discussionRows.push({ key, text });
    this._discussion.addChild(text);
    while (this._discussionRows.length > MAX_DISCUSSION_ROWS) {
      const oldest = this._discussionRows.shift()!;
      try { this._discussion.removeChild(oldest.text); } catch { /* best effort */ }
    }
  }

  /** #1319 R4: visually distinct untrusted-discussion styling (italic —
   *  markdown theme has no public muted color on this package surface). */
  private readonly _discussionStyle = (s: string): string => {
    const italic = this._markdownTheme.italic;
    return typeof italic === "function" ? italic(s) : s;
  };

  // ── Shell construction ─────────────────────────────────────────────

  /** Route any render-tree exception through the command error boundary. */
  private _guarded(fn: () => void): void {
    if (this._disposed) return;
    try {
      fn();
    } catch (err) {
      this._onRenderError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private _buildShell(): void {
    const header = new this._m.tui.Container();
    const headerText = new this._m.tui.Text("", 0, 0);
    // No color argument: the DynamicBorder default is theme.fg("border", ...),
    // matching Pi's own usage of the component.
    header.addChild(new this._m.codingAgent.DynamicBorder());
    header.addChild(headerText);
    this._headerText = headerText;

    const activity = new this._m.tui.Container();
    const discussion = new this._m.tui.Container();
    const transcript = new this._m.tui.Container();
    const footer = new this._m.tui.Text("", 0, 0);
    this._activity = activity;
    this._discussion = discussion;
    this._transcript = transcript;
    this._footer = footer;

    this._ui.addChild(header);
    this._ui.addChild(activity);
    this._ui.addChild(discussion);
    this._ui.addChild(transcript);
    this._ui.addChild(this._editor);
    this._ui.addChild(footer);

    // The busy loader is only added while a stream/tool is active — the
    // Loader renders its message unconditionally, so it must not sit in the
    // tree when idle (#1612: permanent "- Working" row).
    // The editor was constructed with a functional theme (identityEditorTheme
    // in tui.ts) — borderColor is never undefined at any render.
    this._ui.setFocus(this._editor);
  }

  private _renderHeader(): void {
    if (!this._headerText) return;
    this._headerText.setText(this._sessionLabel ? boundText(this._sessionLabel, 120) : "");
  }

  private _renderFooter(): void {
    if (!this._footer || !this._latestStatus) return;
    this._footer.setText(formatRuntimeStatus(this._latestStatus, this._terminal.columns));
  }

  private _renderActivity(rows: SafeActivityRow[]): void {
    if (!this._activity) return;
    this._activity.clear();
    this._activityRows.clear();
    for (const row of rows.slice(0, MAX_ACTIVITY_ROWS)) {
      const text = new this._m.tui.Text(`${row.label} ${row.state}`, 0, 0);
      this._activityRows.set(row.key, text);
      this._activity.addChild(text);
    }
  }

  // ── Transcript rows ────────────────────────────────────────────────

  private _appendAssistantRow(text: string, stopReason: AssistantStopReason): void {
    const component = new this._m.codingAgent.AssistantMessageComponent(
      makeAssistantMessage([{ type: "text", text: boundText(text, MAX_COMPARISON_BYTES) }], stopReason),
      false,
      this._markdownTheme,
      undefined,
      1,
    );
    this._transcript?.addChild(component);
  }

  private _appendSystemRow(markdown: string): void {
    const component = new this._m.tui.Markdown(
      boundText(markdown, MAX_SYSTEM_TEXT_BYTES),
      0,
      0,
      this._markdownTheme,
      {},
    );
    this._transcript?.addChild(component);
  }

  private _appendUserRow(text: string): void {
    const component = new this._m.codingAgent.UserMessageComponent(text, this._markdownTheme, 1);
    this._transcript?.addChild(component);
  }

  // ── Stream/execution bookkeeping ───────────────────────────────────

  private _ensureStream(id: string, executionId?: string): StreamState {
    const existing = this._streams.get(id);
    if (existing) return existing;

    const stream: StreamState = { id, executionId, blocks: [], text: "", ended: false, row: null };
    this._streams.set(id, stream);
    stream.row = this._newStreamRow(stream);

    if (executionId !== undefined) {
      let exec = this._executions.get(executionId);
      if (!exec) {
        if (this._executions.size >= MAX_EXECUTION_GROUPS) {
          // Bounded eviction: drop the oldest group's reconciliation
          // metadata. Already-visible rows stay; a later whole result
          // renders normally rather than being suppressed (design §2).
          const oldestId = this._executionOrder.shift();
          if (oldestId !== undefined) {
            const oldest = this._executions.get(oldestId);
            if (oldest) {
              for (const sid of oldest.streamIds) this._streams.delete(sid);
              this._executions.delete(oldestId);
            }
          }
        }
        exec = {
          id: executionId,
          streamIds: [],
          rows: [],
          active: true,
          lastActivityAt: Date.now(),
        };
        this._executions.set(executionId, exec);
        this._executionOrder.push(executionId);
      }
      if (exec.streamIds.length < MAX_STREAMS_PER_EXECUTION) {
        exec.streamIds.push(id);
      }
      if (!exec.rows.includes(stream.row)) exec.rows.push(stream.row);
      exec.active = true;
      exec.lastActivityAt = Date.now();
    }
    return stream;
  }

  private _newStreamRow(_stream: StreamState): unknown {
    const component = new this._m.codingAgent.AssistantMessageComponent(
      makeAssistantMessage([{ type: "text", text: "" }], "pending"),
      false,
      this._markdownTheme,
      undefined,
      1,
    );
    this._transcript?.addChild(component);
    return component;
  }

  private _updateStreamRow(stream: StreamState): void {
    const row = stream.row as { updateContent?: (m: unknown) => void } | null;
    if (row && typeof row.updateContent === "function") {
      row.updateContent(makeAssistantMessage(stream.blocks, "pending"));
    }
  }

  private _removeStreamRows(exec: ExecutionState): void {
    for (const row of exec.rows) {
      try {
        this._transcript?.removeChild(row as import("@earendil-works/pi-tui").Component);
      } catch { /* best effort */ }
    }
    for (const streamId of exec.streamIds) {
      this._streams.delete(streamId);
    }
  }

  private _releaseExecution(executionId: string): void {
    this._executions.delete(executionId);
    const idx = this._executionOrder.indexOf(executionId);
    if (idx !== -1) this._executionOrder.splice(idx, 1);
  }

  // ── Busy state ─────────────────────────────────────────────────────

  private _setBusy(on: boolean): void {
    if (on) {
      if (this._busyActive) return;
      this._busyActive = true;
      this._busy.setMessage(this._toolLabel || "Working");
      if (!this._busyInTree && this._transcript) {
        // Insert the loader between the discussion region and the transcript:
        // header, activity, discussion, busy, transcript, editor, footer.
        this._ui.removeChild(this._transcript);
        this._ui.addChild(this._busy);
        this._ui.addChild(this._transcript);
        this._busyInTree = true;
      }
      try { this._busy.start(); } catch { /* best effort */ }
    } else {
      if (!this._busyActive) return;
      this._busyActive = false;
      try { this._busy.stop(); } catch { /* best effort */ }
      if (this._busyInTree) {
        try { this._ui.removeChild(this._busy); } catch { /* best effort */ }
        this._busyInTree = false;
      }
    }
  }

  /** Busy ends when no active execution or un-ended stream remains (R3.7). */
  private _clearBusyIfIdle(): void {
    for (const exec of this._executions.values()) {
      if (exec.active) return;
    }
    for (const stream of this._streams.values()) {
      if (!stream.ended) return;
    }
    this._toolLabel = null;
    this._setBusy(false);
  }

  private _clearAttachmentState(): void {
    this._streams.clear();
    this._executions.clear();
    this._executionOrder.length = 0;
    this._activityRows.clear();
    this._activitySequence = 0;
    this._discussionRows.length = 0;
    this._discussionGapCount = 0;
    this._toolLabel = null;
    this._latestStatus = null;
    this._setBusy(false);
    try {
      this._activity?.clear();
      this._discussion?.clear();
      this._transcript?.clear();
      this._footer?.setText("");
    } catch { /* best effort */ }
  }}
