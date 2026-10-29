import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;
let board: typeof import("./tasks/kanban-board.js");
let outbox: typeof import("./peer-callback-outbox.js");

const sendMock = vi.fn();

vi.mock("./peer-transport/index.js", () => ({
  getPeerTransport: () => ({ send: sendMock }),
}));

function pendingCount(db: { prepare(sql: string): { all(...p: unknown[]): unknown[] } }, cardId?: number): number {
  const rows = (cardId === undefined
    ? db.prepare(`SELECT id FROM peer_callback_outbox WHERE sent_at IS NULL`).all()
    : db.prepare(`SELECT id FROM peer_callback_outbox WHERE sent_at IS NULL AND card_id = ?`).all(cardId)) as unknown[];
  return rows.length;
}

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `peer-cb-outbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  sendMock.mockReset().mockResolvedValue(undefined);
  board = await import("./tasks/kanban-board.js");
  outbox = await import("./peer-callback-outbox.js");
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("peer-callback outbox (#1778)", () => {
  it("queues exactly one intent with the winning terminal and delivers it once", async () => {
    const cardId = board.kanbanEnqueue("peer lane", "peer", undefined, { type: "W" });
    board.kanbanRunning(cardId);
    board.kanbanComplete(cardId, null, "worker finished", true,
      { peer: "kp", status: "done", resultSummary: "worker finished", tokensUsed: 7 });
    const db = board.requireTaskDatabase();
    expect(pendingCount(db, cardId)).toBe(1);

    // A duplicate terminal observation (lost CAS / reassertion) queues nothing.
    board.kanbanComplete(cardId, null, "worker finished again", true,
      { peer: "kp", status: "done", resultSummary: "again" });
    expect(pendingCount(db, cardId)).toBe(1);

    expect(await outbox.drainPeerCallbackForCard(cardId)).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith("kp", {
      type: "callback",
      payload: {
        action: "callback",
        task_id: cardId,
        status: "done",
        result_summary: "worker finished",
        tokens_used: 7,
      },
    });
    expect(pendingCount(db, cardId)).toBe(0);

    // Redrive after delivery sends nothing — exactly once.
    expect(await outbox.drainPeerCallbackOutbox()).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed send pending with bounded diagnostics and retries it", async () => {
    const cardId = board.kanbanEnqueue("flaky peer", "peer", undefined, { type: "W" });
    board.kanbanRunning(cardId);
    board.kanbanFail(cardId, "boom", true, { peer: "kp", status: "failed", error: "boom" });

    sendMock.mockRejectedValueOnce(new Error("transport down"));
    expect(await outbox.drainPeerCallbackForCard(cardId)).toBe(0);
    const db = board.requireTaskDatabase();
    const row = db.prepare(`SELECT attempts, last_error, sent_at FROM peer_callback_outbox WHERE card_id = ?`).get(cardId) as {
      attempts: number; last_error: string; sent_at: string | null;
    };
    expect(row.sent_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("transport down");

    sendMock.mockResolvedValue(undefined);
    expect(await outbox.drainPeerCallbackOutbox()).toBe(1);
    expect(pendingCount(db, cardId)).toBe(0);
  });

  it("tracks done and failed verdicts for one card as separate obligations", async () => {
    const cardId = board.kanbanEnqueue("both verdicts", "peer", undefined, { type: "W" });
    board.kanbanRunning(cardId);
    board.kanbanComplete(cardId, null, "done first", true, { peer: "kp", status: "done" });
    // done→failed is a legal transition (stale artifact after acceptance).
    board.kanbanFail(cardId, "stale artifact", true, { peer: "kp", status: "failed", error: "stale artifact" });
    expect(await outbox.drainPeerCallbackOutbox()).toBe(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("caps artifacts and slices artifact content", async () => {
    const cardId = board.kanbanEnqueue("big artifacts", "peer", undefined, { type: "W" });
    board.kanbanRunning(cardId);
    const artifacts = Array.from({ length: 25 }, (_, i) => ({ name: `a${i}`, content: "x".repeat(5000) }));
    board.kanbanComplete(cardId, null, "done", true, { peer: "kp", status: "done", artifacts });
    await outbox.drainPeerCallbackForCard(cardId);
    const payload = sendMock.mock.calls[0]?.[1] as { payload?: { artifacts?: Array<{ name: string; content: string }> } };
    expect(payload?.payload?.artifacts).toHaveLength(20);
    expect(payload?.payload?.artifacts?.[0]?.content).toHaveLength(2000);
  });

  it("a retrying backoff queues no intent — only the terminal verdict delivers", async () => {
    const cardId = board.kanbanEnqueue("retries", "peer", undefined, { type: "W" });
    board.kanbanRunning(cardId);
    expect(board.kanbanRetryOrFail(cardId, "transient")).toBe("retrying");
    const db = board.requireTaskDatabase();
    expect(pendingCount(db, cardId)).toBe(0);
  });
});
