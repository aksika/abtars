/**
 * tui-activity-journey.test.ts — #1319 Task 5 production-composition journey.
 *
 * Composes the REAL OrcActivityFeed, REAL TuiSocketAdapter (unix socket),
 * REAL frame decoder, REAL TuiFrameWriter, and the REAL TuiApp presentation
 * state (fake Pi components only at the public-module seam). Exercises the
 * full operator journey: attach → ready → snapshot → live card activity →
 * sanitized channel discussion → idle-to-active execution binding →
 * replacement attach with zero stale callbacks.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";

vi.setConfig({ testTimeout: 15_000 });
afterAll(() => vi.resetConfig());

vi.mock("../../components/master-user.js", () => ({
  getMasterUserId: () => "aksika",
}));

import { TuiSocketAdapter } from "./tui-socket-adapter.js";
import { createFrameDecoder, encodeFrame, type TuiServerFrame, type TuiClientFrame } from "./tui-protocol.js";
import { OrcActivityFeed } from "../../components/orc-activity-feed.js";
import { Spin, type ManagedSession } from "../../components/spin.js";
import { TuiApp, type TuiPresentationModules } from "../../cli/commands/tui-ui.js";

// ── Fake Pi seam (public-module surface only) ────────────────────────────

class FakeContainer {
  children: unknown[] = [];
  addChild(c: unknown): void { this.children.push(c); }
  removeChild(c: unknown): void { this.children = this.children.filter((x) => x !== c); }
  clear(): void { this.children = []; }
}

class FakeTUI extends FakeContainer {
  requestRender = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  setFocus = vi.fn();
  addInputListener = vi.fn();
}

class FakeProcessTerminal { columns = 100; rows = 30; }

class FakeText {
  constructor(public content: string, public x: number, public y: number, public style?: unknown) {}
  setText = vi.fn((text: string) => { this.content = text; });
}

class FakeMarkdown { constructor(public body: string) {} }
class FakeLoader {
  start = vi.fn(); stop = vi.fn(); setMessage = vi.fn();
  constructor(public ui: unknown, public a: unknown, public b: unknown, public message?: string) {}
}
class FakeEditor {
  borderColor: unknown;
  onSubmit: ((t: string) => void) | null = null;
  constructor(public ui: unknown, public theme: unknown) {}
}
class FakeUserMessage extends FakeContainer { constructor(public text: string) { super(); } }
class FakeAssistantMessage extends FakeContainer {
  updateContent = vi.fn();
  constructor(public message?: unknown) { super(); }
}
class FakeDynamicBorder { constructor(public color?: (s: string) => string) {} }

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
      getMarkdownTheme: vi.fn(() => ({ italic: (s: string) => s })),
      getSelectListTheme: vi.fn(() => ({
        selectedPrefix: (s: string) => s,
        selectedText: (s: string) => s,
        description: (s: string) => s,
        scrollInfo: (s: string) => s,
        noMatch: (s: string) => s,
      })),
      UserMessageComponent: FakeUserMessage,
      AssistantMessageComponent: FakeAssistantMessage,
      DynamicBorder: FakeDynamicBorder,
    },
  } as unknown as TuiPresentationModules;
}

// ── Harness ──────────────────────────────────────────────────────────────

interface ClientJourney {
  socket: net.Socket;
  app: TuiApp;
  ui: FakeTUI;
  /** Every decoded frame, oldest first — never spliced (raw observation). */
  frames: TuiServerFrame[];
  close: () => void;
}

function makeSpin(idleOrc: boolean): Spin {
  const spin = new Spin();
  const orc = spin.createSubSession("aksika", "background", "O");
  if (typeof orc === "string") throw new Error(`cannot create Orc session: ${orc}`);
  const entry = spin.getSessionById((orc as ManagedSession).id)!;
  if (idleOrc) {
    entry.activeExecutionId = undefined;
    entry.activeRootCardId = undefined;
    entry.busy = false;
  }
  return spin;
}

function tmpSocketPath(): string {
  return path.join(os.tmpdir(), `tui-journey-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

async function attachJourney(socketPath: string): Promise<ClientJourney> {
  const decoder = createFrameDecoder<TuiServerFrame>();
  const frames: TuiServerFrame[] = [];
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.on("data", (buf: Buffer) => {
    for (const f of decoder.push(buf)) frames.push(f);
  });

  const app = new TuiApp({
    modules: makeModules(),
    terminal: new FakeProcessTerminal(),
    ui: new FakeTUI(),
    editor: new FakeEditor(new FakeTUI(), {}),
    onRenderError: vi.fn(),
  });

  const attach: TuiClientFrame = { t: "attach", mode: { kind: "orc" }, cols: 100, rows: 30 };
  socket.write(encodeFrame(attach));

  // Route every decoded server frame through the real TuiApp presentation
  // (cursor-based; the raw `frames` list stays untouched for assertions).
  let cursor = 0;
  const poller = setInterval(() => {
    while (cursor < frames.length) {
      const frame = frames[cursor]!;
      cursor++;
      if (frame.t !== "error") app.handleFrame(frame);
    }
  }, 5);

  return {
    socket,
    app,
    ui: app["_ui"] as FakeTUI,
    frames,
    close: () => { clearInterval(poller); socket.destroy(); },
  };
}

function pause(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function activityRegion(app: TuiApp): FakeText[] {
  const c = app["_activity"] as FakeContainer | null;
  return ((c?.children ?? []) as FakeText[]);
}

function discussionRegion(app: TuiApp): FakeText[] {
  const c = app["_discussion"] as FakeContainer | null;
  return ((c?.children ?? []) as FakeText[]);
}

// ── The journey ──────────────────────────────────────────────────────────

describe("TUI Orc activity journey (production composition)", () => {
  let sockPath: string;
  let adapter: TuiSocketAdapter;
  let feed: OrcActivityFeed;
  /** The REAL session id the live registry assigns to the Orc subsession. */
  let sessionId: string;

  beforeEach(() => {
    sockPath = tmpSocketPath();
    feed = new OrcActivityFeed();
  });

  afterEach(() => { adapter?.stop(); });

  it("ready → snapshot → live card activity → sanitized discussion → idle-to-active binding → replacement attach", async () => {
    const spin = makeSpin(true); // idle persistent Orc at attach time
    sessionId = spin.getOrcSession()!.id;
    adapter = new TuiSocketAdapter({
      spin,
      onMessage: vi.fn(),
      socketPath: sockPath,
      orcActivityFeed: feed,
    });
    await adapter.start();

    const journey = await attachJourney(sockPath);
    await pause(80);

    // 1. ready + snapshot arrived (status may race ahead of snapshot; both
    //    must precede the first activity event).
    expect(journey.frames.some((f) => f.t === "ready")).toBe(true);
    const snapshots = journey.frames.filter((f) => f.t === "activity-snapshot");
    expect(snapshots.length).toBe(1);

    // 2. Live card activity + channel discussion through the production feed.
    feed.publish({
      kind: "execution.started", sessionId, executionId: "exec_1",
    } as never);
    feed.publish({
      kind: "card.queued", title: "build the thing", status: "queued",
      cardId: 11, sessionId, executionId: "exec_1",
    } as never);
    feed.publish({
      kind: "channel.message", from: "worker", to: "orc",
      message: "starting now\u001b[31m", cardId: 11, sessionId, executionId: "exec_1",
    } as never);
    feed.publish({
      kind: "card.completed", title: "build the thing", status: "done",
      cardId: 11, sessionId, executionId: "exec_1",
    } as never);
    feed.publish({ kind: "execution.completed", summary: "all done", sessionId, executionId: "exec_1" } as never);
    await pause(120);

    // Semantic rows: card rows are keyed by identity and update in place —
    // the queued state was replaced by the terminal "done" state.
    const statusRows = activityRegion(journey.app).map((t) => t.content);
    expect(statusRows).toContain("card #11 done");
    expect(statusRows).not.toContain("card #11 queued");
    expect(statusRows).toContain("execution "); // execution.started row
    // Sanitized discussion: the CSI tail is stripped before plain-text render.
    expect(discussionRegion(journey.app).map((t) => t.content)).toEqual([
      "[worker -> orc] starting now",
    ]);

    // 3. Idle-to-active: a SECOND execution follows the same attachment.
    feed.publish({ kind: "execution.started", sessionId, executionId: "exec_2" } as never);
    feed.publish({
      kind: "card.queued", title: "phase two", status: "queued",
      cardId: 22, sessionId, executionId: "exec_2",
    } as never);
    await pause(120);
    expect(activityRegion(journey.app).map((t) => t.content)).toContain("card #22 queued");

    // 4. Replacement attach: the old client receives no stale activity, the
    //    new attachment starts fresh in idle-follow and binds to the next
    //    execution.
    const second = await attachJourney(sockPath);
    await pause(80);
    const firstFrameCount = journey.frames.length;
    feed.publish({ kind: "execution.started", sessionId, executionId: "exec_3" } as never);
    feed.publish({
      kind: "card.queued", title: "post-replace", status: "queued",
      cardId: 33, sessionId, executionId: "exec_3",
    } as never);
    await pause(120);

    const staleOnFirst = journey.frames.slice(firstFrameCount).filter((f) => f.t === "activity");
    expect(staleOnFirst.length).toBe(0);
    expect(activityRegion(second.app).map((t) => t.content)).toContain("card #33 queued");
    // The old app keeps its prior rows (already-rendered state is not rewound).
    expect(activityRegion(journey.app).map((t) => t.content)).not.toContain("card #33 queued");

    journey.close();
    second.close();
  });
});
