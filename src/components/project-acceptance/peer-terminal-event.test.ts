import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { kanbanEnqueue } from "../tasks/kanban-board.js";
import { parseContributionEvent } from "../peer-help/contract.js";
import { buildPeerTerminalEvent } from "./peer-terminal-event.js";

const TEST_HOME = join(tmpdir(), `ab-peer-terminal-event-${process.pid}-${Date.now()}`);

vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));

vi.mock("../peer-config.js", () => ({
  loadPeerConfig: () => ({ self: { name: "molty-receiver" }, peers: {} }),
}));

afterEach(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
});

function seedPeerCard(notes: Record<string, unknown> | undefined, sourcePeer: string | undefined): number {
  mkdirSync(TEST_HOME, { recursive: true });
  return kanbanEnqueue("peer project", "peer", undefined, {
    type: "O",
    sourcePeer,
    notes: notes ? JSON.stringify(notes) : undefined,
  });
}

describe("buildPeerTerminalEvent (#1630)", () => {
  it("emits a snapshot-free failed event that passes contribution validation, with the local peer as receiver_peer", () => {
    const cardId = seedPeerCard({ request_id: "req_a", contribution_ref: "ref_a" }, "kp");
    const event = buildPeerTerminalEvent({
      cardId,
      decisionId: "rd_block_1",
      kind: "failed",
      summary: "Project blocked: invalid_contract_proposals_exhausted",
      failureReason: "Invalid contract proposals exhausted",
    });
    expect(event).toBeDefined();
    expect(event!.peer).toBe("kp");
    const parsed = parseContributionEvent(event!.payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const projection = parsed.value.projection!;
      expect(projection.outcome).toBe("failed");
      expect(projection.summary).toContain("invalid_contract_proposals_exhausted");
      expect(projection.summary).toContain("Invalid contract proposals exhausted");
      expect(projection.evidence).toEqual([]);
      expect(projection.artifacts).toEqual([]);
      // #1618: receiver_peer is the RECEIVER's own logical name, not the requester's.
      expect(projection.provenance.receiver_peer).toBe("molty-receiver");
      expect(projection.provenance.receiver_project_ref).toBe(`project_${cardId}`);
      expect(projection.provenance.acceptance_id).toBe("rd_block_1");
    }
  });

  it("emits a snapshot-free completed event too", () => {
    const cardId = seedPeerCard({ request_id: "req_b", contribution_ref: "ref_b" }, "kp");
    const event = buildPeerTerminalEvent({ cardId, decisionId: "rd_accept_1", kind: "completed", summary: "Project accepted" });
    expect(event).toBeDefined();
    const parsed = parseContributionEvent(event!.payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.projection!.outcome).toBe("completed");
      expect(parsed.value.projection!.evidence).toEqual([]);
    }
  });

  it("returns undefined for a card with no source_peer", () => {
    const cardId = seedPeerCard({ request_id: "req_c", contribution_ref: "ref_c" }, undefined);
    const event = buildPeerTerminalEvent({ cardId, decisionId: "d1", kind: "failed", summary: "s" });
    expect(event).toBeUndefined();
  });

  it("returns undefined for notes missing contribution_ref", () => {
    const cardId = seedPeerCard({ request_id: "req_d" }, "kp");
    const event = buildPeerTerminalEvent({ cardId, decisionId: "d1", kind: "failed", summary: "s" });
    expect(event).toBeUndefined();
  });

  it("returns undefined for malformed notes JSON", () => {
    const cardId = kanbanEnqueue("peer project", "peer", undefined, {
      type: "O",
      sourcePeer: "kp",
      notes: "{not-json",
    });
    const event = buildPeerTerminalEvent({ cardId, decisionId: "d1", kind: "failed", summary: "s" });
    expect(event).toBeUndefined();
  });

  it("replaces a blank summary rather than emitting an empty one", () => {
    const cardId = seedPeerCard({ request_id: "req_e", contribution_ref: "ref_e" }, "kp");
    const event = buildPeerTerminalEvent({ cardId, decisionId: "d1", kind: "failed", summary: "   " });
    expect(event).toBeDefined();
    const parsed = parseContributionEvent(event!.payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.projection!.summary.length).toBeGreaterThan(0);
      expect(parsed.value.summary.length).toBeGreaterThan(0);
    }
  });
});
