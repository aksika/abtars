/**
 * tui-ready-guard.test.ts — #1570 regression: `abtars tui` must call pi-tui
 * TUI.start() exactly once per client lifetime, even when the bridge emits a
 * fresh `ready` frame per attachment change (commitAttachment, #1533 rebind).
 * pi-tui's start() is not idempotent — a second call registers a second stdin
 * data listener and every keystroke is processed twice.
 *
 * #1612: the client loads TWO public module surfaces (pi-tui + pi-coding-agent)
 * and constructs the TuiApp render shell; the fake modules below provide both.
 * The honest observable proxy for the pi-tui-side double-listener is the
 * call count on `TUI.start()`.
 */

import { EventEmitter } from "node:events";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));

vi.mock("../../components/pi-installation.js", () => ({
  resolvePiInstallation: vi.fn(),
  loadPiModule: vi.fn(),
}));

const fakeSocket = new EventEmitter() as EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
fakeSocket.write = vi.fn();
fakeSocket.destroy = vi.fn();
fakeSocket.end = vi.fn();

vi.mock("node:net", () => ({
  createConnection: vi.fn(() => fakeSocket),
}));

import { encodeFrame } from "../../platforms/tui/tui-protocol.js";
import { resolvePiInstallation, loadPiModule } from "../../components/pi-installation.js";
import { tui } from "./tui.js";

function fakeModules() {
  const ui = {
    addChild: vi.fn(),
    setFocus: vi.fn(),
    addInputListener: vi.fn(),
    requestRender: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const editor = { onSubmit: null as null | ((text: string) => void) };
  const terminal = { columns: 80, rows: 24 };

  class ProcessTerminal {
    columns = 80;
    rows = 24;
  }
  class TUI {
    constructor(public term: unknown, public showCursor: boolean) {}
    addChild = ui.addChild;
    setFocus = ui.setFocus;
    addInputListener = ui.addInputListener;
    requestRender = ui.requestRender;
    start = ui.start;
    stop = ui.stop;
  }
  class Container {
    addChild = vi.fn();
    removeChild = vi.fn();
    clear = vi.fn();
  }
  class Editor {
    constructor(public tuiInstance: unknown, public theme: unknown) {}
    set onSubmit(fn: ((text: string) => void) | null) { editor.onSubmit = fn; }
    get onSubmit() { return editor.onSubmit; }
  }
  class Text {
    constructor(public content: string, public x: number, public y: number) {}
    setText = vi.fn();
  }
  class Markdown {
    constructor(public body: string, public x: number, public y: number, public theme: unknown, public style: unknown) {}
    render = (w: number): string[] => [this.body];
  }
  class Loader {
    start = vi.fn();
    stop = vi.fn();
    setMessage = vi.fn();
    constructor(public ui: unknown, public a: unknown, public b: unknown, public message?: string, public indicator?: unknown) {}
  }
  const matchesKey = (data: string, key: string): boolean => data === `\x03${key}`;

  const pi = { ProcessTerminal, TUI, Container, Editor, Text, Markdown, Loader, matchesKey };

  class UserMessageComponent extends Container {
    constructor(public text: string, public theme: unknown, public pad?: number) { super(); }
  }
  class AssistantMessageComponent extends Container {
    updateContent = vi.fn();
    constructor(public message?: unknown, public hideThinking?: boolean, public theme?: unknown, public label?: string, public pad?: number) { super(); }
  }
  class DynamicBorder {
    constructor(public color?: (s: string) => string) {}
    render = (w: number): string[] => ["─"];
  }
  const codingAgent = {
    initTheme: vi.fn(),
    getMarkdownTheme: vi.fn(() => ({})),
    UserMessageComponent,
    AssistantMessageComponent,
    DynamicBorder,
  };

  return { ui, editor, terminal, pi, codingAgent };
}

describe("tui client — repeated ready frames (#1570 + #1612)", () => {
  let h: ReturnType<typeof fakeModules>;

  beforeEach(() => {
    h = fakeModules();
    vi.mocked(resolvePiInstallation).mockReturnValue({
      state: "compatible",
      installation: {
        executable: "/usr/bin/pi",
        packageRoot: "/usr/lib/pi-coding-agent",
        version: "0.83.0",
        source: "path",
        pinStatus: "at-pin",
        moduleRoots: { ai: "/tmp/pi-ai", tui: "/tmp/pi-tui", agentCore: "/tmp/pi-agent-core" },
      },
    });
    vi.mocked(loadPiModule).mockImplementation(async (_installation, spec) => {
      return spec.package === "@earendil-works/pi-tui" ? h.pi : h.codingAgent;
    });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.mocked(process.exit).mockRestore();
    vi.mocked(resolvePiInstallation).mockReset();
    vi.mocked(loadPiModule).mockReset();
    fakeSocket.write.mockClear();
    fakeSocket.destroy.mockClear();
    fakeSocket.end.mockClear();
    fakeSocket.removeAllListeners();
  });

  it("calls TUI.start() exactly once when the bridge emits two ready frames", async () => {
    const client = tui([]);
    await vi.waitFor(() => expect(fakeSocket.listeners("connect").length).toBe(1));

    fakeSocket.emit("connect");
    const ready1 = Buffer.from(encodeFrame({ t: "ready", sessionLabel: "M", sessionId: "s1" }));
    const ready2 = Buffer.from(encodeFrame({ t: "ready", sessionLabel: "M", sessionId: "s2" }));
    fakeSocket.emit("data", ready1);
    fakeSocket.emit("data", ready2);

    expect(h.ui.start).toHaveBeenCalledTimes(1);

    // The second ready frame still updates the tracked session: a steer written
    // after it must target s2, not s1.
    h.editor.onSubmit?.("/steer hello");
    const steer = fakeSocket.write.mock.calls.map(c => c[0]).find(w => String(w).includes('"steer"'));
    expect(steer).toBeDefined();
    expect(JSON.parse(steer as unknown as string)).toMatchObject({ t: "steer", sessionId: "s2" });

    fakeSocket.emit("close");
    await client;
    // stop() defers process.exit to the next tick — flush it while the spy
    // is still installed so the real exit never runs.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("starts the UI on the first ready frame even when it arrives late", async () => {
    const client = tui([]);
    await vi.waitFor(() => expect(fakeSocket.listeners("connect").length).toBe(1));

    fakeSocket.emit("connect");
    fakeSocket.emit("data", Buffer.from(encodeFrame({ t: "ready", sessionLabel: "M", sessionId: "s9" })));

    expect(h.ui.start).toHaveBeenCalledTimes(1);

    fakeSocket.emit("close");
    await client;
    await new Promise((resolve) => setImmediate(resolve));
  });
});
