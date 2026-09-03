import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { kanbanEnqueue, requireTaskDatabase } from "../tasks/kanban-board.js";
import { parseContributionEvent } from "../peer-help/contract.js";
import { buildPeerTerminalEvent } from "./peer-terminal-event.js";
import { readPeerTerminalIdentity, type PeerTerminalIdentity } from "../peer-help/store.js";
import { PeerHelpStore } from "../peer-help/store.js";

const TEST_HOME = join(tmpdir(), `ab-peer-terminal-event-${process.pid}-${Date.now()}`);

vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));

const noopKanban = {
  kanbanGetCard: () => undefined,
  kanbanUpdate: () => {},
  kanbanComplete: () => {},
  kanbanFail: () => {},
};

function identity(overrides: Partial<PeerTerminalIdentity> = {}): PeerTerminalIdentity {
  return {
    requesterPeer: "kp",
    requestId: "req_a",
    contributionRef: "ref_a",
    ...overrides,
  };
}

afterEach(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("buildPeerTerminalEvent (#1680 pure builder)", () => {
  it("emits a snapshot-free failed event that passes contribution validation, with the receiver's own peer as receiver_peer", () => {
    const event = buildPeerTerminalEvent({
      cardId: 1,
      decisionId: "rd_block_1",
      kind: "failed",
      summary: "Project blocked: invalid_contract_proposals_exhausted",
      receiverPeer: "molty-receiver",
      identity: identity(),
      failureReason: "Invalid contract proposals exhausted",
    });
    expect(event).toBeDefined();
    expect(event.peer).toBe("kp"); // the requester who will receive the event
    const parsed = parseContributionEvent(event.payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const projection = parsed.value.projection!;
      expect(projection.outcome).toBe("failed");
      expect(projection.summary).toContain("invalid_contract_proposals_exhausted");
      expect(projection.summary).toContain("Invalid contract proposals exhausted");
      expect(projection.evidence).toEqual([]);
      expect(projection.artifacts).toEqual([]);
      // #1680: receiver_peer is the RECEIVER's own logical name, not the requester's.
      expect(projection.provenance.receiver_peer).toBe("molty-receiver");
      expect(projection.provenance.receiver_project_ref).toBe(`project_1`);
      expect(projection.provenance.acceptance_id).toBe("rd_block_1");
    }
    expect(event.payload.request_id).toBe("req_a");
    expect(event.payload.contribution_ref).toBe("ref_a");
  });

  it("emits a snapshot-free completed event too", () => {
    const event = buildPeerTerminalEvent({
      cardId: 2,
      decisionId: "rd_accept_1",
      kind: "completed",
      summary: "Project accepted",
      receiverPeer: "molty-receiver",
      identity: identity(),
    });
    expect(event).toBeDefined();
    const parsed = parseContributionEvent(event.payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.projection!.outcome).toBe("completed");
      expect(parsed.value.projection!.evidence).toEqual([]);
    }
  });

  it("does not read mutable card notes — a card with non-JSON notes still produces a valid event from the durable identity", () => {
    // #1680: the escaped receiver card had notes replaced with non-JSON text.
    // The pure builder never reads notes, so this card's corruption is
    // irrelevant to event derivation.
    mkdirSync(TEST_HOME, { recursive: true });
    kanbanEnqueue("peer project", "peer", undefined, {
      type: "O",
      sourcePeer: "kp",
      notes: "{not-json",
    });
    const event = buildPeerTerminalEvent({
      cardId: 1,
      decisionId: "d1",
      kind: "failed",
      summary: "s",
      receiverPeer: "molty-receiver",
      identity: identity(),
    });
    expect(event).toBeDefined();
  });

  it("replaces a blank summary rather than emitting an empty one", () => {
    const event = buildPeerTerminalEvent({
      cardId: 3,
      decisionId: "d1",
      kind: "failed",
      summary: "   ",
      receiverPeer: "molty-receiver",
      identity: identity(),
    });
    expect(event).toBeDefined();
    const parsed = parseContributionEvent(event.payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.projection!.summary.length).toBeGreaterThan(0);
      if (parsed.value.summary === undefined) throw new Error("summary undefined");
      expect(parsed.value.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("readPeerTerminalIdentity (#1680 durable receiver identity)", () => {
  let raw: import("better-sqlite3").Database;
  let db: ReturnType<typeof requireTaskDatabase>;

  beforeEach(async () => {
    const { resolveNativeDep } = await import("../../utils/lazy-require.js");
    const Database = resolveNativeDep("better-sqlite3");
    raw = new Database(":memory:");
    db = {
      prepare(sql: string) {
        const stmt = raw.prepare(sql);
        return {
          run(...params: unknown[]) { return stmt.run(...params); },
          get(...params: unknown[]) { return stmt.get(...params) as Record<string, unknown> | undefined; },
          all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
        };
      },
      exec(sql: string) { raw.exec(sql); },
      transaction<T>(fn: () => T): T { return raw.transaction(fn)(); },
      transactionImmediate<T>(fn: () => T): T { return raw.transaction(fn)(); },
    };
    const { ensureKanbanBoardSchema } = await import("../tasks/kanban-board.js");
    ensureKanbanBoardSchema(raw);
    new PeerHelpStore(db as never, noopKanban as never, { fire: () => {} } as never);
  });

  afterEach(() => {
    try { raw.close(); } catch { /* already closed */ }
  });

  function seedCard(sourcePeer: string | null): number {
    const result = raw.prepare(
      `INSERT INTO kanban_board (title, source, source_id, status, type, notes, source_peer, created_at, updated_at)
       VALUES (?, 'peer', ?, 'queued', 'O', '{not-json', ?, datetime('now'), datetime('now'))`
    ).run(`card-${sourcePeer ?? "none"}`, `src-${sourcePeer ?? "none"}`, sourcePeer);
    return Number(result.lastInsertRowid);
  }

  function seedAccepted(cardId: number, originPeer: string, requestId: string, contributionRef: string): void {
    raw.prepare(`
      INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, contribution_ref, local_card_id, response_json, created_at, updated_at)
      VALUES (?, ?, ?, 'accepted', ?, ?, '{}', datetime('now'), datetime('now'))
    `).run(originPeer, requestId, `hash_${requestId}`, contributionRef, cardId);
  }

  it("returns the identity for exactly one matching accepted row, independent of corrupt notes", () => {
    const cardId = seedCard("kp");
    seedAccepted(cardId, "kp", "req_a", "ref_a");
    const id = readPeerTerminalIdentity(db, cardId);
    expect(id).toEqual({ requesterPeer: "kp", requestId: "req_a", contributionRef: "ref_a" });
  });

  it("returns undefined when no accepted row exists", () => {
    const cardId = seedCard("kp");
    expect(readPeerTerminalIdentity(db, cardId)).toBeUndefined();
  });

  it("returns undefined for a pending row", () => {
    const cardId = seedCard("kp");
    raw.prepare(`
      INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, contribution_ref, local_card_id, response_json, created_at, updated_at)
      VALUES ('kp', 'req_p', 'h', 'pending', 'ref_p', ?, '{}', datetime('now'), datetime('now'))
    `).run(cardId);
    expect(readPeerTerminalIdentity(db, cardId)).toBeUndefined();
  });

  it("returns undefined when multiple accepted rows share the card", () => {
    const cardId = seedCard("kp");
    seedAccepted(cardId, "kp", "req_a", "ref_a");
    seedAccepted(cardId, "kp", "req_b", "ref_b");
    expect(readPeerTerminalIdentity(db, cardId)).toBeUndefined();
  });

  it("returns undefined when the origin peer does not match the card's source peer", () => {
    const cardId = seedCard("kp");
    seedAccepted(cardId, "molty", "req_a", "ref_a");
    expect(readPeerTerminalIdentity(db, cardId)).toBeUndefined();
  });

  it("returns undefined for a blank contribution reference", () => {
    const cardId = seedCard("kp");
    raw.prepare(`
      INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, contribution_ref, local_card_id, response_json, created_at, updated_at)
      VALUES ('kp', 'req_b', 'h', 'accepted', '', ?, '{}', datetime('now'), datetime('now'))
    `).run(cardId);
    expect(readPeerTerminalIdentity(db, cardId)).toBeUndefined();
  });
});