/**
 * orc-tools.test.ts — #1792: the supervised Orc choreography tools
 * (spawn_worker, check_workers, cancel_worker, review_worker_failure,
 * define_project_contract, get_project_review_case, review_project,
 * yield_turn) are deleted. This file covers only the retained exports:
 * the empty `getOrcTools()` surface, the harmless `setOrcToolsDeps`
 * wiring, and the live `isActiveCardPeerSourced` relay guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;

beforeEach(() => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `orc-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../paths.js")>();
    return { ...actual, abtarsHome: () => TEST_HOME };
  });
});

const DELETED_TOOLS = [
  "spawn_worker",
  "check_workers",
  "cancel_worker",
  "review_worker_failure",
  "define_project_contract",
  "get_project_review_case",
  "review_project",
  "yield_turn",
];

describe("#1792 deleted supervised tool surface", () => {
  it("getOrcTools() returns an empty array", async () => {
    const { getOrcTools } = await import("./orc-tools.js");
    expect(getOrcTools()).toEqual([]);
  });

  it("none of the deleted supervised tools is presented", async () => {
    const { getOrcTools } = await import("./orc-tools.js");
    const names = getOrcTools().map(t => t.name);
    for (const deleted of DELETED_TOOLS) {
      expect(names, deleted).not.toContain(deleted);
    }
  });

  it("setOrcToolsDeps wiring is harmless and keeps the surface empty", async () => {
    const { getOrcTools, setOrcToolsDeps } = await import("./orc-tools.js");
    expect(() => setOrcToolsDeps({} as never)).not.toThrow();
    expect(getOrcTools()).toEqual([]);
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

describe("isActiveCardPeerSourced (retained relay guard)", () => {
  it("is false without any context", async () => {
    const orc = await import("./orc-tools.js");
    expect(await orc.isActiveCardPeerSourced()).toBe(false);
    expect(await orc.isActiveCardPeerSourced({} as never)).toBe(false);
  });

  it("is true for a stale or foreign peer-originated context", async () => {
    const orc = await import("./orc-tools.js");
    expect(await orc.isActiveCardPeerSourced({ orcContext: peerContext })).toBe(true);
  });
});
