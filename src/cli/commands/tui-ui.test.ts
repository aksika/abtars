/**
 * tui-ui.test.ts — #1612 renderer component-boundary regression.
 *
 * Feeds the public-module seam (fake pi-tui + fake pi-coding-agent
 * components) and asserts on the shell tree and row operations — NOT on
 * isolated helper output. Covers: stream grouping + final reconciliation,
 * busy/tool cleanup, activity redaction/sequence, status revision/session
 * guards, ready/session reset, render-failure recovery, and the security
 * projection boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TuiApp,
  formatRuntimeStatus,
  makeAssistantMessage,
  appendAssistantBlock,
  projectSafeActivity,
  projectActivitySnapshot,
  projectSafeDiscussion,
  type TuiPresentationModules,
  type TuiAppOptions,
} from "./tui-ui.js";
import type { TuiServerFrame } from "../../platforms/tui/tui-protocol.js";
import type { TuiRuntimeStatus } from "../../platforms/tui/runtime-status.js";

// ── Fake component seam ─────────────────────────────────────────────────

class FakeContainer {
  children: unknown[] = [];
  addChild(child: unknown): void { this.children.push(child); }
  removeChild(child: unknown): void {
    this.children = this.children.filter((c) => c !== child);
  }
  clear(): void { this.children = []; }
}

class FakeTUI extends FakeContainer {
  requestRender = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  setFocus = vi.fn();
  addInputListener = vi.fn();
}

class FakeProcessTerminal {
  columns = 80;
  rows = 24;
}

class FakeText {
  constructor(
    public content: string,
    public x: number,
    public y: number,
    public style?: unknown,
  ) {}
  setText = vi.fn((text: string) => { this.content = text; });
}

class FakeMarkdown {
  constructor(
    public body: string,
    public x: number,
    public y: number,
    public theme: unknown,
    public style: unknown,
  ) {}
}

class FakeLoader {
  start = vi.fn();
  stop = vi.fn();
  setMessage = vi.fn();
  constructor(
    public ui: unknown,
    public spinnerColor: unknown,
    public messageColor: unknown,
    public message?: string,
    public indicator?: unknown,
  ) {}
}

class FakeEditor {
  borderColor: unknown;
  onSubmit: ((text: string) => void) | null = null;
  constructor(public ui: unknown, public theme: unknown) {}
}

class FakeUserMessage extends FakeContainer {
  constructor(public text: string, public theme: unknown, public pad?: number) { super(); }
}

class FakeAssistantMessage extends FakeContainer {
  updateContent = vi.fn();
  constructor(
    public message?: unknown,
    public hideThinking?: boolean,
    public theme?: unknown,
    public hiddenLabel?: string,
    public pad?: number,
  ) { super(); }
}

class FakeDynamicBorder {
  constructor(public color?: (s: string) => string) {}
}

function makeModules(): TuiPresentationModules {
  return {
    tui: {
      ProcessTerminal: FakeProcessTerminal,
      TuiMainScreen: FakeTUI,
      Container: FakeContainer,
      Editor: FakeEditor,
      Text: FakeText,
      Markdown: FakeMarkdown,
      Loader: FakeLoader,
      matchesKey: () => false,
    },
    codingAgent: {
      initTheme: vi.fn(),
      getMarkdownTheme: vi.fn(() => ({})),
      getSelectListTheme: vi.fn(() => ({
        selectedPrefix: (s: string) => s,
        selectedText: (s: string) => s,
        description: (s: string) => s,
        scrollInfo: (s: string) => s,
        noMatch: (s: string) => s,
      })),
      theme: {
        fg: (_color: string, s: string) => s,
        bg: (_color: string, s: string) => s,
      } as never,
      UserMessageComponent: FakeUserMessage,
      AssistantMessageComponent: FakeAssistantMessage,
      DynamicBorder: FakeDynamicBorder,
    },
  } as unknown as TuiPresentationModules;
}

interface Harness {
  app: TuiApp;
  ui: FakeTUI;
  terminal: FakeProcessTerminal;
  loader: FakeLoader;
  renderErrors: Error[];
}

function makeHarness(options?: Partial<TuiAppOptions>): Harness {
  const modules = makeModules();
  const ui = new FakeTUI();
  const terminal = new FakeProcessTerminal();
  const editor = new FakeEditor(ui, {});
  const renderErrors: Error[] = [];
  const app = new TuiApp({
    modules,
    terminal,
    ui,
    editor,
    onRenderError: (err: Error) => { renderErrors.push(err); },
    ...options,
  });
  // Find the loader the app constructed (last Loader instance).
  const loader = app["_busy"] as FakeLoader;
  return { app, ui, terminal, loader, renderErrors };
}

/** The transcript region: the container holding message rows. */
function transcriptContainer(h: Harness): FakeContainer {
  const found = h.ui.children.find((child) => {
    if (!(child instanceof FakeContainer)) return false;
    return child.children.some(
      (k) => k instanceof FakeUserMessage || k instanceof FakeAssistantMessage || k instanceof FakeMarkdown,
    );
  });
  return (found as FakeContainer | undefined) ?? new FakeContainer();
}

function transcriptChildren(h: Harness): unknown[] {
  return transcriptContainer(h).children;
}

function assistantRows(h: Harness): FakeAssistantMessage[] {
  return transcriptChildren(h).filter((c) => c instanceof FakeAssistantMessage) as FakeAssistantMessage[];
}

function systemRows(h: Harness): FakeMarkdown[] {
  return transcriptChildren(h).filter((c) => c instanceof FakeMarkdown) as FakeMarkdown[];
}

/** The activity region: the semantic card/execution status container. */
function activityChildren(h: Harness): FakeText[] {
  const container = h.app["_activity"] as FakeContainer | null;
  return ((container?.children ?? []) as FakeText[]);
}

/** The discussion region: the ordered plain-text channel-message container. */
function discussionChildren(h: Harness): FakeText[] {
  const container = h.app["_discussion"] as FakeContainer | null;
  return ((container?.children ?? []) as FakeText[]);
}

/** The footer: the only direct-child Text of the TUI root. */
function footerText(h: Harness): FakeText {
  return h.ui.children.find((child) => child instanceof FakeText) as FakeText;
}

const ready = (sessionLabel = "Main #1", sessionId = "s1"): TuiServerFrame => ({ t: "ready", sessionLabel, sessionId });

function status(sessionId: string, revision: number, model?: string): TuiServerFrame {
  return { t: "status", status: { sessionId, revision, model } as TuiRuntimeStatus };
}

describe("TuiApp — shell construction (#1612)", () => {
  it("builds separate regions and requests native user/assistant components", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    // header, activity, discussion, transcript, editor, footer (loader is transient)
    expect(h.ui.children.length).toBe(6);
    expect(h.ui.setFocus).toHaveBeenCalledTimes(1);
    expect(h.loader.stop).toHaveBeenCalled(); // idle on startup

    h.app.submitUserText("hello world");
    const rows = transcriptChildren(h);
    expect(rows.length).toBe(1);
    expect(rows[0]).toBeInstanceOf(FakeUserMessage);
    expect((rows[0] as FakeUserMessage).text).toBe("hello world");
  });

  it("adds the busy loader only while busy and removes it when idle", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    expect(h.ui.children.length).toBe(6);
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    expect(h.ui.children.length).toBe(7); // loader joined the tree
    expect(h.loader.start).toHaveBeenCalled();
    h.app.handleFrame({ t: "chunk-end", id: "st1", executionId: "e1", reason: "complete" });
    expect(h.ui.children.length).toBe(6); // loader removed when idle
  });
});

describe("TuiApp — stream grouping and final reconciliation (design §3/§4)", () => {
  it("updates ONE keyed assistant row across chunks and settles to one final row", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", kind: "text", delta: "Hello" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", kind: "text", delta: " world" });
    h.app.handleFrame({ t: "tool-start", id: "st1", executionId: "e1", name: "search" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", kind: "text", delta: "!" });

    // Still exactly one assistant row (never one per delta).
    expect(assistantRows(h).length).toBe(1);
    const pending = assistantRows(h)[0]!;
    expect(pending.updateContent).toHaveBeenCalled();
    const lastMessage = pending.updateContent.mock.calls.at(-1)![0] as { content: Array<{ text: string }> };
    expect(lastMessage.content[0]!.text).toBe("Hello world!");

    h.app.handleFrame({ t: "chunk-end", id: "st1", executionId: "e1", reason: "complete" });
    // #1619: the correlated whole result exactly matches the completed stream —
    // the native row (including any thinking blocks) stays; no duplicate row.
    h.app.handleFrame({ t: "message", role: "assistant", markdown: "Hello world!", executionId: "e1" });

    const rows = assistantRows(h);
    expect(rows.length).toBe(1);
    expect(rows[0]!.updateContent.mock.calls.length).toBe(3); // one per chunk — no fresh final row
    const kept = rows[0]!.updateContent.mock.calls.at(-1)![0] as { content: Array<{ text: string }> };
    expect(kept.content[0]!.text).toBe("Hello world!");
    // Busy cleared after the execution settles.
    expect(h.loader.stop).toHaveBeenCalled();
  });

  it("replaces the streamed rows with the whole result when the stream was truncated", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", kind: "text", delta: "partial" });
    h.app.handleFrame({ t: "chunk-end", id: "st1", executionId: "e1", reason: "truncated" });
    // Truncated stream → the whole result is the correctness fallback.
    h.app.handleFrame({ t: "message", role: "assistant", markdown: "complete answer", executionId: "e1" });
    const rows = assistantRows(h);
    expect(rows.length).toBe(1);
    expect(rows[0]!.updateContent.mock.calls.length).toBeLessThanOrEqual(1);
    expect(rows[0]!.message).toBeDefined();
  });

  it("keeps the streamed row visible when the whole result is suppressed (exact-match)", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", kind: "text", delta: "streamed" });
    h.app.handleFrame({ t: "chunk-end", id: "st1", executionId: "e1", reason: "complete" });
    // No message frame arrives (daemon suppression) — the row stays.
    expect(assistantRows(h).length).toBe(1);
    expect(h.loader.stop).toHaveBeenCalled();
  });

  it("always renders an unmatched whole result (never suppresses in the client)", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "message", role: "assistant", markdown: "fallback", executionId: "no-such-execution" });
    expect(assistantRows(h).length).toBe(1);
    expect(assistantRows(h)[0]!.message).toBeDefined();
  });

  it("renders a fallback whole result even after a mismatched/evicted stream", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    // Stream for e1, then 4 more executions evict e1's group (cap = 4).
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", kind: "text", delta: "old" });
    for (let i = 2; i <= 5; i++) {
      h.app.handleFrame({ t: "stream-start", id: `st${i}`, executionId: `e${i}` });
      h.app.handleFrame({ t: "chunk", id: `st${i}`, executionId: `e${i}`, kind: "text", delta: `d${i}` });
    }
    // e1's group was evicted — the whole result must still render (not suppressed).
    h.app.handleFrame({ t: "message", role: "assistant", markdown: "authoritative", executionId: "e1" });
    expect(assistantRows(h).some((r) => (r as FakeAssistantMessage).message !== undefined)).toBe(true);
  });

  it("appends a bounded system note for truncated/error/cancelled streams", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", kind: "text", delta: "partial" });
    h.app.handleFrame({ t: "chunk-end", id: "st1", executionId: "e1", reason: "truncated" });
    const systems = systemRows(h);
    expect(systems.length).toBe(1);
    expect(systems[0]!.body).toMatch(/truncated/i);
    expect(h.loader.stop).toHaveBeenCalled();
  });

  it("creates stream state from a chunk when stream-start was evicted/missing", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "chunk", id: "st9", executionId: "e9", kind: "text", delta: "first" });
    h.app.handleFrame({ t: "chunk", id: "st9", executionId: "e9", kind: "text", delta: " second" });
    expect(assistantRows(h).length).toBe(1);
    const pending = assistantRows(h)[0]!;
    const lastMessage = pending.updateContent.mock.calls.at(-1)![0] as { content: Array<{ text: string }> };
    expect(lastMessage.content[0]!.text).toBe("first second");
  });

  it("shows a transient busy loader from typing until no active stream remains", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "typing" });
    expect(h.loader.start).toHaveBeenCalled();
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", kind: "text", delta: "x" });
    h.app.handleFrame({ t: "chunk-end", id: "st1", executionId: "e1", reason: "complete" });
    expect(h.loader.stop).toHaveBeenCalled();
  });
});

describe("TuiApp — safe activity projection (design §5.1)", () => {
  it("projects the canonical snapshot shape (root, active, recent) and replaces on recovery", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 5,
      snapshot: {
        sessionId: "s1",
        executionId: "e1",
        busy: true,
        sequence: 5,
        root: { id: 1, title: "project", status: "running", priority: "HIGH", type: "project", parentId: null, tokensUsed: null },
        activeChildren: [
          { id: 7, title: "child a", status: "running", priority: "HIGH", type: "task", parentId: 1, tokensUsed: null },
          { id: 8, title: "child b", status: "queued", priority: "MEDIUM", type: "task", parentId: 1, tokensUsed: null },
        ],
        recentDirectChildren: [
          { id: 9, title: "done c", status: "done", priority: "LOW", type: "task", parentId: 1, tokensUsed: null },
        ],
      },
    });
    const rows = activityChildren(h);
    expect(rows.length).toBe(4);
    expect(rows.map((t) => t.content)).toEqual([
      "root #1 running",
      "card #7 running",
      "card #8 queued",
      "card #9 done",
    ]);

    // Older snapshot must be ignored.
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 3,
      snapshot: {
        sessionId: "s1", busy: false, sequence: 3, activeChildren: [], recentDirectChildren: [],
        root: { id: 99, title: "stale", status: "running", priority: "HIGH", type: "project", parentId: null, tokensUsed: null },
      },
    });
    expect(activityChildren(h).length).toBe(4);

    // Newer recovery snapshot replaces the semantic status region only.
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 9,
      snapshot: {
        sessionId: "s1", busy: false, sequence: 9, activeChildren: [], recentDirectChildren: [],
        root: { id: 7, title: "child a", status: "completed", priority: "HIGH", type: "task", parentId: 1, tokensUsed: null },
      },
    });
    const replaced = activityChildren(h);
    expect(replaced.length).toBe(1);
    expect(replaced[0]!.content).toBe("root #7 completed");
  });

  it("deduplicates by card identity, giving active children precedence over recent terminals", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 1,
      snapshot: {
        sessionId: "s1", busy: true, sequence: 1,
        root: { id: 1, title: "p", status: "running", priority: "HIGH", type: "project", parentId: null, tokensUsed: null },
        activeChildren: [{ id: 7, title: "a", status: "running", priority: "HIGH", type: "task", parentId: 1, tokensUsed: null }],
        recentDirectChildren: [
          { id: 7, title: "a", status: "done", priority: "HIGH", type: "task", parentId: 1, tokensUsed: null },
          { id: 8, title: "b", status: "done", priority: "LOW", type: "task", parentId: 1, tokensUsed: null },
        ],
      },
    });
    const rows = activityChildren(h);
    expect(rows.length).toBe(3); // card 7 appears once — active state wins
    expect(rows.map((t) => t.content)).toEqual([
      "root #1 running",
      "card #7 running",
      "card #8 done",
    ]);
  });

  it("ignores secret-shaped and prompt-like payload fields entirely", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({
      t: "activity",
      sequence: 1,
      event: {
        kind: "card.running",
        cardId: 7,
        status: "running",
        title: "SECRET PROMPT: delete everything",
        channel: { id: "secret-channel", message: "payload text" },
        args: { tool: "read", input: "/etc/shadow" },
      } as never,
    });
    const rows = activityChildren(h);
    expect(rows.length).toBe(1);
    const content = rows[0]!.content;
    expect(content).toBe("card #7 running");
    expect(content).not.toMatch(/SECRET|payload|shadow|delete/);
  });

  it("strips control characters from status before rendering", () => {
    const row = projectSafeActivity({ kind: "card.running", cardId: 3, status: "run\u001b[31mning" });
    expect(row?.state).toBe("running");
  });

  it("bounded projection rejects unknown kinds and untyped objects", () => {
    expect(projectSafeActivity({ kind: "weird.kind", cardId: 1 })).toBeNull();
    expect(projectSafeActivity(null)).toBeNull();
    expect(projectSafeActivity("text")).toBeNull();
  });
});

describe("TuiApp — status/footer (design §5.2)", () => {
  it("ignores stale revisions and wrong-session status frames", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame(status("s1", 1, "glm-5.2"));
    const first = footerText(h).content;
    expect(first).toContain("glm-5.2");

    h.app.handleFrame(status("s1", 1, "older")); // same revision — ignored
    expect(footerText(h).content).toBe(first);
    h.app.handleFrame(status("other", 2, "wrong-session")); // wrong session — ignored
    expect(footerText(h).content).toBe(first);

    h.app.handleFrame(status("s1", 2, "glm-6"));
    expect(footerText(h).content).toContain("glm-6");
  });

  it("keeps truthful unknown metrics (?/?) and truncates at narrow widths", () => {
    const line = formatRuntimeStatus({ sessionId: "s1", revision: 1, model: "m" }, 100);
    expect(line).toContain("?/?");
    const narrow = formatRuntimeStatus({ sessionId: "s1", revision: 1, model: "m" }, 4);
    expect(narrow.length).toBe(4);
    expect(narrow.endsWith("…")).toBe(true);
  });

  it("drops the cwd field entirely (it is never projected)", () => {
    // The renderer never receives cwd in the footer projection; a status
    // carrying cwd must not leak it into the footer line.
    const line = formatRuntimeStatus(
      { sessionId: "s1", revision: 1, model: "m", cwd: "/home/secret-user/projects" } as TuiRuntimeStatus,
      200,
    );
    expect(line).not.toContain("/home/");
  });
});

describe("TuiApp — lifecycle reset and failure recovery (design §5/§6)", () => {
  it("clears transcript/streams/activity/discussion/status on an authoritative post-initial ready", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.submitUserText("hello");
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", kind: "text", delta: "x" });
    h.app.handleFrame(status("s1", 1, "m1"));
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 1,
      snapshot: {
        sessionId: "s1", busy: true, sequence: 1, activeChildren: [], recentDirectChildren: [],
        root: { id: 7, title: "p", status: "running", priority: "HIGH", type: "project", parentId: null, tokensUsed: null },
      },
    });
    h.app.handleFrame({
      t: "activity",
      sequence: 2,
      event: { kind: "channel.message", from: "worker", to: "orc", message: "hi", sequence: 2, timestamp: 0, sessionId: "s1", executionId: "e1" },
    });

    h.app.resetForReady("Main #2", "s2");

    expect(transcriptChildren(h).length).toBe(0);
    expect(activityChildren(h).length).toBe(0);
    expect(discussionChildren(h).length).toBe(0);
    expect(footerText(h).content).toBe("");
    expect(h.app.sessionId).toBe("s2");
  });

  it("routes a component-construction throw to onRenderError without crashing", () => {
    const modules = makeModules();
    const ThrowingAssistant = class extends FakeContainer {
      constructor(..._args: unknown[]) {
        super();
        throw new Error("boom from AssistantMessageComponent");
      }
    };
    modules.codingAgent.AssistantMessageComponent = ThrowingAssistant as never;

    const ui = new FakeTUI();
    const renderErrors: Error[] = [];
    const app = new TuiApp({
      modules,
      terminal: new FakeProcessTerminal(),
      ui,
      editor: new FakeEditor(ui, {}),
      onRenderError: (err) => { renderErrors.push(err); },
    });
    app.resetForReady("Main #1", "s1");
    expect(renderErrors.length).toBe(0); // shell build must not construct rows
    app.handleFrame({ t: "message", role: "assistant", markdown: "x" });
    expect(renderErrors.length).toBe(1);
    expect(renderErrors[0]!.message).toContain("boom");
  });

  it("dispose is idempotent and stops the loader", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    const stopsBefore = h.loader.stop.mock.calls.length;
    h.app.dispose();
    h.app.dispose();
    expect(h.loader.stop.mock.calls.length).toBeGreaterThanOrEqual(stopsBefore + 1);
    // Frames after dispose are no-ops.
    expect(() => h.app.handleFrame({ t: "message", role: "assistant", markdown: "x" })).not.toThrow();
  });
});

describe("TuiApp — assistant message factory (design §2.1)", () => {
  it("builds a runtime-valid assistant message with zero usage", () => {
    const msg = makeAssistantMessage([{ type: "text", text: "text" }], "pending");
    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([{ type: "text", text: "text" }]);
    expect(msg.stopReason).toBe("pending");
    expect(msg.usage.input).toBe(0);
    // Provider/model metadata must not be copied into transcript content.
    expect(JSON.stringify(msg.content)).not.toContain("provider");
  });

  it("#1619: maps ordered text/thinking blocks into native content parts", () => {
    const msg = makeAssistantMessage([
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "answer" },
    ], "stop");
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "answer" },
    ]);
  });

  it("#1619: appendAssistantBlock merges adjacent same-kind deltas and opens blocks on transitions", () => {
    const blocks: import("./tui-ui.js").AssistantBlock[] = [];
    appendAssistantBlock(blocks, "thinking", "a", 1024);
    appendAssistantBlock(blocks, "thinking", "b", 1024);
    appendAssistantBlock(blocks, "text", "c", 1024);
    appendAssistantBlock(blocks, "text", "d", 1024);
    expect(blocks).toEqual([
      { type: "thinking", thinking: "ab" },
      { type: "text", text: "cd" },
    ]);
  });
});

describe("TuiApp — #1319 sanitized channel discussion (R4/R5)", () => {
  function channel(sequence: number, message: string, extra?: Record<string, unknown>): TuiServerFrame {
    return {
      t: "activity",
      sequence,
      event: {
        kind: "channel.message",
        from: "worker",
        to: "orc",
        message,
        sequence,
        timestamp: 0,
        sessionId: "s1",
        executionId: "e1",
        cardId: 7,
        ...extra,
      } as never,
    };
  }

  it("renders discussion as bounded plain text with from -> to provenance in its own region", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame(channel(1, "hello worker team"));
    h.app.handleFrame(channel(2, "second message"));

    const rows = discussionChildren(h);
    expect(rows.length).toBe(2);
    expect(rows[0]!.content).toBe("[worker -> orc] hello worker team");
    expect(rows[1]!.content).toBe("[worker -> orc] second message");
    // Distinct untrusted style applied at construction (4th Text arg).
    expect(typeof rows[0]!.style).toBe("function");
    // Never leaked into the semantic status region or transcript.
    expect(activityChildren(h).length).toBe(0);
    expect(transcriptChildren(h).length).toBe(0);
  });

  it("preserves message order and never replaces by card identity", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    // Two messages for the SAME card, interleaved with a different card.
    h.app.handleFrame(channel(1, "first", { cardId: 7 }));
    h.app.handleFrame(channel(2, "second", { cardId: 8 }));
    h.app.handleFrame(channel(3, "third", { cardId: 7 }));
    const rows = discussionChildren(h);
    expect(rows.map((t) => t.content)).toEqual([
      "[worker -> orc] first",
      "[worker -> orc] second",
      "[worker -> orc] third",
    ]);
  });

  it("strips hostile ANSI/OSC/control payloads completely before rendering", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    // CSI color + OSC title + DCS payload + C0/C1 controls + multiline trick.
    // "RED" is ordinary text AFTER the CSI sequence — it stays as plain text;
    // only the escape sequences and controls are stripped.
    const hostile = "esc\u001b[31mRED\u001b]0;title\u0007\u001bPdcs\u001b\\\nline1\rline2\t\"\u0000";
    h.app.handleFrame(channel(1, hostile));
    const rows = discussionChildren(h);
    expect(rows.length).toBe(1);
    const content = rows[0]!.content;
    expect(content).not.toMatch(/\u001b/);        // no ESC anywhere
    expect(content).not.toMatch(/title|dcs/);     // no control payload tails
    expect(content).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/); // no controls
    expect(content).toBe('[worker -> orc] escRED line1 line2 "');
  });

  it("bounds fields UTF-8 safely, drops empty messages, and rejects extra fields", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    // Empty after sanitization → dropped entirely.
    h.app.handleFrame(channel(1, "\u001b[31m \u001b[0m"));
    // Hostile extras (secret-shaped) never enter rendering.
    h.app.handleFrame(channel(2, "real", {
      title: "SECRET PROMPT",
      channel: { id: "secret", payload: "x" },
      args: { tool: "read", input: "/etc/shadow" },
      notes: "secret note",
    } as never));
    // Oversized message + provenance are bounded (UTF-8 safe, no partial char).
    h.app.handleFrame(channel(3, `${"x".repeat(510)}😀${"y".repeat(100)}`));
    h.app.handleFrame(channel(4, "ok", { from: `${"f".repeat(100)}😀`, to: `${"t".repeat(100)}` } as never));

    const rows = discussionChildren(h);
    expect(rows.length).toBe(3);
    expect(rows[0]!.content).toBe("[worker -> orc] real");
    expect(rows[0]!.content).not.toMatch(/SECRET|payload|shadow|secret note/);
    // Message bounded to 512 UTF-8 bytes without splitting the surrogate pair.
    const bounded = rows[1]!.content;
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual("[worker -> orc] ".length + 512);
    expect(bounded.includes("😀")).toBe(false); // 512-byte cap cut before the emoji
    // Provenance bounded per field (64 bytes each).
    const prov = rows[2]!.content;
    expect(prov.startsWith("[")).toBe(true);
    expect(Buffer.byteLength(prov.split("]")[0]!, "utf8")).toBeLessThanOrEqual(64 + 64 + 8);
  });

  it("discussion churn cannot starve card terminal state and keeps its own window", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 1,
      snapshot: {
        sessionId: "s1", busy: true, sequence: 1, activeChildren: [], recentDirectChildren: [],
        root: { id: 1, title: "p", status: "running", priority: "HIGH", type: "project", parentId: null, tokensUsed: null },
      },
    });
    // Flood discussion well past the semantic row budget.
    for (let i = 2; i <= 40; i++) h.app.handleFrame(channel(i, `msg ${i}`));
    // A card terminal event must still render in the semantic region.
    h.app.handleFrame({
      t: "activity",
      sequence: 41,
      event: { kind: "card.completed", title: "t", status: "done", cardId: 9, sequence: 41, timestamp: 0, sessionId: "s1", executionId: "e1" },
    });
    expect(activityChildren(h).some((t) => t.content === "card #9 done")).toBe(true);
    // Discussion keeps its newest bounded window (cap 50) — 39 rows here.
    expect(discussionChildren(h).length).toBe(39);
  });

  it("recovery snapshot replaces semantic status only — discussion is preserved", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame(channel(1, "discussed"));
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 5,
      snapshot: {
        sessionId: "s1", busy: true, sequence: 5, activeChildren: [], recentDirectChildren: [],
        root: { id: 1, title: "p", status: "running", priority: "HIGH", type: "project", parentId: null, tokensUsed: null },
      },
    });
    expect(discussionChildren(h).length).toBe(1);
    expect(activityChildren(h).length).toBe(1);
    // Newer recovery snapshot replaces semantic rows but must not drop discussion.
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 9,
      snapshot: {
        sessionId: "s1", busy: false, sequence: 9, activeChildren: [], recentDirectChildren: [],
        root: { id: 1, title: "p", status: "done", priority: "HIGH", type: "project", parentId: null, tokensUsed: null },
      },
    });
    expect(activityChildren(h).length).toBe(1);
    expect(activityChildren(h)[0]!.content).toBe("root #1 done");
    expect(discussionChildren(h).length).toBe(1);
    expect(discussionChildren(h)[0]!.content).toBe("[worker -> orc] discussed");
  });

  it("renders a bounded activity-gap marker row when the writer signals omission", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame(channel(1, "before gap"));
    h.app.handleFrame({ t: "activity-gap", sequence: 12 });
    h.app.handleFrame(channel(13, "after gap"));
    const rows = discussionChildren(h);
    expect(rows.length).toBe(3);
    expect(rows[1]!.content).toBe("[some worker/Orc messages omitted]");
    expect(rows[2]!.content).toBe("[worker -> orc] after gap");
  });

  it("rejects non-channel activity from the discussion projection", () => {
    expect(projectSafeDiscussion({ kind: "card.running", cardId: 1, status: "running" })).toBeNull();
    expect(projectSafeDiscussion(null)).toBeNull();
    expect(projectSafeDiscussion({ kind: "channel.message", from: 1, message: "x" })).toBeNull();
    expect(projectSafeDiscussion({ kind: "channel.message", from: "w", message: "   " })).toBeNull();
  });
});
