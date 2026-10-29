/**
 * #1301/#1480/#1850: peer-originated work must not relay through this host.
 *
 * #1850: the relay escaped twice live because supervised W workers never
 * carry an orcContext, so the orcContext-only guard was fail-open in
 * production. These tests drive the guard through the dispatch-resolved
 * workOrigin (the production path) — the synthetic orcContext injection
 * below covers only the legacy O-session path that hid the regression.
 *
 * #1856: relay tools stay offered to peer-origin workers (no schema hiding)
 * so an attempt reaches the execution boundary, which refuses it and records
 * the correlated auditDeny the live gate observes.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;

beforeEach(() => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `relay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(TEST_HOME, "logs"), { recursive: true });
  vi.doMock("../../paths.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../paths.js")>();
    return { ...actual, abtarsHome: () => TEST_HOME };
  });
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
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

const peerOrigin = { rootCardId: 13, rootKind: "peer" as const, sourcePeer: "molty" };
const ownerOrigin = { rootCardId: 7, rootKind: "interactive" as const, sourcePeer: null };
const unknownOrigin = { rootCardId: 9, rootKind: "unknown" as const, sourcePeer: null };

describe("#1850 dispatch-resolved origin", () => {
  it("resolves peer from the root card source", async () => {
    const orc = await import("./orc-tools.js");
    expect(orc.resolveWorkOrigin(13, {
      getCardSource: () => ({ source: "peer", sourcePeer: "molty" }),
      getRunKind: () => null,
    })).toEqual({ rootCardId: 13, rootKind: "peer", sourcePeer: "molty" });
  });

  it("resolves peer from the workflow run kind even when the card source is stale", async () => {
    const orc = await import("./orc-tools.js");
    expect(orc.resolveWorkOrigin(13, {
      getCardSource: () => ({ source: "agent", sourcePeer: null }),
      getRunKind: () => "peer",
    })).toEqual({ rootCardId: 13, rootKind: "peer", sourcePeer: null });
  });

  it("resolves owner roots without denying them", async () => {
    const orc = await import("./orc-tools.js");
    expect(orc.resolveWorkOrigin(7, {
      getCardSource: () => ({ source: "user", sourcePeer: null }),
      getRunKind: () => null,
    })).toEqual({ rootCardId: 7, rootKind: "interactive", sourcePeer: null });
    expect(orc.resolveWorkOrigin(8, {
      getCardSource: () => ({ source: "task", sourcePeer: null }),
      getRunKind: () => "scheduled",
    })).toEqual({ rootCardId: 8, rootKind: "scheduled", sourcePeer: null });
  });

  it("resolves unknown when the root card is unreadable", async () => {
    const orc = await import("./orc-tools.js");
    expect(orc.resolveWorkOrigin(9, {
      getCardSource: () => undefined,
      getRunKind: () => null,
    })).toEqual({ rootCardId: 9, rootKind: "unknown", sourcePeer: null });
  });
});

describe("#1850 guard over durable origin", () => {
  it("does not classify ordinary user tool calls as peer-originated Orc work", async () => {
    const orc = await import("./orc-tools.js");
    expect(await orc.isActiveCardPeerSourced()).toBe(false);
  });

  it("denies peer and unresolvable origins, allows owner origins", async () => {
    const orc = await import("./orc-tools.js");
    expect(await orc.isActiveCardPeerSourced({ userId: "agent", workOrigin: peerOrigin })).toBe(true);
    expect(await orc.isActiveCardPeerSourced({ userId: "agent", workOrigin: unknownOrigin })).toBe(true);
    expect(await orc.isActiveCardPeerSourced({ userId: "agent", workOrigin: ownerOrigin })).toBe(false);
  });

  it("keeps the legacy O-session orcContext path working", async () => {
    const orc = await import("./orc-tools.js");
    expect(await orc.isActiveCardPeerSourced({ userId: "peer", orcContext: peerContext })).toBe(true);
  });

  for (const tool of ["peer_session", "peer_ask_help", "peer_doorbell"] as const) {
    it(`${tool} refuses a peer-origin worker without creating anything`, async () => {
      const { executeToolCall } = await import("./tool-registry.js");
      const args = tool === "peer_session"
        ? { peer_name: "xxx", message: "hi" }
        : tool === "peer_ask_help" ? { goal: "do x", peer: "xxx" } : { peer_name: "xxx" };
      const out = JSON.parse(await executeToolCall(tool, args, { userId: "agent", workOrigin: peerOrigin }));
      expect(out.reason).toBe("peer_relay_blocked");
    });

    it(`${tool} refuses an unresolvable origin (fail closed)`, async () => {
      const { executeToolCall } = await import("./tool-registry.js");
      const args = tool === "peer_session"
        ? { peer_name: "xxx", message: "hi" }
        : tool === "peer_ask_help" ? { goal: "do x", peer: "xxx" } : { peer_name: "xxx" };
      const out = JSON.parse(await executeToolCall(tool, args, { userId: "agent", workOrigin: unknownOrigin }));
      expect(out.reason).toBe("peer_relay_blocked");
    });

    it(`${tool} stays offered to every origin — refusal happens at execution (#1856)`, async () => {
      const { checkToolAvailability } = await import("./tool-registry.js");
      expect(checkToolAvailability(tool, { workOrigin: ownerOrigin }).allowed).toBe(true);
      expect(checkToolAvailability(tool, { workOrigin: peerOrigin }).allowed).toBe(true);
      expect(checkToolAvailability(tool, { workOrigin: unknownOrigin }).allowed).toBe(true);
    });
  }

  it("records denials with the root card id for run correlation", async () => {
    const { executeToolCall } = await import("./tool-registry.js");
    const out = JSON.parse(await executeToolCall(
      "peer_ask_help",
      { goal: "do x", peer: "xxx" },
      { userId: "agent", workOrigin: peerOrigin },
    ));
    expect(out.reason).toBe("peer_relay_blocked");
    const audit = readFileSync(join(TEST_HOME, "logs", "audit.jsonl"), "utf-8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const denial = audit.find((e) => e.event === "sandbox_deny" && e.tool === "peer_ask_help");
    expect(denial).toBeDefined();
    expect(denial.rootCardId).toBe(13);
  });

  it("links worker-originated contributions through the descriptor", async () => {
    const { getActiveOrcProjectId } = await import("./peer-help-tools.js");
    expect(await getActiveOrcProjectId({ orcContext: { projectCardId: 1 } })).toBe(1);
    expect(await getActiveOrcProjectId({ workOrigin: peerOrigin })).toBe(13);
    expect(await getActiveOrcProjectId(undefined)).toBeNull();
  });
});
