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
  projectSafeActivity,
  projectActivitySnapshot,
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
  constructor(public content: string, public x: number, public y: number) {}
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
      TUI: FakeTUI,
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

/** Children of the transcript region (4th child of the TUI root). */
function transcriptChildren(h: Harness): unknown[] {
  return (h.ui.children[3] as FakeContainer).children;
}

function assistantRows(h: Harness): FakeAssistantMessage[] {
  return transcriptChildren(h).filter((c) => c instanceof FakeAssistantMessage) as FakeAssistantMessage[];
}

function systemRows(h: Harness): FakeMarkdown[] {
  return transcriptChildren(h).filter((c) => c instanceof FakeMarkdown) as FakeMarkdown[];
}

function activityChildren(h: Harness): FakeText[] {
  return (h.ui.children[1] as FakeContainer).children as FakeText[];
}

function footerText(h: Harness): FakeText {
  return h.ui.children[5] as FakeText;
}

const ready = (sessionLabel = "Main #1", sessionId = "s1"): TuiServerFrame => ({ t: "ready", sessionLabel, sessionId });

function status(sessionId: string, revision: number, model?: string): TuiServerFrame {
  return { t: "status", status: { sessionId, revision, model } as TuiRuntimeStatus };
}

describe("TuiApp — shell construction (#1612)", () => {
  it("builds separate regions and requests native user/assistant components", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    expect(h.ui.children.length).toBe(6); // header, activity, busy, transcript, editor, footer
    expect(h.ui.setFocus).toHaveBeenCalledTimes(1);
    expect(h.loader.stop).toHaveBeenCalled(); // idle on startup

    h.app.submitUserText("hello world");
    const rows = transcriptChildren(h);
    expect(rows.length).toBe(1);
    expect(rows[0]).toBeInstanceOf(FakeUserMessage);
    expect((rows[0] as FakeUserMessage).text).toBe("hello world");
  });
});

describe("TuiApp — stream grouping and final reconciliation (design §3/§4)", () => {
  it("updates ONE keyed assistant row across chunks and settles to one final row", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", delta: "Hello" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", delta: " world" });
    h.app.handleFrame({ t: "tool-start", id: "st1", executionId: "e1", name: "search" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", delta: "!" });

    // Still exactly one assistant row (never one per delta).
    expect(assistantRows(h).length).toBe(1);
    const pending = assistantRows(h)[0]!;
    expect(pending.updateContent).toHaveBeenCalled();
    const lastMessage = pending.updateContent.mock.calls.at(-1)![0] as { content: Array<{ text: string }> };
    expect(lastMessage.content[0]!.text).toBe("Hello world!");

    h.app.handleFrame({ t: "chunk-end", id: "st1", executionId: "e1", reason: "complete" });
    // Correlated whole result replaces the streamed row with one final row.
    h.app.handleFrame({ t: "message", role: "assistant", markdown: "Hello world!", executionId: "e1" });

    const rows = assistantRows(h);
    expect(rows.length).toBe(1);
    expect(rows[0]!.updateContent.mock.calls.length).toBeLessThanOrEqual(1); // final row is fresh
    // Busy cleared after the execution settles.
    expect(h.loader.stop).toHaveBeenCalled();
  });

  it("keeps the streamed row visible when the whole result is suppressed (exact-match)", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", delta: "streamed" });
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
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", delta: "old" });
    for (let i = 2; i <= 5; i++) {
      h.app.handleFrame({ t: "stream-start", id: `st${i}`, executionId: `e${i}` });
      h.app.handleFrame({ t: "chunk", id: `st${i}`, executionId: `e${i}`, delta: `d${i}` });
    }
    // e1's group was evicted — the whole result must still render (not suppressed).
    h.app.handleFrame({ t: "message", role: "assistant", markdown: "authoritative", executionId: "e1" });
    expect(assistantRows(h).some((r) => (r as FakeAssistantMessage).message !== undefined)).toBe(true);
  });

  it("appends a bounded system note for truncated/error/cancelled streams", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", delta: "partial" });
    h.app.handleFrame({ t: "chunk-end", id: "st1", executionId: "e1", reason: "truncated" });
    const systems = systemRows(h);
    expect(systems.length).toBe(1);
    expect(systems[0]!.body).toMatch(/truncated/i);
    expect(h.loader.stop).toHaveBeenCalled();
  });

  it("creates stream state from a chunk when stream-start was evicted/missing", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({ t: "chunk", id: "st9", executionId: "e9", delta: "first" });
    h.app.handleFrame({ t: "chunk", id: "st9", executionId: "e9", delta: " second" });
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
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", delta: "x" });
    h.app.handleFrame({ t: "chunk-end", id: "st1", executionId: "e1", reason: "complete" });
    expect(h.loader.stop).toHaveBeenCalled();
  });
});

describe("TuiApp — safe activity projection (design §5.1)", () => {
  it("replaces activity rows only for newer snapshots and rejects stale ones", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 5,
      snapshot: { cards: [{ cardId: 7, status: "running" }, { cardId: 8, status: "queued" }] } as never,
    });
    expect(activityChildren(h).length).toBe(2);
    expect(activityChildren(h).map((t) => t.content)).toContain("card #7 running");

    // Older snapshot must be ignored.
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 3,
      snapshot: { cards: [{ cardId: 99, status: "running" }] } as never,
    });
    expect(activityChildren(h).length).toBe(2);

    // Newer snapshot replaces.
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 9,
      snapshot: { cards: [{ cardId: 7, status: "completed" }] } as never,
    });
    const rows = activityChildren(h);
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toBe("card #7 completed");
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
  it("clears transcript/streams/activity/status on an authoritative post-initial ready", () => {
    const h = makeHarness();
    h.app.resetForReady("Main #1", "s1");
    h.app.submitUserText("hello");
    h.app.handleFrame({ t: "stream-start", id: "st1", executionId: "e1" });
    h.app.handleFrame({ t: "chunk", id: "st1", executionId: "e1", delta: "x" });
    h.app.handleFrame(status("s1", 1, "m1"));
    h.app.handleFrame({
      t: "activity-snapshot",
      sequence: 1,
      snapshot: { cards: [{ cardId: 7, status: "running" }] } as never,
    });

    h.app.resetForReady("Main #2", "s2");

    expect(transcriptChildren(h).length).toBe(0);
    expect(activityChildren(h).length).toBe(0);
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
    const msg = makeAssistantMessage("text", "pending");
    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([{ type: "text", text: "text" }]);
    expect(msg.stopReason).toBe("pending");
    expect(msg.usage.input).toBe(0);
    // Provider/model metadata must not be copied into transcript content.
    expect(JSON.stringify(msg.content)).not.toContain("provider");
  });
});
