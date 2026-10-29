/**
 * peer-chat-journey.integration.test.ts — #1786 two-peer lane journey.
 *
 * Real WS broker pairs in BOTH directions (accepted-only routing each way),
 * real chat receiver composition (parse + AgentApiAdapter P turn) with a
 * deterministic Spin boundary, and real work stores proving zero work rows
 * for chat. Delegation half proves explicit help still creates supervised
 * work carrying the original goal (terminal delivery is covered by
 * peer-roundtrip.integration.test.ts).
 */
import WebSocket, { WebSocketServer } from "ws";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveVerifyKey } from "../../components/peer-config.js";

const spinCalls: Array<{ spec: any }> = [];
vi.mock("../../components/spin.js", () => ({
  spin: {
    spin: vi.fn(async (spec: any) => {
      spinCalls.push({ spec });
      const prompt = String(spec.prompt ?? "");
      const lastUser = prompt.split("\n").reverse().find(l => l.startsWith("Peer: ")) ?? "";
      return { result: `echo:${lastUser.slice(0, 120)}`, outcome: "text" };
    }),
  },
}));
vi.mock("../../components/reconciler.js", () => ({
  requestReconcile: vi.fn(),
  requestReconcileForProject: vi.fn(),
}));

const keyState = {
  selfName: "sidea",
  keys: {} as Record<string, { signingKey: string; verifyKey: string }>,
};

vi.doMock("../../components/peer-config.js", () => ({
  loadPeerConfig: () => ({
    self: { name: keyState.selfName, signingKey: keyState.keys[keyState.selfName]!.signingKey },
    peers: {
      sidea: { verifyKey: keyState.keys["sidea"]!.verifyKey, trust: 2 },
      sideb: { verifyKey: keyState.keys["sideb"]!.verifyKey, trust: 2 },
    },
    timeoutMs: 10_000,
  }),
}));

type Db = import("better-sqlite3").Database;

async function getDbCtor(): Promise<any> {
  const mod = await import("../../utils/lazy-require.js");
  return mod.resolveNativeDep("better-sqlite3");
}

async function connectedPair(): Promise<{ server: WebSocketServer; client: WebSocket; serverConn: WebSocket }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(r => server.on("listening", r));
  const address = server.address() as import("net").AddressInfo;
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const serverConn = await new Promise<WebSocket>((resolve, reject) => {
    server.on("connection", (conn) => resolve(conn as unknown as WebSocket));
    client.on("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    if (client.readyState === WebSocket.OPEN) { resolve(); return; }
    client.on("open", resolve);
    client.on("error", reject);
  });
  return { server, client, serverConn };
}

describe("Peer chat journey over real WS routes (#1786)", () => {
  let servers: WebSocketServer[] = [];
  let sockets: WebSocket[] = [];
  let testHome = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    spinCalls.length = 0;
    testHome = join(tmpdir(), `chat-journey-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testHome, { recursive: true });
    vi.doMock("../../paths.js", async (importOriginal) => {
      const actual = await (importOriginal() as Promise<Record<string, unknown>>);
      return { ...actual, abtarsHome: () => testHome };
    });
    for (const side of ["sidea", "sideb"]) {
      const { privateKey } = generateKeyPairSync("ed25519");
      const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
      keyState.keys[side] = { signingKey, verifyKey: deriveVerifyKey(signingKey) };
    }
    keyState.selfName = "sidea";
  });

  afterEach(() => {
    for (const s of sockets) { try { s.close(); } catch {} }
    for (const s of servers) { try { s.close(); } catch {} }
    servers = [];
    sockets = [];
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
  });

  function track(pair: { server: WebSocketServer; client: WebSocket; serverConn: WebSocket }): void {
    servers.push(pair.server);
    sockets.push(pair.client, pair.serverConn);
  }

  async function twoBrokers() {
    const { PeerWsBroker } = await import("../../components/peer-transport/peer-ws-broker.js");
    return { brokerA: new PeerWsBroker(), brokerB: new PeerWsBroker() };
  }

  async function chatReceiver(broker: any, tag: string) {
    const { parsePeerChatRequest } = await import("../../components/peer-transport/peer-chat.js");
    const { AgentApiAdapter } = await import("../../platforms/agent-api/agent-api-adapter.js");
    const adapter = new AgentApiAdapter();
    broker.registerRequestHandler(async (peer: string, method: string, payload: unknown, _id: string) => {
      if (method !== "peer.chat.v1") throw new Error(`Unknown method: ${method} (${tag})`);
      const parsed = parsePeerChatRequest(payload);
      if (!parsed.ok) throw new Error(`invalid_request: ${parsed.detail}`);
      const text = await adapter.handlePeerChat(peer, parsed.request.session_id, {
        messages: parsed.request.messages,
        deadlineAt: parsed.request.deadline_at,
      });
      return { version: 1, text };
    });
    return adapter;
  }

  it("chat and follow-up both directions with zero work rows", async () => {
    const DbCtor = await getDbCtor();
    const { ensureKanbanBoardSchema } = await import("../../components/tasks/kanban-board.js");
    const dbA = new DbCtor(":memory:");
    const dbB = new DbCtor(":memory:");
    ensureKanbanBoardSchema(dbA);
    ensureKanbanBoardSchema(dbB);

    const { brokerA, brokerB } = await twoBrokers();
    await chatReceiver(brokerA, "A");
    await chatReceiver(brokerB, "B");

    // Pair 1: A dials out, B accepts. Pair 2: B dials out, A accepts.
    const p1 = await connectedPair();
    const p2 = await connectedPair();
    track(p1);
    track(p2);
    brokerA.attachSocket({ peer: "sideb", direction: "outbound", socket: p1.client });
    brokerB.attachSocket({ peer: "sidea", direction: "accepted", socket: p1.serverConn });
    brokerB.attachSocket({ peer: "sidea", direction: "outbound", socket: p2.client });
    brokerA.attachSocket({ peer: "sideb", direction: "accepted", socket: p2.serverConn });

    // A → B over A's outbound route.
    keyState.selfName = "sidea";
    const r1 = await brokerA.sendEphemeralRequest<{ version: number; text: string }>("sideb", "peer.chat.v1", {
      version: 1, session_id: "conv_ab", messages: [{ role: "user", content: "ping from A" }], deadline_at: Date.now() + 10_000,
    });
    expect(r1.text).toContain("ping from A");

    // Follow-up on the same conversation carries history.
    const callsBefore = spinCalls.length;
    const r2 = await brokerA.sendEphemeralRequest<{ version: number; text: string }>("sideb", "peer.chat.v1", {
      version: 1,
      session_id: "conv_ab",
      messages: [
        { role: "user", content: "ping from A" },
        { role: "assistant", content: r1.text },
        { role: "user", content: "second from A" },
      ],
      deadline_at: Date.now() + 10_000,
    });
    expect(r2.text).toContain("second from A");
    expect(spinCalls.length).toBe(callsBefore + 1);
    expect(String(spinCalls[spinCalls.length - 1]!.spec.prompt)).toContain("ping from A");

    // B → A over B's outbound route (accepted-only on A's side).
    keyState.selfName = "sideb";
    const r3 = await brokerB.sendEphemeralRequest<{ version: number; text: string }>("sidea", "peer.chat.v1", {
      version: 1, session_id: "conv_ba", messages: [{ role: "user", content: "ping from B" }], deadline_at: Date.now() + 10_000,
    });
    expect(r3.text).toContain("ping from B");

    // Every chat turn ran a cardless P turn: no goal, deny-all policy.
    expect(spinCalls.length).toBeGreaterThanOrEqual(3);
    for (const c of spinCalls) {
      expect(c.spec.type).toBe("P");
      expect(c.spec.goal).toBeUndefined();
      expect(c.spec.tools).toMatchObject({ allowedTools: [], canExecuteBash: false });
    }

    // Zero work rows on both sides; no durable outbox entries anywhere.
    expect((dbA.prepare("SELECT COUNT(*) as c FROM kanban_board").get() as any).c).toBe(0);
    expect((dbB.prepare("SELECT COUNT(*) as c FROM kanban_board").get() as any).c).toBe(0);
    expect(brokerA._getOutbox("sideb")?.length ?? 0).toBe(0);
    expect(brokerB._getOutbox("sidea")?.length ?? 0).toBe(0);

    dbA.close();
    dbB.close();
  });

  it("explicit delegation still creates supervised work carrying the goal", async () => {
    const DbCtor = await getDbCtor();
    const { ensureKanbanBoardSchema } = await import("../../components/tasks/kanban-board.js");
    const rawDb = new DbCtor(":memory:");
    ensureKanbanBoardSchema(rawDb);
    const taskDb = {
      prepare(sql: string) {
        const stmt = rawDb.prepare(sql);
        return {
          run: (...p: unknown[]) => stmt.run(...p),
          get: (...p: unknown[]) => stmt.get(...p),
          all: (...p: unknown[]) => stmt.all(...p),
        };
      },
      exec: (sql: string) => rawDb.exec(sql),
      transaction: <T,>(fn: () => T): T => rawDb.transaction(fn)(),
    };
    const kanbanFns = {
      kanbanGetCard: (id: number) => rawDb.prepare("SELECT * FROM kanban_board WHERE id = ?").get(id) as any ?? undefined,
      kanbanUpdate: (id: number, updates: Record<string, unknown>) => {
        rawDb.prepare(`UPDATE kanban_board SET ${Object.keys(updates).map(k => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), id);
      },
      kanbanComplete: (id: number, _r: string | null, summary: string) => {
        rawDb.prepare("UPDATE kanban_board SET status='done', result_summary=?, completed_at=datetime('now') WHERE id = ?").run(summary, id);
      },
      kanbanFail: (id: number, error: string) => {
        rawDb.prepare("UPDATE kanban_board SET status='failed', error=?, completed_at=datetime('now') WHERE id = ?").run(error, id);
      },
      kanbanEnqueue: () => undefined as unknown as number,
      kanbanList: (status: string) => rawDb.prepare("SELECT * FROM kanban_board WHERE status = ?").all(status) as any[],
    };
    const nerve = { fired: [] as Array<{ event: string; cardId: number }>, fire(e: string, c: number) { nerve.fired.push({ event: e, cardId: c }); } };
    // #1792: receiver admission runs through the workflow runner on the same
    // database (same composition as production wiring in store.test.ts).
    const { WorkflowRunner } = await import("../../components/orc-project/orc-workflow-runner.js");
    const { WorkflowStore } = await import("../../components/orc-project/orc-workflow-store.js");
    const peerRunner = new WorkflowRunner(new WorkflowStore(taskDb as never));
    const phStoreMod = await import("../../components/peer-help/store.js");
    const store = new phStoreMod.PeerHelpStore(taskDb as never, kanbanFns as never, nerve as never, {
      admitReceiverProject: (cardId: number, sourcePeer: string, sourceId: string) => {
        const admitted = peerRunner.admitSupervised({ rootCardId: cardId, source: "peer", sourcePeer, sourceId });
        if (admitted.kind === "conflict") throw new Error(`receiver admission failed: ${admitted.reason}`);
      },
    });
    const phs = await import("../../components/peer-help/service.js");
    const service = new phs.PeerHelpService(store, () => []);

    const GOAL = "zxq-delegation-goal-1786: summarize test results";
    const resp = await service.handleHelpRequest("sidea", {
      version: 1, request_id: "deleg-1", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      goal: GOAL, priority: "MEDIUM", required_capabilities: [],
    });
    expect(resp.decision).toBe("accepted");
    const cards = rawDb.prepare("SELECT * FROM kanban_board WHERE source = 'peer'").all() as any[];
    expect(cards).toHaveLength(1);
    expect(cards[0].goal).toContain(GOAL);
    expect(cards[0].status).not.toBe("failed");
    rawDb.close();
  });
});
