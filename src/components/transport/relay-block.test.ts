/** #1301/#1480: peer-originated Orc work must not relay through this host. */

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

const peerContext = {
  version: 2 as const,
  runId: "missing",
  intentKey: "operator:1",
  intentKind: "operator_turn" as const,
  projectCardId: 1,
  projectGeneration: 1,
  ownershipGeneration: 1,
  ownerPeer: "local",
  ownerInstanceId: "instance",
  origin: { kind: "peer" as const, peer: "remote" },
};

describe("#1301/#1480 context-bound relay protection", () => {
  it("does not classify ordinary user tool calls as peer-originated Orc work", async () => {
    const orc = await import("./orc-tools.js");
    expect(await orc.isActiveCardPeerSourced()).toBe(false);
  });

  it("fails closed for a stale or foreign peer context", async () => {
    const orc = await import("./orc-tools.js");
    expect(await orc.isActiveCardPeerSourced({ orcContext: peerContext })).toBe(true);
  });

  for (const tool of ["peer_session", "peer_ask_help", "peer_doorbell"] as const) {
    it(`${tool} refuses a stale peer-originated Orc context`, async () => {
      const { executeToolCall } = await import("./tool-registry.js");
      const args = tool === "peer_session"
        ? { peer_name: "xxx", message: "hi" }
        : tool === "peer_ask_help" ? { goal: "do x", peer: "xxx" } : { peer_name: "xxx" };
      const out = JSON.parse(await executeToolCall(tool, args, { userId: "peer", orcContext: peerContext }));
      expect(out.reason).toBe("peer_relay_blocked");
    });
  }
});
