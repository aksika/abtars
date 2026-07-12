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
import { OrcActivityFeed } from "../../components/orc-activity-feed.js";
import { SessionOutputFeed } from "../../components/session-output-feed.js";

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
  /** #1336: sessions returned by listAllSessions for cross-platform attach. */
  allSessions?: ManagedSession[];
}

function makeMockSpin(opts: MockSpinOpts = {}): { spin: Spin; calls: { getActiveSessionId: Array<[string, string]>; switchSession: Array<[string, string, number]>; createSession: Array<[string, string, SessionType]>; getSessionByGlobalIndex: Array<[number]>; spin: Array<unknown[]> } } {
  const calls = { getActiveSessionId: [] as Array<[string, string]>, switchSession: [] as Array<[string, string, number]>, getSessionByGlobalIndex: [] as Array<[number]>, createSession: [] as Array<[string, string, SessionType]>, spin: [] as unknown[][] };
  // The orc ManagedSession is what listAllSessions().find(...) returns and
  // what carries the busy flag.
  const orcManagedEntry: ManagedSession | undefined = opts.orcSession
    ? ({ id: opts.orcSession.id, busy: opts.orcBusy ?? false,
        instructionQueue: [], activeExecutionId: opts.orcBusy ? "exec_1" : undefined,
        steeringAccepting: opts.orcBusy ?? false } as unknown as ManagedSession)
    : undefined;
  const allEntries: ManagedSession[] = opts.allSessions ?? (orcManagedEntry ? [orcManagedEntry] : []);
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
      return { id, busy: opts.orcBusy ?? false, instructionQueue: [], activeExecutionId: opts.orcBusy ? "exec_1" : undefined, steeringAccepting: opts.orcBusy ?? false } as unknown as ManagedSession;
    }),
    getSessionByGlobalIndex: vi.fn((index: number) => {
      calls.getSessionByGlobalIndex.push([index]);
      if (opts.switchResult && typeof opts.switchResult !== "string") return opts.switchResult;
      return allEntries.find(s => s.shortIndex === index) ?? null;
    }),
    listAllSessions: vi.fn(() => allEntries),
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

/**
 * Poll `check` on a short interval until it returns a truthy value or the
 * bounded timeout elapses. Used instead of fixed `setTimeout` sleeps for
 * state-synchronization waits, since socket scheduling can be slower under
 * loaded CI than on a local machine — a fixed sleep either wastes time
 * (over-provisioned) or flakes (under-provisioned). Rejects on timeout so
 * callers can distinguish "never happened" from a false/undefined result.
 */
async function waitFor<T>(check: () => T, timeoutMs: number, intervalMs = 5): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
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
  let onMessage: ReturnType<typeof makeRecoveryHandler>;

  beforeEach(async () => {
    sockPath = tmpSocketPath();
    const mock = makeMockSpin();
    onMessage = makeRecoveryHandler();
    adapter = new TuiSocketAdapter({
      spin: mock.spin,
      onMessage,
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
        // Resolve once the write callback fires (bytes handed to the
        // kernel) rather than immediately after calling write() — this is
        // the earliest correct signal available from the client side.
        c.write(halfAttach, () => resolve({ conn: c, frames }));
      });
      c.once("error", reject);
      c.on("data", (buf: Buffer) => {
        for (const f of dec(buf.toString())) frames.push(f);
      });
    });

    // Note: there is no externally-observable signal for "the server has
    // buffered A's partial bytes" without instrumenting production code,
    // which we don't do for test convenience. Unix-domain socket delivery
    // on the same host is sub-millisecond, so a short bounded wait here is
    // a reasonable (not zero-risk) synchronization point — this differs
    // from the original fixed 50ms sleep in that it's a small, justified
    // margin rather than an untested guess, and the actual proof of
    // correctness is the assertion below (B receives `ready`), which is
    // the real regression check: if A's partial ever contaminates B's
    // frame, B silently never gets `ready` and the test fails regardless
    // of how long we waited here.
    await new Promise((r) => setTimeout(r, 20));

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

    // Wait for A's close to fully land on the server side (event-driven —
    // the close event itself is the signal, no fixed sleep needed).
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      first.conn.once("close", () => { clearTimeout(timer); resolve(); });
    });

    // A's close handler ran while B was current. Verify B is still
    // attached and can still receive server-pushed frames.
    expect(adapter.hasClient).toBe(true);
    await expect(adapter.sendMessage("tui:local", "still here")).resolves.toBeUndefined();
    // The push should have reached B — poll with a bounded timeout instead
    // of assuming a fixed delivery time.
    const msgFrame = await waitFor(
      () => second.frames.find((f) => f.t === "message"),
      1000,
    );
    expect(msgFrame).toBeDefined();
    if (msgFrame && msgFrame.t === "message") {
      expect(msgFrame.markdown).toBe("still here");
    }

    second.conn.destroy();
  });

  // Identity guard, late DATA (not just late close): a superseded socket
  // that manages to deliver a complete frame after eviction must not be
  // able to act on the new attachment. Forcing this through real socket
  // timing is not reliably deterministic — production's `old.destroy()`
  // runs synchronously during eviction, closing the window before a
  // black-box write from the test can land as a genuinely "late" data
  // event. (Verified empirically: a version of this test relying only on
  // socket write timing still passed with the identity guard temporarily
  // disabled in the source — proof it wasn't exercising the guard.) Per
  // the review's own suggestion, we instead capture the real `data`
  // listener `_onConnection` registers on each server-side socket and
  // invoke it directly for the SUPERSEDED (first) connection after
  // eviction — this calls the exact same code
  // (`conn.on("data", ...)` handler body in `_onConnection`), not a
  // reimplementation, with zero timing dependency.
  it("a superseded conn's late DATA does not reach onMessage or affect the new conn", async () => {
    // _onConnection registers exactly one 'data' listener per server-side
    // socket, in accept order. We can't reliably identify server-side
    // sockets via our own `server.on("connection", ...)` listener (fires
    // after the constructor callback already registered its 'data'
    // listener), and vitest can't spy on the `net.createConnection` ESM
    // export to tag client sockets at creation. Instead, capture EVERY
    // 'data' listener registration globally, then exclude the two known
    // client-side socket objects (`first.conn`, `second.conn` — the exact
    // instances this test itself creates via attachAndCollect) by
    // identity once we have them. This is unambiguous: whatever remains
    // must be server-side, since only client and server sockets in this
    // test register 'data' listeners at all.
    const dataListeners: Array<{ socket: net.Socket; listener: (buf: Buffer) => void }> = [];
    const originalOn = net.Socket.prototype.on;
    const spy = vi.spyOn(net.Socket.prototype, "on").mockImplementation(function (
      this: net.Socket, event: string, listener: (...args: unknown[]) => void,
    ) {
      if (event === "data") dataListeners.push({ socket: this, listener: listener as (buf: Buffer) => void });
      return originalOn.call(this, event, listener);
    });

    try {
      const first = await attachAndCollect(sockPath, { kind: "resume" });
      expect(first.frames.map((f) => f.t)).toContain("ready");
      onMessage.mockClear();

      const second = await attachAndCollect(sockPath, { kind: "resume" });
      expect(second.frames.map((f) => f.t)).toContain("ready");

      // Exclude the two known client-side sockets by identity — whatever
      // remains are the server-side sockets `_onConnection` registered
      // listeners on, in accept order (A's, then B's).
      const serverSideListeners = dataListeners.filter(
        (d) => d.socket !== first.conn && d.socket !== second.conn,
      );
      expect(serverSideListeners.length).toBe(2);
      const aListener = serverSideListeners[0]!.listener;

      // Invoke A's real data listener directly with a complete `input`
      // frame — this is calling the exact handler `_onConnection` wired
      // up for A's connection, at a point where eviction has already run
      // (this.conn is now B's conn, not A's). If the identity guard
      // (`this.conn !== conn`) is intact, this call is a silent no-op.
      const staleInput: TuiClientFrame = { t: "input", text: "STALE-FROM-A-SHOULD-BE-DROPPED" };
      aListener(Buffer.from(encodeFrame(staleInput)));

      // The identity guard must have prevented A's frame from reaching
      // the pipeline. onMessage is only invoked by _handleInput on the
      // CURRENT conn's attached session — it must never fire for A's
      // late input, and it must fire synchronously enough within this
      // tick that a direct assertion (no wait) is valid — there is no
      // async gap between the listener call and _handleFrame/_handleInput
      // dispatch (the guard returns before any await point).
      expect(onMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: "STALE-FROM-A-SHOULD-BE-DROPPED" }),
      );

      // B's attachment must be unaffected — still current, still able to
      // receive pushes, with no contamination from A's frame.
      expect(adapter.hasClient).toBe(true);
      await expect(adapter.sendMessage("tui:local", "B still attached")).resolves.toBeUndefined();
      const msgFrame = await waitFor(
        () => second.frames.find((f) => f.t === "message"),
        1000,
      );
      expect(msgFrame).toBeDefined();
      if (msgFrame && msgFrame.t === "message") {
        expect(msgFrame.markdown).toBe("B still attached");
      }
      expect(second.frames.filter((f) => f.t === "message").length).toBe(1);

      second.conn.destroy();
      try { first.conn.destroy(); } catch { /* already evicted/closed */ }
    } finally {
      spy.mockRestore();
    }
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

  it("resume → picks newest ready Main across platforms, emits `ready`", async () => {
    // #1336: no longer calls getActiveSessionId; uses listAllSessions to find
    // the master's newest ready type-A session. Provide candidates.
    const sessions = [
      { id: "1_A_01", userId: "aksika", platform: "telegram", chatId: 100, active: true, status: "ready", shortIndex: 1, lastActiveAt: 1000, delivery: "streaming" },
      { id: "1_A_02", userId: "aksika", platform: "telegram", chatId: 200, active: false, status: "ready", shortIndex: 2, lastActiveAt: 2000, delivery: "streaming" },
    ] as ManagedSession[];
    mock = makeMockSpin({ allSessions: sessions });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "resume" });
    // listAllSessions was called; the newest ready Main (lastActiveAt=2000) is selected
    const ready = frames.find((f) => f.t === "ready")!;
    expect(ready.t).toBe("ready");
    if (ready.t === "ready") expect(ready.sessionId).toBe("1_A_02");
    conn.destroy(); adapter.stop();
  });

  it("resume with no ready Main → creates TUI-born Main and emits `ready`", async () => {
    // No ready type-A sessions exist → adapter calls createSession for a TUI Main
    mock = makeMockSpin({ createResult: { id: "1749563282_A_99" } as ManagedSession, allSessions: [] });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "resume" });
    expect(mock.calls.createSession).toEqual([["aksika", "tui", "A"]]);
    const ready = frames.find((f) => f.t === "ready")!;
    expect(ready.t).toBe("ready");
    if (ready.t === "ready") expect(ready.sessionId).toBe("1749563282_A_99");
    conn.destroy(); adapter.stop();
  });

  it("--session N → calls getSessionByGlobalIndex(N), emits ready with its id", async () => {
    const target = { id: "1749563282_C_03", userId: "aksika", shortIndex: 3, status: "ready", lastActiveAt: Date.now() } as ManagedSession;
    mock = makeMockSpin({ switchResult: target });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "session", index: 3 });
    // #1336: getSessionByGlobalIndex is called, not switchSession
    expect(mock.calls.getSessionByGlobalIndex).toEqual([[3]]);
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

  it("when getSessionByGlobalIndex returns null, adapter sends `error`", async () => {
    // No allSessions, no switchResult → getSessionByGlobalIndex returns null
    mock = makeMockSpin({ allSessions: [] });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "session", index: 99 });
    const err = frames.find((f) => f.t === "error")!;
    expect(err.t).toBe("error");
    if (err.t === "error") expect(err.message).toMatch(/not found/i);
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

  it("input frame is synthesized with platform='tui', channelId='tui:local', and targetSessionId", async () => {
    // Provide sessions so resume picks one and attaches
    const sessions = [
      { id: "1_A_01", userId: "aksika", platform: "telegram", chatId: 100, active: true, status: "ready", shortIndex: 1, lastActiveAt: 1000, delivery: "streaming" },
    ] as ManagedSession[];
    mock = makeMockSpin({ allSessions: sessions });
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
    // #1336: attached session is carried as routing target
    expect(msg.targetSessionId).toBe("1_A_01");
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

// ── #1332: steering in orc mode ──────────────────────────────────────

describe("TuiSocketAdapter — steer mode", () => {
  let sockPath: string;
  let mock: ReturnType<typeof makeMockSpin>;
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sockPath = tmpSocketPath();
    onMessage = makeRecoveryHandler();
  });

  it("steer client frame on busy Orc queues the instruction and returns steer-ack queued", async () => {
    const orc = { id: "1749563282_O_01", isReady: true } as unknown as AgentSession;
    mock = makeMockSpin({ orcSession: orc, orcBusy: true });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "orc" });
    expect(frames.find((f) => f.t === "ready")).toBeDefined();

    conn.write(encodeFrame({ t: "steer", sessionId: "1749563282_O_01", instructionId: "cid1", text: "focus on memory" }));
    await new Promise((r) => setTimeout(r, 50));

    const ack = frames.find((f) => f.t === "steer-ack");
    expect(ack).toBeDefined();
    if (ack && ack.t === "steer-ack") {
      expect(ack.status).toBe("queued");
      expect(ack.message).toMatch(/queued/i);
    }
    expect(onMessage).not.toHaveBeenCalled();

    conn.destroy(); adapter.stop();
  });

  it("steer client frame on pipeline mode returns rejected steer-ack", async () => {
    mock = makeMockSpin();
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "resume" });
    expect(frames.find((f) => f.t === "ready")).toBeDefined();

    conn.write(encodeFrame({ t: "steer", sessionId: "", instructionId: "cid2", text: "focus" }));
    await new Promise((r) => setTimeout(r, 50));

    const ack = frames.find((f) => f.t === "steer-ack");
    expect(ack).toBeDefined();
    if (ack && ack.t === "steer-ack") {
      expect(ack.status).toBe("rejected");
    }

    conn.destroy(); adapter.stop();
  });

  it("/steer prefix in plain input on busy Orc queues the instruction", async () => {
    const orc = { id: "1749563282_O_01", isReady: true } as unknown as AgentSession;
    mock = makeMockSpin({ orcSession: orc, orcBusy: true });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "orc" });
    expect(frames.find((f) => f.t === "ready")).toBeDefined();

    conn.write(encodeFrame({ t: "input", text: "/steer focus on memory" }));
    await new Promise((r) => setTimeout(r, 50));

    const ack = frames.find((f) => f.t === "steer-ack");
    expect(ack).toBeDefined();
    if (ack && ack.t === "steer-ack") {
      expect(ack.status).toBe("queued");
    }
    expect(mock.calls.spin).toEqual([]);
    expect(onMessage).not.toHaveBeenCalled();

    conn.destroy(); adapter.stop();
  });

  it("plain text on idle Orc still routes through spin (no steer)", async () => {
    const orc = { id: "1749563282_O_01", isReady: true } as unknown as AgentSession;
    mock = makeMockSpin({
      orcSession: orc, orcBusy: false,
      spinResult: { sessionId: "1749563282_O_01", cardId: 1, result: "ok" },
    });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "orc" });
    expect(frames.find((f) => f.t === "ready")).toBeDefined();

    conn.write(encodeFrame({ t: "input", text: "hello?" }));
    await new Promise((r) => setTimeout(r, 100));

    expect(mock.calls.spin.length).toBe(1);
    expect(onMessage).not.toHaveBeenCalled();

    conn.destroy(); adapter.stop();
  });

  it("steer on non-busy Orc returns rejected steer-ack", async () => {
    const orc = { id: "1749563282_O_01", isReady: true } as unknown as AgentSession;
    mock = makeMockSpin({ orcSession: orc, orcBusy: false });
    const adapter = new TuiSocketAdapter({ spin: mock.spin, onMessage, socketPath: sockPath });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "orc" });

    conn.write(encodeFrame({ t: "steer", sessionId: "1749563282_O_01", instructionId: "cid3", text: "focus" }));
    await new Promise((r) => setTimeout(r, 50));

    const ack = frames.find((f) => f.t === "steer-ack");
    expect(ack).toBeDefined();
    if (ack && ack.t === "steer-ack") {
      expect(ack.status).toBe("rejected");
      expect(ack.message).toMatch(/steering/i);
    }

    conn.destroy(); adapter.stop();
  });
});

// ── #1339 semantic activity overflow recovery ───────────────────────────

describe("TuiSocketAdapter — #1339 activity overflow recovery", () => {
  let sockPath: string;
  let adapter: TuiSocketAdapter;

  beforeEach(() => { sockPath = tmpSocketPath(); });
  afterEach(() => { if (adapter) adapter.stop(); });

  it("recovers with a fresh snapshot before subsequent incremental activity", async () => {
    const feed = new OrcActivityFeed();
    const orc = { id: "1749563282_O_01", isReady: true } as unknown as AgentSession;
    const mockSpin = makeMockSpin({ orcSession: orc, orcBusy: true }).spin;

    adapter = new TuiSocketAdapter({
      spin: mockSpin,
      onMessage: makeRecoveryHandler(),
      socketPath: sockPath,
      orcActivityFeed: feed,
    });
    await adapter.start();

    const { conn, frames } = await attachAndCollect(sockPath, { kind: "orc" });
    await new Promise((r) => setTimeout(r, 40));

    // Flood the feed past its pending cap (MAX_PENDING = 64) to force overflow.
    for (let i = 0; i < 80; i++) {
      feed.publish({
        kind: "card.running",
        title: `task ${i}`,
        status: "running",
        cardId: i + 1,
        sessionId: "1749563282_O_01",
        executionId: "exec_1",
      } as any);
    }
    await new Promise((r) => setTimeout(r, 60));

    const snapshot = frames.find((f) => f.t === "activity-snapshot");
    expect(snapshot).toBeDefined();

    // Incremental activity published after recovery must still flow.
    feed.publish({
      kind: "card.completed",
      title: "done",
      status: "done",
      cardId: 999,
      sessionId: "1749563282_O_01",
      executionId: "exec_1",
    } as any);
    await new Promise((r) => setTimeout(r, 40));

    const completed = frames.find(
      (f) => f.t === "activity" && (f as any).event?.kind === "card.completed",
    );
    expect(completed).toBeDefined();

    // The flooded increments were suppressed (only the post-recovery activity
    // and the recovery snapshot are present), proving the snapshot came first.
    const floodedCount = frames.filter(
      (f) => f.t === "activity" && (f as any).event?.kind === "card.running",
    ).length;
    expect(floodedCount).toBe(0);

    void conn;
  });

  it("new-attach-wins replaces the writer without leaking frames to the old socket", async () => {
    const mockSpin = makeMockSpin().spin;
    adapter = new TuiSocketAdapter({
      spin: mockSpin,
      onMessage: makeRecoveryHandler(),
      socketPath: sockPath,
    });
    await adapter.start();

    const first = await attachAndCollect(sockPath, { kind: "resume" });
    // Second attach evicts the first (new-attach-wins). The first client must
    // receive only the detach error, never frames meant for the new attach.
    const second = await attachAndCollect(sockPath, { kind: "resume" });
    await new Promise((r) => setTimeout(r, 40));

    const firstHasReady = first.frames.some((f) => f.t === "ready");
    const firstHasError = first.frames.some((f) => f.t === "error");
    // The evicted client got a ready (briefly) then a detach error; it must
    // not receive the second connection's ready frame.
    const secondReadySeenByFirst = first.frames.filter((f) => f.t === "ready").length;
    expect(firstHasReady || firstHasError).toBe(true);
    expect(secondReadySeenByFirst).toBeLessThanOrEqual(1);
    expect(second.frames.some((f) => f.t === "ready")).toBe(true);

    first.conn.destroy();
    second.conn.destroy();
  });
});

// ── #1338 live attached-session output mirroring ───────────────────────

describe("TuiSocketAdapter — #1338 output mirroring", () => {
  let sockPath: string;
  let adapter: TuiSocketAdapter;

  beforeEach(() => { sockPath = tmpSocketPath(); });
  afterEach(() => { if (adapter) adapter.stop(); });

  it("mirrors model text + tool starts and terminates with chunk-end", async () => {
    const feed = new SessionOutputFeed();
    const mockSpin = makeMockSpin();
    adapter = new TuiSocketAdapter({
      spin: mockSpin.spin, onMessage: makeRecoveryHandler(), socketPath: sockPath, sessionOutputFeed: feed,
    });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "resume" });
    const sid = (frames.find((f) => f.t === "ready") as any).sessionId;

    feed.publish({ type: "start", sessionId: sid, executionId: "e1", streamId: "st1" });
    feed.publish({ type: "delta", sessionId: sid, executionId: "e1", streamId: "st1", text: "Hello " });
    feed.publish({ type: "delta", sessionId: sid, executionId: "e1", streamId: "st1", text: "world" });
    feed.publish({ type: "tool-start", sessionId: sid, executionId: "e1", streamId: "st1", name: "search" });
    feed.publish({ type: "end", sessionId: sid, executionId: "e1", streamId: "st1", reason: "complete" });
    await new Promise((r) => setTimeout(r, 40));

    const chunks = frames.filter((f) => f.t === "chunk");
    expect(chunks.length).toBe(2);
    expect((chunks[0] as any).delta).toBe("Hello ");
    expect((chunks[1] as any).delta).toBe("world");
    const tools = frames.filter((f) => f.t === "tool-start");
    expect(tools.length).toBe(1);
    expect((tools[0] as any).name).toBe("search");
    const ends = frames.filter((f) => f.t === "chunk-end");
    expect(ends.length).toBe(1);
    expect((ends[0] as any).reason).toBe("complete");

    conn.destroy();
  });

  it("only delivers output for the attached session (no cross-delivery)", async () => {
    const feed = new SessionOutputFeed();
    const mockSpin = makeMockSpin();
    adapter = new TuiSocketAdapter({
      spin: mockSpin.spin, onMessage: makeRecoveryHandler(), socketPath: sockPath, sessionOutputFeed: feed,
    });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "resume" });
    const sid = (frames.find((f) => f.t === "ready") as any).sessionId;

    feed.publish({ type: "delta", sessionId: sid, executionId: "e1", streamId: "st1", text: "mine" });
    feed.publish({ type: "delta", sessionId: "other_session", executionId: "e2", streamId: "st2", text: "theirs" });
    await new Promise((r) => setTimeout(r, 40));

    const chunks = frames.filter((f) => f.t === "chunk");
    expect(chunks.length).toBe(1);
    expect((chunks[0] as any).delta).toBe("mine");

    conn.destroy();
  });

  it("suppresses the duplicate whole-result when streaming was observed", async () => {
    const feed = new SessionOutputFeed();
    const mockSpin = makeMockSpin();
    adapter = new TuiSocketAdapter({
      spin: mockSpin.spin, onMessage: makeRecoveryHandler(), socketPath: sockPath, sessionOutputFeed: feed,
    });
    await adapter.start();
    const { conn, frames } = await attachAndCollect(sockPath, { kind: "resume" });
    const sid = (frames.find((f) => f.t === "ready") as any).sessionId;

    feed.publish({ type: "delta", sessionId: sid, executionId: "e1", streamId: "st1", text: "streamed" });
    feed.publish({ type: "end", sessionId: sid, executionId: "e1", streamId: "st1", reason: "complete" });
    await new Promise((r) => setTimeout(r, 30));

    // The pipeline's whole-result delivery should be suppressed (already streamed).
    await adapter.sendMessage("tui:local", "streamed");
    await new Promise((r) => setTimeout(r, 30));
    expect(frames.filter((f) => f.t === "message").length).toBe(0);

    // Without streaming, the whole result is delivered.
    const adapter2 = new TuiSocketAdapter({
      spin: mockSpin.spin, onMessage: makeRecoveryHandler(), socketPath: sockPath,
    });
    await adapter2.start();
    const { frames: frames2 } = await attachAndCollect(sockPath, { kind: "resume" });
    await adapter2.sendMessage("tui:local", "no-stream-result");
    await new Promise((r) => setTimeout(r, 30));
    expect(frames2.filter((f) => f.t === "message" && (f as any).markdown === "no-stream-result").length).toBe(1);
    adapter2.stop();

    conn.destroy();
  });

  it("switches output mirroring atomically on attach change", async () => {
    const feed = new SessionOutputFeed();
    const orc = { id: "1749563282_O_01", isReady: true } as unknown as AgentSession;
    const mockSpin = makeMockSpin({ orcSession: orc });
    adapter = new TuiSocketAdapter({
      spin: mockSpin.spin, onMessage: makeRecoveryHandler(), socketPath: sockPath, sessionOutputFeed: feed,
    });
    await adapter.start();
    const first = await attachAndCollect(sockPath, { kind: "resume" });
    const aSid = (first.frames.find((f) => f.t === "ready") as any).sessionId;

    // Switch attachment to Orc.
    const second = await attachAndCollect(sockPath, { kind: "orc" });
    const oSid = (second.frames.find((f) => f.t === "ready") as any).sessionId;
    expect(oSid).toBe("1749563282_O_01");

    // Output for the now-detached A session must not reach the client.
    feed.publish({ type: "delta", sessionId: aSid, executionId: "eA", streamId: "stA", text: "old" });
    feed.publish({ type: "delta", sessionId: oSid, executionId: "eO", streamId: "stO", text: "new" });
    await new Promise((r) => setTimeout(r, 40));

    const chunks = [...first.frames, ...second.frames].filter((f) => f.t === "chunk");
    expect(chunks.some((c) => (c as any).delta === "old")).toBe(false);
    expect(chunks.some((c) => (c as any).delta === "new")).toBe(true);

    first.conn.destroy();
    second.conn.destroy();
  });
});

// ── #1398: feed isolation — new-attach-wins must drop old subscriptions ──

describe("TuiSocketAdapter — #1398 feed isolation", () => {
  let sockPath: string;
  let adapter: TuiSocketAdapter;

  beforeEach(() => { sockPath = tmpSocketPath(); });
  afterEach(() => { if (adapter) adapter.stop(); });

  it("replacement drops old output subscribers before new writer is installed", async () => {
    const feed = new SessionOutputFeed();
    const mockSpin = makeMockSpin().spin;
    adapter = new TuiSocketAdapter({
      spin: mockSpin, onMessage: makeRecoveryHandler(), socketPath: sockPath, sessionOutputFeed: feed,
    });
    await adapter.start();

    const a = await attachAndCollect(sockPath, { kind: "resume" });
    expect(feed.subscriberCount).toBe(1);

    const b = net.createConnection(sockPath);
    await new Promise<void>((resolve, reject) => {
      b.once("connect", () => resolve()); b.once("error", reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    // After eviction, A's output subscription must be gone.
    expect(feed.subscriberCount).toBe(0);

    b.destroy();
    a.conn.destroy();
  });

  it("old session output does not reach replacement before its own attach", async () => {
    const feed = new SessionOutputFeed();
    const mockSpin = makeMockSpin().spin;
    adapter = new TuiSocketAdapter({
      spin: mockSpin, onMessage: makeRecoveryHandler(), socketPath: sockPath, sessionOutputFeed: feed,
    });
    await adapter.start();

    const a = await attachAndCollect(sockPath, { kind: "resume" });
    const aReady = a.frames.find((f) => f.t === "ready") as any;
    const aSessionId: string = aReady.sessionId;

    // B connects without sending an attach frame.
    const bFrames: TuiServerFrame[] = [];
    const bDec = createFrameDecoder<TuiServerFrame>();
    const b = net.createConnection(sockPath);
    await new Promise<void>((resolve, reject) => {
      b.once("connect", () => resolve()); b.once("error", reject);
    });
    b.on("data", (buf: Buffer) => {
      for (const f of bDec(buf.toString())) bFrames.push(f);
    });
    await new Promise((r) => setTimeout(r, 50));

    // Publish output for A's old session. With the fix it reaches no one.
    feed.publish({ type: "delta", sessionId: aSessionId, executionId: "e1", streamId: "st1", text: "LEAK" });
    await new Promise((r) => setTimeout(r, 30));

    const hasAttachmentFrame = bFrames.some(
      (f) => f.t === "chunk" || f.t === "message" || f.t === "ready" || f.t === "status",
    );
    expect(hasAttachmentFrame).toBe(false);

    b.destroy();
    a.conn.destroy();
  });

  it("rapid replacement does not accumulate subscribers", async () => {
    const feed = new SessionOutputFeed();
    const mockSpin = makeMockSpin().spin;
    adapter = new TuiSocketAdapter({
      spin: mockSpin, onMessage: makeRecoveryHandler(), socketPath: sockPath, sessionOutputFeed: feed,
    });
    await adapter.start();

    // Make an initial attached connection to get a subscription.
    const first = await attachAndCollect(sockPath, { kind: "resume" });
    expect(feed.subscriberCount).toBe(1);

    // Rapidly replace connections without attaching them.
    for (let i = 0; i < 5; i++) {
      const c = net.createConnection(sockPath);
      await new Promise<void>((resolve, reject) => {
        c.once("connect", () => resolve()); c.once("error", reject);
      });
      await new Promise((r) => setTimeout(r, 20));
      c.destroy();
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(feed.subscriberCount).toBe(0);
    first.conn.destroy();
  });

  it("stop leaves zero subscribers", async () => {
    const feed = new SessionOutputFeed();
    const mockSpin = makeMockSpin().spin;
    adapter = new TuiSocketAdapter({
      spin: mockSpin, onMessage: makeRecoveryHandler(), socketPath: sockPath, sessionOutputFeed: feed,
    });
    await adapter.start();

    const a = await attachAndCollect(sockPath, { kind: "resume" });
    expect(feed.subscriberCount).toBe(1);

    adapter.stop();
    expect(feed.subscriberCount).toBe(0);

    a.conn.destroy();
  });

  it("session switch retains exactly one output subscriber", async () => {
    const feed = new SessionOutputFeed();
    const sessions = [
      { id: "1_A_01", userId: "aksika", platform: "telegram", chatId: 100, active: true, status: "ready", shortIndex: 1, lastActiveAt: 1000, delivery: "streaming" },
      { id: "2_A_02", userId: "aksika", platform: "discord", chatId: 200, active: false, status: "ready", shortIndex: 2, lastActiveAt: 2000, delivery: "streaming" },
    ] as ManagedSession[];
    const mockSpin = makeMockSpin({ allSessions: sessions }).spin;
    adapter = new TuiSocketAdapter({
      spin: mockSpin, onMessage: makeRecoveryHandler(), socketPath: sockPath, sessionOutputFeed: feed,
    });
    await adapter.start();

    const c = await attachAndCollect(sockPath, { kind: "session", index: 2 });
    expect(feed.subscriberCount).toBe(1);

    // Switch to session 1 via a second attach frame on the same connection.
    c.conn.write(encodeFrame({ t: "attach", mode: { kind: "session", index: 1 }, cols: 80, rows: 24 }));
    await new Promise((r) => setTimeout(r, 50));

    expect(feed.subscriberCount).toBe(1);

    c.conn.destroy();
  });
});
