/**
 * relay-block.test.ts — #1301: peer-originated requests must not relay through
 * this host to a third peer. The relay tools (peer_session/peer_doorbell/
 * peer_ask_help) refuse when the active Orc card is peer-sourced.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;

beforeEach(() => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `relay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../paths.js")>();
    return { ...actual, abtarsHome: () => TEST_HOME };
  });
});

describe("#1301 isActiveCardPeerSourced", () => {
  it("false when no active card", async () => {
    const orc = await import("./orc-tools.js");
    orc.setActiveOrcCard(null);
    expect(await orc.isActiveCardPeerSourced()).toBe(false);
  });

  it("false when the active card is owner-sourced", async () => {
    const kanban = await import("../tasks/kanban-board.js");
    const orc = await import("./orc-tools.js");
    const id = kanban.kanbanEnqueue("owner task", "user");
    orc.setActiveOrcCard(id);
    expect(await orc.isActiveCardPeerSourced()).toBe(false);
    orc.setActiveOrcCard(null);
  });

  it("true when the active card is peer-sourced", async () => {
    const kanban = await import("../tasks/kanban-board.js");
    const orc = await import("./orc-tools.js");
    const id = kanban.kanbanEnqueue("peer task", "peer", undefined, { sourcePeer: "molty" });
    orc.setActiveOrcCard(id);
    expect(await orc.isActiveCardPeerSourced()).toBe(true);
    orc.setActiveOrcCard(null);
  });
});

describe("#1301 relay tools refuse on peer-sourced card", () => {
  it("peer_session refuses", async () => {
    const kanban = await import("../tasks/kanban-board.js");
    const orc = await import("./orc-tools.js");
    const { executeToolCall } = await import("./tool-registry.js");
    orc.setActiveOrcCard(kanban.kanbanEnqueue("peer task", "peer"));
    const out = JSON.parse(await executeToolCall("peer_session", { peer_name: "xxx", message: "hi" }, { userId: "peer" }));
    expect(out.reason).toBe("peer_relay_blocked");
    orc.setActiveOrcCard(null);
  });

  it("peer_ask_help refuses", async () => {
    const kanban = await import("../tasks/kanban-board.js");
    const orc = await import("./orc-tools.js");
    const { executeToolCall } = await import("./tool-registry.js");
    orc.setActiveOrcCard(kanban.kanbanEnqueue("peer task", "peer"));
    const out = JSON.parse(await executeToolCall("peer_ask_help", { goal: "do x", peer: "xxx" }, { userId: "peer" }));
    expect(out.reason).toBe("peer_relay_blocked");
    orc.setActiveOrcCard(null);
  });

  it("peer_doorbell refuses", async () => {
    const kanban = await import("../tasks/kanban-board.js");
    const orc = await import("./orc-tools.js");
    const { executeToolCall } = await import("./tool-registry.js");
    orc.setActiveOrcCard(kanban.kanbanEnqueue("peer task", "peer"));
    const out = JSON.parse(await executeToolCall("peer_doorbell", { peer_name: "xxx" }, { userId: "peer" }));
    expect(out.reason).toBe("peer_relay_blocked");
    orc.setActiveOrcCard(null);
  });
});
