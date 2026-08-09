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

import type { OrcActivitySnapshot } from "../../components/orc-activity-snapshot.js";
import type { OrcActivityEvent } from "../../components/orc-activity-feed.js";
import type { TuiServerFrame } from "../../platforms/tui/tui-protocol.js";
import type { TuiRuntimeStatus, TuiUsageSnapshot } from "../../platforms/tui/runtime-status.js";

// ── Public module seam (design §1.2) ─────────────────────────────────────

export interface TuiPresentationModules {
  tui: Pick<typeof import("@earendil-works/pi-tui"),
    "ProcessTerminal" | "TUI" | "Container" | "Editor" | "Text" |
    "Markdown" | "Loader" | "matchesKey">;
  codingAgent: Pick<typeof import("@earendil-works/pi-coding-agent"),
    "initTheme" | "getMarkdownTheme" |
    "UserMessageComponent" | "AssistantMessageComponent" | "DynamicBorder">;
}

// ── Bounds (design §2) ───────────────────────────────────────────────────

const MAX_EXECUTION_GROUPS = 4;
const MAX_STREAMS_PER_EXECUTION = 20;
const MAX_COMPARISON_BYTES = 64 * 1024;
const MAX_ACTIVITY_ROWS = 100;
const MAX_SYSTEM_TEXT_BYTES = 2 * 1024;

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

/** Monochrome editor theme (border + select list) for the abtars shell. */
function identityEditorTheme(): import("@earendil-works/pi-tui").EditorTheme {
  const passthrough = (s: string): string => s;
  return {
    borderColor: passthrough,
    selectList: {
      selectedPrefix: passthrough,
      selectedText: passthrough,
      description: passthrough,
      scrollInfo: passthrough,
      noMatch: passthrough,
    },
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
  const cards = (snapshot as unknown as { cards?: Array<{ cardId?: unknown; status?: unknown }> }).cards;
  if (Array.isArray(cards)) {
    for (const card of cards) {
      if (rows.length >= MAX_ACTIVITY_ROWS) break;
      const row = projectSafeActivity({ kind: "card.running", cardId: card?.cardId ?? null, status: card?.status });
      if (row) rows.push(row);
    }
  }
  return rows;
}

// ── Assistant-message factory (design §2.1) ──────────────────────────────

export type AssistantStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * Minimal pi-compatible assistant message assembled from wire text. The only
 * place that adapts wire text to Pi's AssistantMessage shape. Usage is
 * zero/unknown rather than fabricated from the socket; provider/model
 * metadata is never copied into transcript text (design §2.1).
 */
export function makeAssistantMessage(
  text: string,
  stopReason: AssistantStopReason,
): import("@earendil-works/pi-ai").AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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

// ── Attachment-local stream state (design §2) ────────────────────────────

export interface StreamState {
  id: string;
  executionId?: string;
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
  private _editorTheme: import("@earendil-works/pi-tui").EditorTheme;
  private _busy: import("@earendil-works/pi-tui").Loader;

  private _headerText: import("@earendil-works/pi-tui").Text | null = null;
  private _activity: import("@earendil-works/pi-tui").Container | null = null;
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
  private _toolLabel: string | null = null;

  /** Activity sequence guards (#1319 semantics). */
  private _activitySequence = 0;
  private readonly _activityRows = new Map<string, import("@earendil-works/pi-tui").Text>();

  private _latestStatus: TuiRuntimeStatus | null = null;

  constructor(opts: TuiAppOptions) {
    this._m = opts.modules;
    this._terminal = opts.terminal;
    this._ui = opts.ui;
    this._editor = opts.editor;
    this._onRenderError = opts.onRenderError;

    this._m.codingAgent.initTheme();
    this._markdownTheme = this._m.codingAgent.getMarkdownTheme();
    // The pinned line does not export a native editor theme via the public
    // export map (getEditorTheme is not a root export at 0.83.0), so the
    // editor keeps an abtars-owned identity theme (R2.5: "where the public
    // API supports them").
    this._editorTheme = identityEditorTheme();

    this._busy = new this._m.tui.Loader(
      this._ui,
      (s: string) => s,
      (s: string) => s,
      "Working",
      { frames: ["-", "\\", "|", "/"], intervalMs: 80 },
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
          this._handleChunk(frame.id, frame.executionId, frame.delta);
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
  }

  // ── Frame handlers ─────────────────────────────────────────────────

  private _handleAssistantMessage(markdown: string, executionId?: string): void {
    // Correlated whole result: replace the execution's streamed rows with one
    // final assistant row (design R3.5). Uncorrelated results always render.
    if (executionId !== undefined) {
      const exec = this._executions.get(executionId);
      if (exec && exec.rows.length > 0) {
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

  private _handleChunk(id: string, executionId: string | undefined, delta: string): void {
    let stream = this._streams.get(id);
    if (!stream) {
      // Missing/evicted stream-start: create state from a correlated chunk.
      stream = this._ensureStream(id, executionId);
    }
    if (stream.ended) return;
    stream.text = boundText(stream.text + delta, MAX_COMPARISON_BYTES);
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
    header.addChild(new this._m.codingAgent.DynamicBorder((s: string) => s));
    header.addChild(headerText);
    this._headerText = headerText;

    const activity = new this._m.tui.Container();
    const transcript = new this._m.tui.Container();
    const footer = new this._m.tui.Text("", 0, 0);
    this._activity = activity;
    this._transcript = transcript;
    this._footer = footer;

    this._ui.addChild(header);
    this._ui.addChild(activity);
    this._ui.addChild(this._busy);
    this._ui.addChild(transcript);
    this._ui.addChild(this._editor);
    this._ui.addChild(footer);

    // Native editor theme from the loaded presentation package (R2.5).
    this._editor.borderColor = this._editorTheme.borderColor;
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
      makeAssistantMessage(text, stopReason),
      true,
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

    const stream: StreamState = { id, executionId, text: "", ended: false, row: null };
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
      makeAssistantMessage("", "pending"),
      true,
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
      row.updateContent(makeAssistantMessage(stream.text, "pending"));
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
      try { this._busy.start(); } catch { /* best effort */ }
    } else {
      if (!this._busyActive) return;
      this._busyActive = false;
      try { this._busy.stop(); } catch { /* best effort */ }
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
    this._toolLabel = null;
    this._latestStatus = null;
    this._setBusy(false);
    try {
      this._activity?.clear();
      this._transcript?.clear();
      this._footer?.setText("");
    } catch { /* best effort */ }
  }
}
