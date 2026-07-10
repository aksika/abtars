/**
 * tui-socket-adapter.test.ts — #1315 adapter tests.
 *
 * Verifies: server lifecycle (start/stop, chmod 0600, unlink), new-attach-wins
 * eviction, attach selector resolution + bridge-side type gating, setMessageHandler
 * swap, Orc busy-guard rejection, Orc idle spin with [USER] prefix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../components/master-user.js", () => ({
  getMasterUserId: () => "aksika",
}));

import { TuiSocketAdapter } from "./tui-socket-adapter.js";
import {
  encodeFrame,
  createFrameDecoder,
  type TuiServerFrame,
  type TuiClientFrame,
  type TuiAttachMode,
} from "./tui-protocol.js";
import type { Spin, ManagedSession, SessionType } from "../../components/spin.js";
import type { AgentSession } from "../../components/subagent-runtime.js";
import type { InboundMessage } from "../../types/platform.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function tmpSocketPath(): string {
  return path.join(os.tmpdir(), `tui-sock-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

interface MockSpinOpts {
  activeSessionId?: string;
  switchResult?: ManagedSession | string;
  createResult?: ManagedSession | string;
  orcSession?: AgentSession | null;
  orcBusy?: boolean;
  spinResult?: { sessionId: string; cardId?: number; result?: string };
}

function makeMockSpin(opts: MockSpinOpts = {}): { spin: Spin; calls: { getActiveSessionId: Array<[string, string]>; switchSession: Array<[string, string, number]>; createSession: Array<[string, string, SessionType]>; spin: Array<unknown[]> } } {
  const calls = { getActiveSessionId: [] as Array<[string, string]>, switchSession: [] as Array<[string, string, number]>, createSession: [] as Array<[string, string, SessionType]>, spin: [] as unknown[][] };
  // The orc ManagedSession is what listAllSessions().find(...) returns and
  // what carries the busy flag.
  const orcManagedEntry: ManagedSession | undefined = opts.orcSession
    ? ({ id: opts.orcSession.id, busy: opts.orcBusy ?? false } as unknown as ManagedSession)
    : undefined;
  const spin: Partial<Spin> = {
    getActiveSessionId: vi.fn((userId: string, platform: string) => {
      calls.getActiveSessionId.push([userId, platform]);
      return opts.activeSessionId ?? "1749563282_A_01";
    }),
    switchSession: vi.fn((userId: string, platform: string, index: number) => {
      calls.switchSession.push([userId, platform, index]);
      return opts.switchResult ?? { id: `1749563282_C_0${index}` } as ManagedSession;
    }),
    createSession: vi.fn((userId: string, platform: string, type: SessionType) => {
      calls.createSession.push([userId, platform, type]);
      return opts.createResult ?? { id: `1749563282_${type}_99` } as ManagedSession;
    }),
    getOrcSession: vi.fn(() => opts.orcSession ?? null),
    getSessionById: vi.fn((id: string) => {
      if (!opts.orcSession || id !== opts.orcSession.id) return undefined;
      return { id, busy: opts.orcBusy ?? false } as unknown as ManagedSession;
    }),
    listAllSessions: vi.fn(() => orcManagedEntry ? [orcManagedEntry] : []),
    spin: vi.fn(async (spec: unknown) => {
      calls.spin.push([spec]);
      return opts.spinResult ?? { sessionId: "1749563282_O_01", cardId: 1, result: "orc-reply" };
    }),
  };
  return { spin: spin as Spin, calls };
}

/** Open a connection, send the attach frame, collect all frames the server pushes. */
async function attachAndCollect(
  socketPath: string,
  mode: TuiAttachMode,
  cols = 80,
  rows = 24,
): Promise<{ conn: net.Socket; frames: TuiServerFrame[]; decoder: (chunk: string) => TuiServerFrame[] }> {
  const frames: TuiServerFrame[] = [];
  const decoder = createFrameDecoder<TuiServerFrame>();
  const conn = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    conn.once("connect", () => resolve());
    conn.once("error", reject);
  });
  conn.on("data", (buf: Buffer) => {
    for (const f of decoder(buf.toString())) frames.push(f);
  });
  const attach: TuiClientFrame = { t: "attach", mode, cols, rows };
  conn.write(encodeFrame(attach));
  // Wait briefly for the round-trip — attach→ready is sync after start.
  await new Promise((r) => setTimeout(r, 50));
  return { conn, frames, decoder };
}

function makeRecoveryHandler() {
  return vi.fn(async (_msg: InboundMessage) => { /* queue-and-go */ });
}

// ── Server lifecycle (Task 3) ──────────────────────────────────────────

describe("TuiSocketAdapter — server lifecycle", () => {
  let sockPath: string;
  let adapter: TuiSocketAdapter;
  let mockSpin: Spin;

  beforeEach(() => {
    sockPath = tmpSocketPath();
    mockSpin = makeMockSpin().spin;
    adapter = new TuiSocketAdapter({
      spin: mockSpin,
      onMessage: makeRecoveryHandler(),
      socketPath: sockPath,
    });
  });

  afterEach(() => {
    if (adapter) adapter.stop();
  });

  it("starts and listens on the socket path", async () => {
    await adapter.start();
    expect(adapter.isListening).toBe(true);
    expect(fs.existsSync(sockPath)).toBe(true);
  });

  it("chmods the socket to 0o600", async () => {
    await adapter.start();
    const stat = fs.statSync(sockPath);
    // Mask to permission bits. Owner-only read+write = 0o600.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("removes the socket file on stop", async () => {
    await adapter.start();
    expect(fs.existsSync(sockPath)).toBe(true);
    adapter.stop();
    expect(fs.existsSync(sockPath)).toBe(false);
    expect(adapter.isListening).toBe(false);
  });

  it("removes a stale socket file on start", async () => {
    fs.writeFileSync(sockPath, "stale");
    expect(fs.existsSync(sockPath)).toBe(true);
    await adapter.start();
    expect(adapter.isListening).toBe(true);
    // Stale content is gone — the inode is now a real socket (not a regular file).
    const stat = fs.statSync(sockPath);
    expect(stat.isSocket()).toBe(true);
  });

  it("rejects writes to a missing client without throwing", async () => {
    await adapter.start();
    // No client attached — sendMessage must not throw.
    await expect(adapter.sendMessage("tui:local", "hello")).resolves.toBeUndefined();
  });
});

// ── New-attach-wins (Task 3) ──────────────────────────────────────────

describe("TuiSocketAdapter — new-attach-wins", () => {
  let sockPath: string;
  let adapter: TuiSocketAdapter;

  beforeEach(async () => {
    sockPath = tmpSocketPath();
    const mock = makeMockSpin();
    adapter = new TuiSocketAdapter({
      spin: mock.spin,
      onMessage: makeRecoveryHandler(),
      socketPath: sockPath,
    });
    await adapter.start();
  });

  afterEach(() => { adapter.stop(); });

  it("evicts the first client when a second attaches (first gets `error` and is destroyed)", async () => {
    const first = await attachAndCollect(sockPath, { kind: "resume" });
    expect(first.frames.map((f) => f.t)).toContain("ready");

    // Second attach: should evict the first.
    const second = await attachAndCollect(sockPath, { kind: "resume" });
    expect(second.frames.map((f) => f.t)).toContain("ready");

    // First conn should now see a "superseded" error and close.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      first.conn.once("close", () => { clearTimeout(timer); resolve(); });
    });
    const errorFrames = first.frames.filter((f) => f.t === "error");
    expect(errorFrames.length).toBe(1);
    const err = errorFrames[0]!;
    expect(err.t).toBe("error");
    if (err.t === "error") {
      expect(err.message).toMatch(/superseded/i);
    }
    expect(first.conn.destroyed).toBe(true);

    // Cleanup
    second.conn.destroy();
  });

  // ── #1334: decoder state must be per-connection ───────────────────
  // Before the fix, the adapter held one frame decoder for its whole
  // lifetime. Bytes A left buffered (e.g. a partial attach frame without
  // a trailing newline) were concatenated with B's first frame, which
  // produced malformed JSON that the decoder silently dropped — so B
  // never received `ready`. After the fix, each connection owns its own
  // decoder; A's leftovers can never contaminate B.
  it("A's partial frame is NOT combined with B's first frame — B still receives `ready`", async () => {
    // First conn: connect, write a half-attach frame (no trailing \n).
    // The server's data handler reads it and the decoder buffers the
    // remainder. Pre-fix, this remainder is the adapter's singleton
    // decoder's state and will be combined with the next conn's bytes.
    const first = await new Promise<{ conn: net.Socket; frames: TuiServerFrame[] }>((resolve, reject) => {
      const frames: TuiServerFrame[] = [];
      const dec = createFrameDecoder<TuiServerFrame>();
      const c = net.createConnection(sockPath);
      c.once("connect", () => {
        // Build a half-attach frame: complete JSON, NO trailing \n.
        const halfAttach = JSON.stringify({ t: "attach", mode: { kind: "resume" }, cols: 80, rows: 24 }).slice(0, 35);
        c.write(halfAttach);
        resolve({ conn: c, frames });
      });
      c.once("error", reject);
      c.on("data", (buf: Buffer) => {
        for (const f of dec(buf.toString())) frames.push(f);
      });
    });

    // Give the server time to read & buffer A's partial.
    await new Promise((r) => setTimeout(r, 50));

    // Second conn: complete attach frame (with \n). Pre-fix the adapter's
    // decoder has A's partial buffered; combining yields malformed JSON
    // that the decoder drops, so B never gets `ready`.
    const second = await attachAndCollect(sockPath, { kind: "resume" });
    expect(second.frames.map((f) => f.t)).toContain("ready");

    // A is superseded — should see the error and close.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      first.conn.once("close", () => { clearTimeout(timer); resolve(); });
    });
    expect(first.frames.filter((f) => f.t === "error").length).toBe(1);

    second.conn.destroy();
    first.conn.destroy();
  });

  // Identity guard: data arriving from a socket that has been replaced
  // (new-attach-wins) must not act on the current connection. A late data
  // event from a destroyed conn can be triggered by the OS delivering a
  // final read after close, so we exercise the path with a still-alive
  // conn that is no longer `this.conn` (its close was already handled).
  it("a superseded conn's late close does not clear the current conn's state", async () => {
    const first = await attachAndCollect(sockPath, { kind: "resume" });
    expect(first.frames.map((f) => f.t)).toContain("ready");

    // A second client attaches — evicts the first.
    const second = await attachAndCollect(sockPath, { kind: "resume" });
    expect(second.frames.map((f) => f.t)).toContain("ready");

    // Wait for A's close to fully land on the server side.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      first.conn.once("close", () => { clearTimeout(timer); resolve(); });
    });

    // A's close handler ran while B was current. Verify B is still
    // attached and can still receive server-pushed frames.
    expect(adapter.hasClient).toBe(true);
    await expect(adapter.sendMessage("tui:local", "still here")).resolves.toBeUndefined();
    // The push should have reached B.
    await new Promise((r) => setTimeout(r, 30));
    const msgFrame = second.frames.find((f) => f.t === "message");
    expect(msgFrame).toBeDefined();
    if (msgFrame && msgFrame.t === "message") {
      expect(msgFrame.markdown).toBe("still here");
    }

    second.conn.destroy();
  });
});

// ── Attach selector resolution + type gating (Task 4) ────────────────

describe("TuiSocketAdapter — attach selector resolution", () => {
  let sockPath: string;
  let mock: ReturnType<typeof makeMockSpin>;
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sockPath = tmpSocketPath();
    mock = makeMockSpin();
    onMessage = makeRecoveryHandler();
  });

  afterEach(() => {
    if (mock && (mock.spin as unknown as { getOrcSession: { mockClear?: () => void } }).getOrcSession?.mockClear) {
      vi.clearAllMocks();
    }
  });

  it("resume → calls getActiveSessionId(master, 'tui') and emits `ready`", async () => {
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "resume" });
    expect(mock.calls.getActiveSessionId).toEqual([["aksika", "tui"]]);
    expect(frames.find((f) => f.t === "ready")).toBeDefined();
    conn.destroy(); adapter.stop();
  });

  it("--session N → calls switchSession(master, 'tui', N)", async () => {
    mock = makeMockSpin({ switchResult: { id: "1749563282_C_03" } as ManagedSession });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "session", index: 3 });
    expect(mock.calls.switchSession).toEqual([["aksika", "tui", 3]]);
    const ready = frames.find((f) => f.t === "ready")!;
    expect(ready.t).toBe("ready");
    if (ready.t === "ready") expect(ready.sessionId).toBe("1749563282_C_03");
    conn.destroy(); adapter.stop();
  });

  it("--new C → calls createSession(master, 'tui', 'C')", async () => {
    mock = makeMockSpin({ createResult: { id: "1749563282_C_99" } as ManagedSession });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "new", sessionType: "C" });
    expect(mock.calls.createSession).toEqual([["aksika", "tui", "C"]]);
    expect(frames.find((f) => f.t === "ready")).toBeDefined();
    conn.destroy(); adapter.stop();
  });

  it("bridge-side rejects --new O with an `error` frame and does NOT call createSession", async () => {
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    // Cast: the wire spec only allows A/B/C, but a hostile/buggy client can send O.
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "new", sessionType: "O" as unknown as "A" });
    expect(mock.calls.createSession).toEqual([]);
    const err = frames.find((f) => f.t === "error")!;
    expect(err.t).toBe("error");
    if (err.t === "error") expect(err.message).toMatch(/not selectable/i);
    conn.destroy(); adapter.stop();
  });

  it("bridge-side rejects --new T (internal) with an `error` frame", async () => {
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "new", sessionType: "T" as unknown as "A" });
    expect(mock.calls.createSession).toEqual([]);
    expect(frames.find((f) => f.t === "error")).toBeDefined();
    conn.destroy(); adapter.stop();
  });

  it("when switchSession returns a string (rejection), adapter sends `error`", async () => {
    mock = makeMockSpin({ switchResult: "no such session" });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "session", index: 99 });
    const err = frames.find((f) => f.t === "error")!;
    expect(err.t).toBe("error");
    if (err.t === "error") expect(err.message).toBe("no such session");
    conn.destroy(); adapter.stop();
  });
});

// ── setMessageHandler swap (Task 4) ───────────────────────────────────

describe("TuiSocketAdapter — setMessageHandler swap", () => {
  let sockPath: string;
  let mock: ReturnType<typeof makeMockSpin>;
  let initialHandler: ReturnType<typeof vi.fn>;
  let swappedHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sockPath = tmpSocketPath();
    mock = makeMockSpin();
    initialHandler = vi.fn();
    swappedHandler = vi.fn();
  });

  it("initially routes input through onMessage; after setMessageHandler, routes through the new handler", async () => {
    const adapter = new TuiSocketAdapter({
      spin: mock.spin,
      onMessage: initialHandler,
      socketPath: sockPath,
    });
    await adapter.start();
    const { conn } = await attachAndCollect(sockPath, { kind: "resume" });
    conn.write(encodeFrame({ t: "input", text: "first" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(initialHandler).toHaveBeenCalledTimes(1);
    expect(initialHandler.mock.calls[0]![0]!.text).toBe("first");

    // Swap in the pipeline handler.
    adapter.setMessageHandler(swappedHandler);
    conn.write(encodeFrame({ t: "input", text: "second" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(swappedHandler).toHaveBeenCalledTimes(1);
    expect(swappedHandler.mock.calls[0]![0]!.text).toBe("second");
    expect(initialHandler).toHaveBeenCalledTimes(1);  // not called again

    conn.destroy(); adapter.stop();
  });

  it("input frame is synthesized with platform='tui' and channelId='tui:local'", async () => {
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage: initialHandler, socketPath: sockPath });
    await adapter.start();
    const { conn } = await attachAndCollect(sockPath, { kind: "resume" });
    conn.write(encodeFrame({ t: "input", text: "hello" }));
    await new Promise((r) => setTimeout(r, 30));
    const msg = initialHandler.mock.calls[0]![0]!;
    expect(msg.platform).toBe("tui");
    expect(msg.channelId).toBe("tui:local");
    expect(msg.userId).toBe("aksika");  // master
    expect(msg.isGroup).toBe(false);
    conn.destroy(); adapter.stop();
  });
});

// ── Orc query mode + busy-guard (Task 5) ──────────────────────────────

describe("TuiSocketAdapter — orc mode", () => {
  let sockPath: string;
  let mock: ReturnType<typeof makeMockSpin>;
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sockPath = tmpSocketPath();
    mock = makeMockSpin();
    onMessage = makeRecoveryHandler();
  });

  it("orc attach against a missing Orc returns the 'not available' message (no spin call)", async () => {
    mock = makeMockSpin({ orcSession: null });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "orc" });
    const err = frames.find((f) => f.t === "error");
    expect(err).toBeDefined();
    expect(mock.calls.spin).toEqual([]);
    conn.destroy(); adapter.stop();
  });

  it("orc attach against a busy Orc rejects the input with a system message and does NOT call spin", async () => {
    const orc = { id: "1749563282_O_01", isReady: true } as unknown as AgentSession;
    mock = makeMockSpin({ orcSession: orc, orcBusy: true });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "orc" });
    expect(frames.find((f) => f.t === "ready")).toBeDefined();

    conn.write(encodeFrame({ t: "input", text: "are you alive?" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(mock.calls.spin).toEqual([]);
    const sysMsg = frames.find((f) => f.t === "message" && (f as { role: string }).role === "system");
    expect(sysMsg).toBeDefined();
    if (sysMsg && sysMsg.t === "message") {
      expect(sysMsg.markdown).toMatch(/busy/i);
    }
    // Critical: input must NOT have been routed to the pipeline.
    expect(onMessage).not.toHaveBeenCalled();

    conn.destroy(); adapter.stop();
  });

  it("orc attach against an idle Orc calls spin with [USER] prefix and pushes the awaited result", async () => {
    const orc = { id: "1749563282_O_01", isReady: true } as unknown as AgentSession;
    mock = makeMockSpin({
      orcSession: orc,
      orcBusy: false,
      spinResult: { sessionId: "1749563282_O_01", cardId: 1, result: "yes, alive" },
    });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "orc" });
    expect(frames.find((f) => f.t === "ready")).toBeDefined();

    conn.write(encodeFrame({ t: "input", text: "are you alive?" }));
    await new Promise((r) => setTimeout(r, 100));

    expect(mock.calls.spin.length).toBe(1);
    const spec = mock.calls.spin[0]![0] as { type: string; sessionId: string; prompt: string; await: boolean };
    expect(spec.type).toBe("O");
    expect(spec.sessionId).toBe("1749563282_O_01");
    expect(spec.prompt).toBe("[USER] are you alive?");
    expect(spec.await).toBe(true);

    const assistantMsg = frames.find((f) => f.t === "message" && (f as { role: string }).role === "assistant");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && assistantMsg.t === "message") {
      expect(assistantMsg.markdown).toBe("yes, alive");
    }
    expect(onMessage).not.toHaveBeenCalled();

    conn.destroy(); adapter.stop();
  });
});
